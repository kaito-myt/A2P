import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  generateCoverImage as defaultGenerateCoverImage,
  generateCoverArtDirection as defaultGenerateCoverArtDirection,
  type GenerateCoverImageDeps,
} from '@a2p/agents';
import type { Genre } from '@a2p/contracts/agents';
import type {
  ThumbnailImageInput,
  ThumbnailImageOutput,
  CoverArtDirectionInput,
} from '@a2p/contracts/agents/thumbnail';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import { PIPELINE_BOOK_EXPORT_TASK_NAME } from './pipeline-book-export.js';

/**
 * `pipeline.book.cover.regenerate` タスク — 既存の採用カバーを新方式で作り直すバックフィル。
 *
 * 旧方式 (gpt-image-1 に日本語文字を描かせる) で作られた文字化けカバーを、
 * 新方式 (文字なしイラスト + 実フォント合成) で作り直し、その場で採用差し替え + 再エクスポートする。
 * 書籍は `done` のまま維持する。
 *
 * フロー:
 *   1. CAS で Job を running に。
 *   2. 採用カバー (status='adopted') + その cover_text (title/subtitle) を取得。
 *   3. 著者名 = theme.authorName?.name ?? account.pen_name。
 *   4. アート方向性を生成 (best-effort、失敗時は汎用フォールバック)。
 *   5. generateCoverImage (新方式) で新カバー生成。
 *   6. 旧採用カバー → rejected、新カバー → adopted。
 *   7. pipeline.book.export を enqueue して KDP カバーファイルを作り直す。
 */

export const PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME = 'pipeline.book.cover.regenerate';

export const PipelineBookCoverRegeneratePayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
  /** 修正コメント等のフィードバック。アート方向性の style guide に追記して反映する。 */
  feedback: z.string().max(4000).optional(),
});
export type PipelineBookCoverRegeneratePayload = z.infer<
  typeof PipelineBookCoverRegeneratePayloadSchema
>;

const ALLOWED_GENRES = new Set<string>(['practical', 'business', 'self_help']);
function normalizeGenre(g: string | null | undefined): Genre | null {
  return g && ALLOWED_GENRES.has(g) ? (g as Genre) : null;
}

export interface PipelineBookCoverRegeneratePrisma {
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
      data: { status?: string; finished_at?: Date; error?: string | null; result_json?: unknown };
    }) => Promise<unknown>;
    create: (args: {
      data: { kind: string; book_id: string; status: string; payload_json: unknown };
    }) => Promise<{ id: string }>;
  };
  book: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        account: { select: { pen_name: true } };
        theme: {
          select: {
            genre: true;
            title: true;
            subtitle: true;
            hook: true;
            target_reader: true;
            authorName: { select: { name: true } };
          };
        };
      };
    }) => Promise<{
      id: string;
      account: { pen_name: string };
      theme: {
        genre: string;
        title: string;
        subtitle: string | null;
        hook: string;
        target_reader: string | null;
        authorName: { name: string } | null;
      } | null;
    } | null>;
  };
  cover: {
    findFirst: (args: {
      where: { book_id: string; status: string };
      select: { id: true; cover_text_id: true; width: true; height: true };
    }) => Promise<{ id: string; cover_text_id: string | null; width: number; height: number } | null>;
    update: (args: { where: { id: string }; data: { status: string } }) => Promise<unknown>;
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

export interface PipelineBookCoverRegenerateDeps {
  prisma?: PipelineBookCoverRegeneratePrisma;
  logger?: Logger;
  generateCoverImage?: (
    input: ThumbnailImageInput,
    deps?: GenerateCoverImageDeps,
  ) => Promise<ThumbnailImageOutput>;
  generateCoverArtDirection?: typeof defaultGenerateCoverArtDirection;
  now?: () => Date;
}

export async function runPipelineBookCoverRegenerate(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookCoverRegenerateDeps = {},
): Promise<void> {
  const parsed = PipelineBookCoverRegeneratePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.cover.regenerate payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId, job_id: jobId, feedback } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PipelineBookCoverRegeneratePrisma);
  const generateCoverImageFn = deps.generateCoverImage ?? defaultGenerateCoverImage;
  const generateArtFn = deps.generateCoverArtDirection ?? defaultGenerateCoverArtDirection;
  const now = deps.now ?? (() => new Date());

  const existing = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!existing) throw new NotFoundError(`Job not found: ${jobId}`, { details: { jobId, bookId } });
  if (existing.status === 'done') {
    log.info({ task: PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME, jobId, bookId }, 'already done — skip');
    return;
  }
  const cas = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (cas.count === 0) {
    log.info({ task: PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME, jobId, bookId }, 'not queued/failed — skip');
    return;
  }

  try {
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        account: { select: { pen_name: true } },
        theme: {
          select: {
            genre: true,
            title: true,
            subtitle: true,
            hook: true,
            target_reader: true,
            authorName: { select: { name: true } },
          },
        },
      },
    });
    if (!book) throw new NotFoundError(`Book not found: ${bookId}`, { details: { bookId, jobId } });

    const adopted = await prisma.cover.findFirst({
      where: { book_id: bookId, status: 'adopted' },
      select: { id: true, cover_text_id: true, width: true, height: true },
    });
    if (!adopted || !adopted.cover_text_id) {
      log.info(
        { task: PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME, jobId, bookId },
        'no adopted cover with cover_text — nothing to regenerate',
      );
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', finished_at: now(), error: null, result_json: { regenerated: false } },
      });
      return;
    }

    const proposal = await prisma.coverTextProposal.findUnique({
      where: { id: adopted.cover_text_id },
      select: { title: true, subtitle: true },
    });
    if (!proposal) throw new NotFoundError(`CoverTextProposal not found: ${adopted.cover_text_id}`);

    const author = book.theme?.authorName?.name?.trim() || book.account.pen_name?.trim() || undefined;
    const genre = normalizeGenre(book.theme?.genre);

    // アート方向性 (best-effort)。
    let styleGuide = '';
    if (book.theme) {
      try {
        const artInput: CoverArtDirectionInput = {
          jobId,
          bookId,
          genre,
          themeContext: {
            title: (book.theme.title || proposal.title).slice(0, 200),
            hook: (book.theme.hook || '').slice(0, 800) || '(no hook)',
            target_reader: (book.theme.target_reader || '').slice(0, 300) || '(no target_reader)',
            ...(proposal.subtitle ? { subtitle: proposal.subtitle.slice(0, 200) } : {}),
          },
          count: 3,
        };
        const art = await generateArtFn(artInput);
        styleGuide = art.directions[0]?.image_prompt ?? '';
      } catch (err) {
        log.warn(
          { task: PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME, jobId, bookId, err },
          'art direction generation failed — using generic fallback',
        );
      }
    }

    // 修正コメント等のフィードバックを style guide に反映（アート方向性より優先度の高い明示指示）。
    if (feedback && feedback.trim().length > 0) {
      styleGuide = `${styleGuide}\n\n【修正指示（最優先で反映）】\n${feedback.trim().slice(0, 2000)}`.trim();
    }

    // 新方式で作り直し (文字なしイラスト + 実フォント合成)。
    const out = await generateCoverImageFn({
      jobId,
      bookId,
      coverTextId: adopted.cover_text_id,
      title: proposal.title,
      styleGuide,
      width: adopted.width || 1024,
      height: adopted.height || 1536,
      ...(proposal.subtitle ? { subtitle: proposal.subtitle } : {}),
      ...(author ? { author } : {}),
    });

    // 採用差し替え: 旧 → rejected、新 → adopted。
    await prisma.cover.update({ where: { id: adopted.id }, data: { status: 'rejected' } });
    await prisma.cover.update({ where: { id: out.coverId }, data: { status: 'adopted' } });

    // 再エクスポート (KDP カバーファイルを作り直す)。
    const exportJob = await prisma.job.create({
      data: {
        kind: PIPELINE_BOOK_EXPORT_TASK_NAME,
        book_id: bookId,
        status: 'queued',
        payload_json: { book_id: bookId },
      },
    });
    await addJob(
      PIPELINE_BOOK_EXPORT_TASK_NAME,
      { book_id: bookId, job_id: exportJob.id },
      { maxAttempts: 3 },
    );

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          regenerated: true,
          old_cover_id: adopted.id,
          new_cover_id: out.coverId,
          export_job_id: exportJob.id,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME,
        jobId,
        bookId,
        oldCoverId: adopted.id,
        newCoverId: out.coverId,
      },
      'cover regenerated (new method) and re-export enqueued',
    );
  } catch (err) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'failed', finished_at: now(), error: serializeError(err) },
      });
    } catch (jobErr) {
      log.warn({ task: PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME, jobId, bookId, err: jobErr }, 'failed to mark job failed');
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

export const pipelineBookCoverRegenerateTask: Task = async (payload: unknown, helpers: JobHelpers) => {
  await runPipelineBookCoverRegenerate(payload, helpers.addJob as unknown as AddJobLike);
};
