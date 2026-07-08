import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { generatePromotionPlan as defaultGeneratePromotionPlan, type GeneratePromotionDeps } from '@a2p/agents';
import type { PromotionInput, PromotionPlanOutput } from '@a2p/contracts/agents/promoter';
import type { Genre } from '@a2p/contracts/agents';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import { PROMOTION_POSTS_GENERATE_TASK_NAME } from './promotion-posts-generate.js';

/**
 * `pipeline.book.promotion.generate` タスク (F-051)
 *
 * 本の企画・メタ・直近実績から AI 販促プランを生成し、PromotionPlan に upsert する。
 * 出版後の販促(価格戦略/レビュー/告知文)を提供する。
 */

export const PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME = 'pipeline.book.promotion.generate';

export const PipelineBookPromotionGeneratePayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
});

const ALLOWED_GENRES = new Set<string>(['practical', 'business', 'self_help']);
function normalizeGenre(g: string | null | undefined): Genre | null {
  return g && ALLOWED_GENRES.has(g) ? (g as Genre) : null;
}

export interface PipelineBookPromotionGeneratePrisma {
  job: {
    findUnique: (args: { where: { id: string }; select: { status: true } }) => Promise<{ status: string } | null>;
    updateMany: (args: {
      where: { id: string; status: { in: string[] } };
      data: { status: string; started_at?: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: { status?: string; finished_at?: Date; error?: string | null; result_json?: unknown };
    }) => Promise<unknown>;
  };
  book: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        title: true;
        subtitle: true;
        account: { select: { pen_name: true } };
        theme: {
          select: { genre: true; hook: true; target_reader: true };
        };
        kdpMetadata: {
          select: { description: true; keywords: true; price_jpy: true };
        };
        salesRecords: {
          select: { royalty_jpy: true; review_count: true; avg_stars: true };
          orderBy: { year_month: 'desc' };
          take: 1;
        };
      };
    }) => Promise<{
      id: string;
      title: string;
      subtitle: string | null;
      account: { pen_name: string };
      theme: { genre: string; hook: string; target_reader: string | null } | null;
      kdpMetadata: { description: string; keywords: string[]; price_jpy: number } | null;
      salesRecords: Array<{ royalty_jpy: number; review_count: number; avg_stars: unknown }>;
    } | null>;
  };
  promotionPlan: {
    upsert: (args: {
      where: { book_id: string };
      create: { book_id: string; plan_json: unknown; status: string };
      update: { plan_json: unknown; status: string };
    }) => Promise<{ id: string }>;
  };
}

export type AddJobLike = (identifier: string, payload: unknown, spec?: Record<string, unknown>) => Promise<unknown>;

export interface PipelineBookPromotionGenerateDeps {
  prisma?: PipelineBookPromotionGeneratePrisma;
  logger?: Logger;
  generatePromotionPlan?: (input: PromotionInput, deps?: GeneratePromotionDeps) => Promise<PromotionPlanOutput>;
  now?: () => Date;
}

export async function runPipelineBookPromotionGenerate(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookPromotionGenerateDeps = {},
): Promise<void> {
  const parsed = PipelineBookPromotionGeneratePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.promotion.generate payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId, job_id: jobId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PipelineBookPromotionGeneratePrisma);
  const generate = deps.generatePromotionPlan ?? defaultGeneratePromotionPlan;
  const now = deps.now ?? (() => new Date());

  const existing = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!existing) throw new NotFoundError(`Job not found: ${jobId}`, { details: { jobId, bookId } });
  if (existing.status === 'done') {
    log.info({ task: PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME, jobId, bookId }, 'already done — skip');
    return;
  }
  const cas = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (cas.count === 0) {
    log.info({ task: PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME, jobId, bookId }, 'not queued/failed — skip');
    return;
  }

  try {
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        title: true,
        subtitle: true,
        account: { select: { pen_name: true } },
        theme: { select: { genre: true, hook: true, target_reader: true } },
        kdpMetadata: { select: { description: true, keywords: true, price_jpy: true } },
        salesRecords: {
          select: { royalty_jpy: true, review_count: true, avg_stars: true },
          orderBy: { year_month: 'desc' },
          take: 1,
        },
      },
    });
    if (!book) throw new NotFoundError(`Book not found: ${bookId}`, { details: { bookId, jobId } });

    const meta = book.kdpMetadata;
    const latest = book.salesRecords[0];

    const input: PromotionInput = {
      jobId,
      bookId,
      genre: normalizeGenre(book.theme?.genre),
      book: {
        title: book.title,
        keywords: meta?.keywords ?? [],
        author: book.account.pen_name,
        ...(book.subtitle ? { subtitle: book.subtitle } : {}),
        ...(book.theme?.hook ? { hook: book.theme.hook.slice(0, 800) } : {}),
        ...(book.theme?.target_reader ? { target_reader: book.theme.target_reader.slice(0, 300) } : {}),
        ...(meta?.description ? { description: meta.description.slice(0, 4000) } : {}),
        ...(meta?.price_jpy != null ? { price_jpy: meta.price_jpy } : {}),
      },
    };
    if (latest) {
      input.performance = {
        recent_royalty_jpy: latest.royalty_jpy,
        review_count: latest.review_count,
        ...(latest.avg_stars != null ? { avg_stars: Number(latest.avg_stars) } : {}),
      };
    }

    const plan = await generate(input);

    await prisma.promotionPlan.upsert({
      where: { book_id: bookId },
      create: { book_id: bookId, plan_json: plan, status: 'ready' },
      update: { plan_json: plan, status: 'ready' },
    });

    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'done', finished_at: now(), error: null, result_json: { ok: true } },
    });
    log.info({ task: PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME, jobId, bookId }, 'promotion plan generated');

    // 販促プランから投稿キューを自動生成 (ベストエフォート: 失敗しても plan 生成は成功扱い)。
    try {
      await addJob(PROMOTION_POSTS_GENERATE_TASK_NAME, { book_id: bookId, base_time: now().toISOString() });
    } catch (enqErr) {
      log.warn(
        { task: PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME, bookId, err: enqErr },
        'failed to enqueue promotion.posts.generate',
      );
    }
  } catch (err) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'failed', finished_at: now(), error: serializeError(err) },
      });
    } catch (jobErr) {
      log.warn({ task: PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME, jobId, bookId, err: jobErr }, 'failed to mark job failed');
    }
    throw err;
  }
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export const pipelineBookPromotionGenerateTask: Task = async (payload: unknown, helpers: JobHelpers) => {
  await runPipelineBookPromotionGenerate(payload, helpers.addJob as unknown as AddJobLike);
};
