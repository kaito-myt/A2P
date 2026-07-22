import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  acquireBookLock as defaultAcquireBookLock,
  releaseBookLock as defaultReleaseBookLock,
} from '@a2p/agents/lib/book-lock';
import { generateCoverText as defaultGenerateCoverText } from '@a2p/agents/thumbnail/text';
import { generateCoverArtDirection as defaultGenerateCoverArtDirection } from '@a2p/agents/art-direction';
import type { Genre } from '@a2p/contracts/agents';
import { GENRE_SLUGS } from '@a2p/contracts/agents';
import type {
  ThumbnailTextInput,
  ThumbnailTextOutput,
  CoverArtDirectionInput,
} from '@a2p/contracts/agents/thumbnail';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import {
  notifyJobChange as defaultNotifyJobChange,
  type JobChangeNotifyPayload,
} from '../lib/notify-job-change.js';
import { ALERT_COST_CHECK_TASK_NAME } from './alert-cost-check.js';
import { PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME } from './pipeline-book-thumbnail-image.js';

/**
 * `pipeline.book.thumbnail.text` タスク (docs/05 ss5.3.6, F-006)
 *
 * Editor 完了後に呼ばれ、Thumbnail Designer (text) で表紙テキスト候補を 3 案生成し、
 * `CoverTextProposal` x3 INSERT + `pipeline.book.thumbnail.image` x3 並列 enqueue する。
 *
 * フロー (editor.ts と同形 + CoverTextProposal INSERT + image enqueue):
 *   1. payload zod parse (book_id / job_id)
 *   2. 内部 `Job` 行を CAS で `running` に更新。既に `done` ならスキップ。
 *   3. BookLock `pipeline:<job_id>` 取得 (TTL 30 分)。
 *   4. Book + ThemeCandidate fetch。
 *   5. `generateCoverText(input)` 呼出 (token_usage は内部で withTokenLogging 経由記録済)。
 *   6. proposals を 3 件に切り詰め、各案を `CoverTextProposal` INSERT (status='proposed')。
 *   7. 各 CoverTextProposal について `pipeline.book.thumbnail.image` を enqueue
 *      (子 Job INSERT + helpers.addJob)。
 *   8. 内部 `Job.status='done'` + result_json。
 *   9. `notifyJobChange({ phase: 'thumbnail_text_done' })` で SSE 配信。
 *  10. finally で BookLock 解放。
 *
 * エラー方針 (editor.ts と同形):
 *   - payload zod 違反 -> ValidationError
 *   - Book / Theme / Job 不在 -> NotFoundError (内部 Job=failed 降格)
 *   - generateCoverText AgentError / ProviderError -> 透過 throw + Job=failed
 *   - BookLock acquire 失敗 (ConflictError) -> 透過 throw + Job=failed
 *   - notifyJobChange 失敗 -> warn のみで継続
 */

export const PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME = 'pipeline.book.thumbnail.text';

/** docs/05 ss5.3.6: `{ book_id, job_id }`. */
export const PipelineBookThumbnailTextPayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
});
export type PipelineBookThumbnailTextPayload = z.infer<
  typeof PipelineBookThumbnailTextPayloadSchema
>;

/** Prisma 部分 I/F -- テストで mock しやすいよう最小サブセット。 */
export interface PipelineBookThumbnailTextPrisma {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  job: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true; book_id: true };
    }) => Promise<{ status: string; book_id: string | null } | null>;
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
    create: (args: {
      data: {
        kind: string;
        book_id: string;
        parent_job_id: string;
        status: string;
        payload_json: unknown;
      };
    }) => Promise<{ id: string }>;
  };
  book: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        account_id: true;
        theme_id: true;
        title: true;
        subtitle: true;
        account: { select: { pen_name: true } };
      };
    }) => Promise<{
      id: string;
      account_id: string;
      theme_id: string | null;
      title: string;
      subtitle: string | null;
      account: { pen_name: string | null } | null;
    } | null>;
  };
  themeCandidate: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        genre: true;
        title: true;
        subtitle: true;
        hook: true;
        target_reader: true;
        authorName: { select: { name: true } };
        labelName: { select: { name: true } };
      };
    }) => Promise<{
      id: string;
      genre: string;
      title: string;
      subtitle: string | null;
      hook: string;
      target_reader: string | null;
      authorName: { name: string } | null;
      labelName: { name: string } | null;
    } | null>;
  };
  coverTextProposal: {
    create: (args: {
      data: {
        book_id: string;
        title: string;
        subtitle: string | null;
        band_copy: string | null;
        status: string;
      };
    }) => Promise<{ id: string }>;
  };
}

/** `helpers.addJob` の最小 I/F. */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineBookThumbnailTextDeps {
  prisma?: PipelineBookThumbnailTextPrisma;
  logger?: Logger;
  generateCoverText?: typeof defaultGenerateCoverText;
  generateCoverArtDirection?: typeof defaultGenerateCoverArtDirection;
  acquireLock?: typeof defaultAcquireBookLock;
  releaseLock?: typeof defaultReleaseBookLock;
  now?: () => Date;
  notifyJobChange?: (
    payload: JobChangeNotifyPayload,
    deps: {
      prisma: { $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> };
      logger?: Logger;
    },
  ) => Promise<{ ok: boolean }>;
}

const ALLOWED_GENRES = new Set<string>(GENRE_SLUGS);
const DEFAULT_PROPOSAL_COUNT = 3;

/**
 * graphile-worker から呼ばれる Task 本体は下の `pipelineBookThumbnailTextTask`.
 * このヘルパは DI を受け取りテストから直接呼べる.
 */
export async function runPipelineBookThumbnailText(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookThumbnailTextDeps = {},
): Promise<void> {
  const parsed = PipelineBookThumbnailTextPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.thumbnail.text payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId, job_id: jobId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PipelineBookThumbnailTextPrisma);
  const generateCoverTextFn = deps.generateCoverText ?? defaultGenerateCoverText;
  const generateCoverArtDirectionFn =
    deps.generateCoverArtDirection ?? defaultGenerateCoverArtDirection;
  const acquireLock = deps.acquireLock ?? defaultAcquireBookLock;
  const releaseLock = deps.releaseLock ?? defaultReleaseBookLock;
  const notifyJobChangeFn = deps.notifyJobChange ?? defaultNotifyJobChange;
  const now = deps.now ?? (() => new Date());

  // 1. 冪等性チェック: 既に done なら skip
  const existing = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true, book_id: true },
  });
  if (!existing) {
    throw new NotFoundError(`Job not found: ${jobId}`, {
      details: { jobId, bookId },
    });
  }
  if (existing.status === 'done') {
    log.info(
      { task: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME, jobId, bookId },
      'job already done — skipping (idempotent)',
    );
    return;
  }

  // 2. CAS で queued/failed -> running
  const casResult = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (casResult.count === 0) {
    log.info(
      {
        task: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
        jobId,
        bookId,
        observedStatus: existing.status,
      },
      'job not in queued/failed state — skipping (probably already running on another worker)',
    );
    return;
  }

  // 3. BookLock 取得 -- 失敗時は Job=failed 降格してから throw
  try {
    await acquireLock({
      bookId,
      holder: `pipeline:${jobId}`,
      ttlMinutes: 30,
    });
  } catch (lockErr) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          finished_at: now(),
          error: serializeError(lockErr),
        },
      });
    } catch (jobUpdateErr) {
      log.warn(
        { task: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed after lock acquire failure',
      );
    }
    throw lockErr;
  }

  try {
    // 4. Book + Theme fetch
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        account_id: true,
        theme_id: true,
        title: true,
        subtitle: true,
        account: { select: { pen_name: true } },
      },
    });
    if (!book) {
      throw new NotFoundError(`Book not found: ${bookId}`, {
        details: { bookId, jobId },
      });
    }
    if (!book.theme_id) {
      throw new NotFoundError(`Book has no theme_id: ${bookId}`, {
        details: { bookId, jobId },
      });
    }

    const theme = await prisma.themeCandidate.findUnique({
      where: { id: book.theme_id },
      select: {
        id: true,
        genre: true,
        title: true,
        subtitle: true,
        hook: true,
        target_reader: true,
        authorName: { select: { name: true } },
        labelName: { select: { name: true } },
      },
    });
    if (!theme) {
      throw new NotFoundError(`ThemeCandidate not found: ${book.theme_id}`, {
        details: { themeId: book.theme_id, bookId, jobId },
      });
    }

    // 5. generateCoverText 呼出
    const genre = normalizeGenre(theme.genre);
    const themeContext: ThumbnailTextInput['themeContext'] = {
      title: (book.title && book.title.length > 0 ? book.title : theme.title).slice(0, 200),
      hook: (theme.hook ?? '').slice(0, 800) || '(no hook)',
      target_reader: (theme.target_reader ?? '').slice(0, 300) || '(no target_reader)',
    };
    const subtitle = book.subtitle ?? theme.subtitle ?? null;
    if (subtitle && subtitle.length > 0) {
      themeContext.subtitle = subtitle.slice(0, 200);
    }

    const coverTextInput: ThumbnailTextInput = {
      jobId,
      bookId,
      accountId: book.account_id,
      genre,
      themeContext,
      count: DEFAULT_PROPOSAL_COUNT,
    };

    const result: ThumbnailTextOutput = await generateCoverTextFn(coverTextInput);

    // 6. proposals を 3 件に切り詰め (generateCoverText は 3-5 案を返し得る)
    const proposals = result.proposals.slice(0, DEFAULT_PROPOSAL_COUNT);

    // 6b. アート方向性 (Marketer 目線の「売れる」ビジュアル) を本ごとに生成。
    //     文字は後で合成するので、ここでは「絵の内容」だけを決める。
    //     失敗しても致命ではない (generateCoverImage 側の汎用フォールバックに委ねる)。
    const artInput: CoverArtDirectionInput = {
      jobId,
      bookId,
      genre,
      themeContext,
      count: proposals.length,
    };
    let artPrompts: string[] = [];
    try {
      const art = await generateCoverArtDirectionFn(artInput);
      artPrompts = art.directions.map((d) => d.image_prompt);
    } catch (artErr) {
      log.warn(
        { task: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME, jobId, bookId, err: artErr },
        'cover_art_direction generation failed — falling back to generic art direction',
      );
      artPrompts = [];
    }

    // 著者名 — 合成タイポグラフィで表紙に焼き込む。
    // テーマにマスタ著者名が割り当てられていればそれを優先、無ければアカウントのペンネーム。
    const penName =
      theme.authorName?.name?.trim() || book.account?.pen_name?.trim() || undefined;

    // CoverTextProposal INSERT + pipeline.book.thumbnail.image enqueue
    const childJobIds: Array<{ cover_text_id: string; child_job_id: string }> = [];
    for (let i = 0; i < proposals.length; i += 1) {
      const proposal = proposals[i]!;
      const artDirection = artPrompts[i] ?? artPrompts[0] ?? '';
      const coverText = await prisma.coverTextProposal.create({
        data: {
          book_id: bookId,
          title: proposal.title,
          subtitle: proposal.subtitle ?? null,
          band_copy: proposal.band_copy ?? null,
          status: 'proposed',
        },
      });

      // 7. 各テキスト案で pipeline.book.thumbnail.image を enqueue
      //    アート方向性 (art_direction) と著者名 (author) を payload で渡す。
      const childPayload: Record<string, unknown> = {
        book_id: bookId,
        cover_text_id: coverText.id,
      };
      if (artDirection) childPayload.art_direction = artDirection;
      if (penName) childPayload.author = penName;
      const childJob = await prisma.job.create({
        data: {
          kind: PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
          book_id: bookId,
          parent_job_id: jobId,
          status: 'queued',
          payload_json: childPayload,
        },
      });
      await addJob(
        PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
        {
          book_id: bookId,
          cover_text_id: coverText.id,
          job_id: childJob.id,
          ...(artDirection ? { art_direction: artDirection } : {}),
          ...(penName ? { author: penName } : {}),
        },
        { maxAttempts: 3 },
      );
      childJobIds.push({
        cover_text_id: coverText.id,
        child_job_id: childJob.id,
      });
    }

    // 8. 内部 Job を done に遷移
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          proposals_count: proposals.length,
          children: childJobIds,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
        jobId,
        bookId,
        proposalsCount: proposals.length,
        childJobIds: childJobIds.map((c) => c.child_job_id),
      },
      'pipeline.book.thumbnail.text done — CoverTextProposal inserted, thumbnail.image enqueued',
    );

    // 8a. per_book コストチェック enqueue (F-034 / T-07-02)
    await addJob(
      ALERT_COST_CHECK_TASK_NAME,
      { scope: 'per_book', book_id: bookId },
    );

    // 9. SSE 進捗配信
    await notifyJobChangeFn(
      {
        jobId,
        status: 'done',
        kind: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
        bookId,
        phase: 'thumbnail_text_done',
      },
      { prisma, logger: log },
    );
  } catch (err) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          finished_at: now(),
          error: serializeError(err),
        },
      });
    } catch (jobUpdateErr) {
      log.warn(
        { task: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed',
      );
    }
    throw err;
  } finally {
    try {
      await releaseLock({ bookId, holder: `pipeline:${jobId}` });
    } catch (releaseErr) {
      log.warn(
        { task: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME, jobId, bookId, err: releaseErr },
        'failed to release BookLock (will be swept by locks.sweep)',
      );
    }
  }
}

function normalizeGenre(g: string): Genre | null {
  return ALLOWED_GENRES.has(g) ? (g as Genre) : null;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** graphile-worker 用エクスポート. `buildTaskList()` から登録される. */
export const pipelineBookThumbnailTextTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runPipelineBookThumbnailText(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};
