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
  /**
   * 修正コメントが対象とした Cover の id。採用前の候補に付くことが多いため、
   * これを最優先で再生成対象に解決する（無ければ採用カバーにフォールバック）。
   * 作品全体(候補セット)へのコメントの場合は未指定 → 新規候補を1枚生成する。
   */
  cover_id: z.string().min(1).optional(),
  /**
   * 再生成カバーを即採用するか。既定 true(文字化けバックフィルは即採用+再エクスポート)。
   * **修正コメント経由は false**: 新カバーを status='generated' の候補として残し、
   * 運営者が確認してから手動で採用する(勝手に採用しない)。採用時に export される。
   */
  adopt: z.boolean().optional(),
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
      where: { book_id: string; status?: string; id?: string };
      select: { id: true; cover_text_id: true; width: true; height: true; status: true };
      orderBy?: { created_at: 'desc' };
    }) => Promise<{ id: string; cover_text_id: string | null; width: number; height: number; status: string } | null>;
    update: (args: { where: { id: string }; data: { status: string } }) => Promise<unknown>;
    updateMany: (args: {
      where: { book_id: string; status: string; id: { not: string } };
      data: { status: string };
    }) => Promise<{ count: number }>;
  };
  coverTextProposal: {
    findUnique: (args: {
      where: { id: string };
      select: { title: true; subtitle: true };
    }) => Promise<{ title: string; subtitle: string | null } | null>;
    findFirst: (args: {
      where: { book_id: string; status?: string };
      select: { id: true; title: true; subtitle: true };
      orderBy?: { created_at: 'desc' };
    }) => Promise<{ id: string; title: string; subtitle: string | null } | null>;
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
  const { book_id: bookId, job_id: jobId, feedback, cover_id: commentedCoverId } = parsed.data;
  // 既定 true（バックフィルは即採用）。修正コメント経由は false（候補として残し確認後に採用）。
  const adopt = parsed.data.adopt ?? true;

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

    // 対象カバーを解決: 修正コメントが指した cover_id を最優先し、無ければ採用カバー。
    // (コメントは採用前の候補に付くことが多く、status='adopted' 固定だと no-op になっていた。)
    let target:
      | { id: string; cover_text_id: string | null; width: number; height: number; status: string }
      | null = null;
    if (commentedCoverId) {
      target = await prisma.cover.findFirst({
        where: { id: commentedCoverId, book_id: bookId },
        select: { id: true, cover_text_id: true, width: true, height: true, status: true },
      });
    }
    if (!target) {
      target = await prisma.cover.findFirst({
        where: { book_id: bookId, status: 'adopted' },
        select: { id: true, cover_text_id: true, width: true, height: true, status: true },
      });
    }
    // 作品全体(候補セット)コメント等で対象カバー未指定の場合、寸法/文字の参照用に最新カバーを使う
    // (adopt=false ならこのカバーは reject しない＝新規候補を1枚追加するだけ)。
    if (!target) {
      target = await prisma.cover.findFirst({
        where: { book_id: bookId },
        select: { id: true, cover_text_id: true, width: true, height: true, status: true },
        orderBy: { created_at: 'desc' },
      });
    }
    if (!target) {
      log.info(
        { task: PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME, jobId, bookId, commentedCoverId },
        'no target cover (no cover exists) — nothing to regenerate',
      );
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', finished_at: now(), error: null, result_json: { regenerated: false } },
      });
      return;
    }

    // カバーテキストを解決: 対象カバーの cover_text_id → 書籍の採用 CoverTextProposal → 最新。
    // (採用カバーに cover_text_id が無いケースでも no-op にせず再生成できるようにする。)
    let coverTextId: string | null = target.cover_text_id;
    let proposal: { title: string; subtitle: string | null } | null = null;
    if (coverTextId) {
      proposal = await prisma.coverTextProposal.findUnique({
        where: { id: coverTextId },
        select: { title: true, subtitle: true },
      });
    }
    if (!proposal) {
      const fallback =
        (await prisma.coverTextProposal.findFirst({
          where: { book_id: bookId, status: 'adopted' },
          select: { id: true, title: true, subtitle: true },
          orderBy: { created_at: 'desc' },
        })) ??
        (await prisma.coverTextProposal.findFirst({
          where: { book_id: bookId },
          select: { id: true, title: true, subtitle: true },
          orderBy: { created_at: 'desc' },
        }));
      if (fallback) {
        proposal = { title: fallback.title, subtitle: fallback.subtitle };
        coverTextId = fallback.id;
      }
    }
    if (!proposal || !coverTextId) {
      log.info(
        { task: PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME, jobId, bookId },
        'no cover text proposal for book — nothing to regenerate',
      );
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', finished_at: now(), error: null, result_json: { regenerated: false } },
      });
      return;
    }

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
      coverTextId,
      title: proposal.title,
      styleGuide,
      width: target.width || 1024,
      height: target.height || 1536,
      ...(proposal.subtitle ? { subtitle: proposal.subtitle } : {}),
      ...(author ? { author } : {}),
    });

    let exportJobId: string | null = null;
    if (adopt) {
      // バックフィル: 採用差し替え。対象カバー→rejected、他の採用カバーも rejected、新カバー→adopted。
      // 単一採用カバーの不変条件を保つ。その場で再エクスポートして KDP カバーを差し替える。
      await prisma.cover.update({ where: { id: target.id }, data: { status: 'rejected' } });
      await prisma.cover.updateMany({
        where: { book_id: bookId, status: 'adopted', id: { not: out.coverId } },
        data: { status: 'rejected' },
      });
      await prisma.cover.update({ where: { id: out.coverId }, data: { status: 'adopted' } });

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
      exportJobId = exportJob.id;
    }
    // adopt=false（修正コメント経由）: 新カバーは status='generated' の候補として残す。
    // 対象/採用カバーは触らず、再エクスポートもしない。運営者が確認してから手動で採用する。

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          regenerated: true,
          adopted: adopt,
          target_cover_id: target.id,
          new_cover_id: out.coverId,
          export_job_id: exportJobId,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME,
        jobId,
        bookId,
        targetCoverId: target.id,
        newCoverId: out.coverId,
        adopted: adopt,
      },
      adopt
        ? 'cover regenerated and adopted (backfill) + re-export enqueued'
        : 'cover regenerated as candidate (review before adopt)',
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
