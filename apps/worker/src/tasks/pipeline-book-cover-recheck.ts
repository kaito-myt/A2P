import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  verifyCoverText as defaultVerifyCoverText,
  generateCoverImage as defaultGenerateCoverImage,
  type VerifyCoverTextDeps,
  type GenerateCoverImageDeps,
} from '@a2p/agents';
import type {
  CoverTextCheckInput,
  CoverTextCheckOutput,
  ThumbnailImageInput,
  ThumbnailImageOutput,
} from '@a2p/contracts/agents/thumbnail';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';
import { downloadBuffer as defaultDownloadBuffer } from '@a2p/storage';

/**
 * `pipeline.book.cover.recheck` タスク (F-007b 裏側機構)
 *
 * 既存のカバー画像 (status='generated'|'adopted') を後追いでビジョン検証し、
 * タイトル/サブタイトルの文字崩れを検出する。崩れていた候補 (generated) は
 * `generateCoverImage` で自動的に作り直し (新候補は生成時にインライン検証済)、
 * 崩れた古い候補は status='rejected' にする。adopted の崩れは自動再生成せず
 * フラグ付け (generation_meta_json.text_check) のみ行い運営者の選び直しに委ねる。
 *
 * インライン検証 (generateCoverImage 内) は「新規生成」だけを守るので、
 * 検証導入前に生成済みのカバーを救済するための後追いスイープがこのタスク。
 */

export const PIPELINE_BOOK_COVER_RECHECK_TASK_NAME = 'pipeline.book.cover.recheck';

export const PipelineBookCoverRecheckPayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
});
export type PipelineBookCoverRecheckPayload = z.infer<
  typeof PipelineBookCoverRecheckPayloadSchema
>;

interface CoverRow {
  id: string;
  status: string;
  r2_key: string;
  cover_text_id: string | null;
  width: number;
  height: number;
  generation_meta_json: unknown;
}

export interface PipelineBookCoverRecheckPrisma {
  job: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true };
    }) => Promise<{ status: string } | null>;
    updateMany: (args: {
      where: { id: string; status: { in: string[] } };
      data: { status: string; started_at?: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: {
        status?: string;
        finished_at?: Date;
        error?: string | null;
        result_json?: unknown;
      };
    }) => Promise<unknown>;
  };
  cover: {
    findMany: (args: {
      where: { book_id: string; status: { in: string[] } };
      select: {
        id: true;
        status: true;
        r2_key: true;
        cover_text_id: true;
        width: true;
        height: true;
        generation_meta_json: true;
      };
    }) => Promise<CoverRow[]>;
    update: (args: {
      where: { id: string };
      data: { status?: string; generation_meta_json?: unknown };
    }) => Promise<unknown>;
  };
  coverTextProposal: {
    findUnique: (args: {
      where: { id: string };
      select: { title: true; subtitle: true };
    }) => Promise<{ title: string; subtitle: string | null } | null>;
  };
}

export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineBookCoverRecheckDeps {
  prisma?: PipelineBookCoverRecheckPrisma;
  logger?: Logger;
  verifyCoverText?: (
    input: CoverTextCheckInput,
    deps?: VerifyCoverTextDeps,
  ) => Promise<CoverTextCheckOutput>;
  generateCoverImage?: (
    input: ThumbnailImageInput,
    deps?: GenerateCoverImageDeps,
  ) => Promise<ThumbnailImageOutput>;
  downloadBuffer?: (key: string) => Promise<Buffer | null>;
  now?: () => Date;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export async function runPipelineBookCoverRecheck(
  payload: unknown,
  _addJob: AddJobLike,
  deps: PipelineBookCoverRecheckDeps = {},
): Promise<void> {
  const parsed = PipelineBookCoverRecheckPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.cover.recheck payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId, job_id: jobId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_COVER_RECHECK_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PipelineBookCoverRecheckPrisma);
  const verify = deps.verifyCoverText ?? defaultVerifyCoverText;
  const regenerate = deps.generateCoverImage ?? defaultGenerateCoverImage;
  const download = deps.downloadBuffer ?? defaultDownloadBuffer;
  const now = deps.now ?? (() => new Date());

  const existing = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!existing) {
    throw new NotFoundError(`Job not found: ${jobId}`, { details: { jobId, bookId } });
  }
  if (existing.status === 'done') {
    log.info({ task: PIPELINE_BOOK_COVER_RECHECK_TASK_NAME, jobId, bookId }, 'already done — skip');
    return;
  }

  const cas = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (cas.count === 0) {
    log.info({ task: PIPELINE_BOOK_COVER_RECHECK_TASK_NAME, jobId, bookId }, 'not queued/failed — skip');
    return;
  }

  try {
    const covers = await prisma.cover.findMany({
      where: { book_id: bookId, status: { in: ['generated', 'adopted'] } },
      select: {
        id: true,
        status: true,
        r2_key: true,
        cover_text_id: true,
        width: true,
        height: true,
        generation_meta_json: true,
      },
    });

    let checked = 0;
    let garbled = 0;
    let regenerated = 0;

    for (const cover of covers) {
      if (!cover.cover_text_id) continue;
      const proposal = await prisma.coverTextProposal.findUnique({
        where: { id: cover.cover_text_id },
        select: { title: true, subtitle: true },
      });
      if (!proposal) continue;

      const buf = await download(cover.r2_key);
      if (!buf) {
        log.warn({ task: PIPELINE_BOOK_COVER_RECHECK_TASK_NAME, jobId, bookId, coverId: cover.id }, 'image not found in R2 — skip');
        continue;
      }

      let verdict: CoverTextCheckOutput;
      try {
        verdict = await verify({
          bookId,
          genre: null,
          title: proposal.title,
          imageBase64: buf.toString('base64'),
          mimeType: 'image/jpeg',
          jobId,
          ...(proposal.subtitle ? { subtitle: proposal.subtitle } : {}),
        });
      } catch (err) {
        log.warn(
          { task: PIPELINE_BOOK_COVER_RECHECK_TASK_NAME, jobId, bookId, coverId: cover.id, err },
          'verifyCoverText failed — skip this cover',
        );
        continue;
      }
      checked += 1;
      if (!verdict.ok) garbled += 1;

      // 検証結果を generation_meta_json にマージして記録。
      const meta = asRecord(cover.generation_meta_json);
      await prisma.cover.update({
        where: { id: cover.id },
        data: {
          generation_meta_json: {
            ...meta,
            text_check: verdict,
            text_check_ok: verdict.ok,
            text_checked_at: now().toISOString(),
          },
        },
      });

      // 崩れた「候補」は作り直し、古い候補は却下する (adopted は自動再生成しない)。
      if (!verdict.ok && cover.status === 'generated') {
        try {
          await regenerate({
            jobId,
            bookId,
            coverTextId: cover.cover_text_id,
            title: proposal.title,
            styleGuide: '',
            width: cover.width || 1024,
            height: cover.height || 1536,
            ...(proposal.subtitle ? { subtitle: proposal.subtitle } : {}),
          });
          await prisma.cover.update({
            where: { id: cover.id },
            data: { status: 'rejected' },
          });
          regenerated += 1;
        } catch (err) {
          log.warn(
            { task: PIPELINE_BOOK_COVER_RECHECK_TASK_NAME, jobId, bookId, coverId: cover.id, err },
            'regenerate failed — leaving original cover in place (flagged)',
          );
        }
      }
    }

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: { checked, garbled, regenerated },
      },
    });

    log.info(
      { task: PIPELINE_BOOK_COVER_RECHECK_TASK_NAME, jobId, bookId, checked, garbled, regenerated },
      'cover recheck done',
    );
  } catch (err) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'failed', finished_at: now(), error: serializeError(err) },
      });
    } catch (jobErr) {
      log.warn({ task: PIPELINE_BOOK_COVER_RECHECK_TASK_NAME, jobId, bookId, err: jobErr }, 'failed to mark job failed');
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

export const pipelineBookCoverRecheckTask: Task = async (payload: unknown, helpers: JobHelpers) => {
  await runPipelineBookCoverRecheck(payload, helpers.addJob as unknown as AddJobLike);
};
