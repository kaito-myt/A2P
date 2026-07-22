import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  acquireBookLock as defaultAcquireBookLock,
  releaseBookLock as defaultReleaseBookLock,
} from '@a2p/agents/lib/book-lock';
import { generateOutline as defaultGenerateOutline } from '@a2p/agents/writer/outline';
import { reviewOutline as defaultReviewOutline } from '@a2p/agents/writer/outline-review';
import type { Genre } from '@a2p/contracts/agents';
import { GENRE_SLUGS } from '@a2p/contracts/agents';
import type {
  WriterOutlineInput,
  WriterOutlineOutput,
  ChapterPlan,
  OutlineReviewOutput,
} from '@a2p/contracts/agents/writer';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import {
  notifyJobChange as defaultNotifyJobChange,
  type JobChangeNotifyPayload,
} from '../lib/notify-job-change.js';
import { ALERT_COST_CHECK_TASK_NAME } from './alert-cost-check.js';

/**
 * `pipeline.book.writer.outline` タスク (docs/05 §5.3.3, F-003)
 *
 * Marketer 完了済みの `Book` に対し、Writer エージェントでアウトラインを生成し
 * `Outline(status='pending_review')` を upsert する。**ユーザー承認待ちで停止**
 * (後段 `pipeline.book.writer.chapter` の enqueue は `bulkApproveOutlines` SA が担う、
 * docs/05 §5.3.3)。
 *
 * フロー (T-03-04 marketer / T-03-05 kickoff と同形 + docs/05 §13 #5 冪等性):
 *   1. payload zod parse (book_id / job_id / reject_note?)
 *   2. 内部 `Job` 行を CAS で `running` に更新。既に `done` ならスキップ。
 *   3. Book fetch (theme_id 必須) → ThemeCandidate fetch → KdpMetadata fetch
 *      - KdpMetadata は Writer の参考情報. 不在でも warn 継続 (Marketer 失敗時の
 *        部分復旧シナリオを許容).
 *   4. `acquireBookLock(book_id, 'pipeline:<job_id>', 30)` 取得
 *   5. `generateOutline(...)` 呼出 (jobId は内部 `Job.id`、reject_note は payload から forward)
 *   6. `Outline.upsert({ where: book_id })` — book_id @unique なので 1 行のみ保持.
 *      再生成時は同行 update で `status='pending_review'` にリセット + chapters_json
 *      上書き + reject_note 反映 (schema は `Outline.version` 列を持たないため、
 *      version 管理は仕様未確定. T-04-04 では upsert で 1 行管理を選択する、
 *      Hard Rule #3: schema 整合性優先).
 *   7. 内部 `Job.status='done'` + `result_json={ outline_id, chapters_count, regenerated }`
 *   8. **次タスクは自動 enqueue しない** — `Outline.status='pending_review'` のまま停止し、
 *      ユーザー承認 (bulkApproveOutlines SA, T-04-07) を待つ.
 *   9. `notifyJobChange({ status: 'done', kind, bookId, phase: 'awaiting_outline_approval' })`
 *      で SSE 配信 (ADR-001: チャネル 'jobs').
 *  10. finally で BookLock 解放.
 *
 * エラー方針 (T-03-04 と同形):
 *   - payload zod 違反 → `ValidationError`
 *   - Book / Theme / Job 不在 → `NotFoundError` (内部 Job は failed に降格)
 *   - `generateOutline` AgentError / ProviderError → 透過 throw + Job=failed
 *   - Outline.upsert エラー → 透過 throw + Job=failed
 *   - BookLock acquire 失敗 (ConflictError) → 透過 throw + Job=failed
 *   - notifyJobChange 失敗 → warn のみで継続 (T-03-11 設計)
 */

export const PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME = 'pipeline.book.writer.outline';

/** docs/05 §5.3.3: `{ book_id, job_id, reject_note? }`. */
export const PipelineBookWriterOutlinePayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
  /** F-018 差戻し時の再呼出に Writer 側へ forward する運営者コメント. */
  reject_note: z.string().max(2000).optional(),
});
export type PipelineBookWriterOutlinePayload = z.infer<
  typeof PipelineBookWriterOutlinePayloadSchema
>;

/** Prisma 部分 I/F — テストで mock しやすいよう最小サブセット (kickoff と同形 + outline / kdpMetadata 追加). */
export interface PipelineBookWriterOutlinePrisma {
  /** notifyJobChange (pg_notify) 経由で SSE 配信するため. */
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
      };
    }) => Promise<{
      id: string;
      account_id: string;
      theme_id: string | null;
      title: string;
      subtitle: string | null;
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
      };
    }) => Promise<{
      id: string;
      genre: string;
      title: string;
      subtitle: string | null;
      hook: string;
      target_reader: string | null;
    } | null>;
  };
  kdpMetadata: {
    findUnique: (args: {
      where: { book_id: string };
      select: { description: true; keywords: true };
    }) => Promise<{ description: string; keywords: string[] } | null>;
  };
  outline: {
    upsert: (args: {
      where: { book_id: string };
      create: {
        book_id: string;
        chapters_json: unknown;
        review_json?: unknown;
        status: string;
        reject_note: string | null;
      };
      update: {
        chapters_json: unknown;
        review_json?: unknown;
        status: string;
        reject_note: string | null;
        approved_at: null;
      };
    }) => Promise<{ id: string; book_id: string }>;
  };
}

/** `helpers.addJob` の最小 I/F. */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineBookWriterOutlineDeps {
  prisma?: PipelineBookWriterOutlinePrisma;
  logger?: Logger;
  generateOutline?: typeof defaultGenerateOutline;
  reviewOutline?: typeof defaultReviewOutline;
  acquireLock?: typeof defaultAcquireBookLock;
  releaseLock?: typeof defaultReleaseBookLock;
  now?: () => Date;
  /** T-03-11: SSE 進捗配信用 pg_notify. 失敗しても本処理は継続. */
  notifyJobChange?: (
    payload: JobChangeNotifyPayload,
    deps: {
      prisma: { $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> };
      logger?: Logger;
    },
  ) => Promise<{ ok: boolean }>;
}

/** Writer outline の既定パラメータ (タスク詳細). */
const DEFAULT_TARGET_CHAPTER_COUNT = 8;
const DEFAULT_TARGET_TOTAL_CHARS = 50_000;
const ALLOWED_GENRES = new Set<string>(GENRE_SLUGS);
const OUTLINE_CHAR_TOLERANCE = 0.15;

/**
 * outline_review が返した改善版アウトラインが、generateOutline と同じ機械的制約
 * (章数 7〜10 / index 連番 / target_chars 合計 ±15%) を満たすか検証する。
 * per-chapter の制約 (subheadings 2〜10 等) は OutlineReviewOutputSchema が保証済み。
 */
function isValidRevisedOutline(chapters: ChapterPlan[], targetTotalChars: number): boolean {
  if (chapters.length < 7 || chapters.length > 10) return false;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i]!.index !== i + 1) return false;
  }
  const total = chapters.reduce((acc, c) => acc + c.target_chars, 0);
  const min = Math.floor(targetTotalChars * (1 - OUTLINE_CHAR_TOLERANCE));
  const max = Math.ceil(targetTotalChars * (1 + OUTLINE_CHAR_TOLERANCE));
  return total >= min && total <= max;
}

/**
 * graphile-worker から呼ばれる Task 本体は下の `pipelineBookWriterOutlineTask`.
 * このヘルパは DI を受け取りテストから直接呼べる.
 */
export async function runPipelineBookWriterOutline(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookWriterOutlineDeps = {},
): Promise<void> {
  const parsed = PipelineBookWriterOutlinePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.writer.outline payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId, job_id: jobId, reject_note: rejectNote } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME}`);
  const prisma =
    deps.prisma ?? (defaultPrisma as unknown as PipelineBookWriterOutlinePrisma);
  const generateOutlineFn = deps.generateOutline ?? defaultGenerateOutline;
  const reviewOutlineFn = deps.reviewOutline ?? defaultReviewOutline;
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
      { task: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME, jobId, bookId },
      'job already done — skipping (idempotent)',
    );
    return;
  }

  // 2. CAS で queued/failed → running
  const casResult = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (casResult.count === 0) {
    log.info(
      {
        task: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
        jobId,
        bookId,
        observedStatus: existing.status,
      },
      'job not in queued/failed state — skipping (probably already running on another worker)',
    );
    return;
  }

  // 3. BookLock 取得 — 失敗時は Job=failed 降格してから throw
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
        { task: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed after lock acquire failure',
      );
    }
    throw lockErr;
  }

  try {
    // 4. Book + Theme + KdpMetadata fetch
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        account_id: true,
        theme_id: true,
        title: true,
        subtitle: true,
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
      },
    });
    if (!theme) {
      throw new NotFoundError(`ThemeCandidate not found: ${book.theme_id}`, {
        details: { themeId: book.theme_id, bookId, jobId },
      });
    }

    // KdpMetadata は参考情報. 不在でも warn 継続 (Marketer 失敗時の部分復旧を許容).
    const kdpMeta = await prisma.kdpMetadata.findUnique({
      where: { book_id: bookId },
      select: { description: true, keywords: true },
    });
    if (!kdpMeta) {
      log.warn(
        { task: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME, jobId, bookId },
        'KdpMetadata not found — continuing without it (writer outline will run without keyword hints)',
      );
    }

    // 5. generateOutline 呼出
    const genre = normalizeGenre(theme.genre);
    const themeContext: WriterOutlineInput['themeContext'] = {
      title: (book.title && book.title.length > 0 ? book.title : theme.title).slice(0, 200),
      hook: (theme.hook ?? '').slice(0, 800) || '(no hook)',
      target_reader:
        (theme.target_reader ?? '').slice(0, 300) || '(no target_reader)',
    };
    const subtitle = book.subtitle ?? theme.subtitle ?? null;
    if (subtitle && subtitle.length > 0) {
      themeContext.subtitle = subtitle.slice(0, 200);
    }

    const outlineInput: WriterOutlineInput = {
      jobId,
      bookId,
      accountId: book.account_id,
      genre,
      themeContext,
      targetChapterCount: DEFAULT_TARGET_CHAPTER_COUNT,
      targetTotalChars: DEFAULT_TARGET_TOTAL_CHARS,
    };
    if (kdpMeta) {
      outlineInput.kdpMetadata = {
        description: kdpMeta.description,
        keywords: kdpMeta.keywords,
      };
    }
    if (rejectNote !== undefined && rejectNote.length > 0) {
      outlineInput.rejectNote = rejectNote;
    }

    const result: WriterOutlineOutput = await generateOutlineFn(outlineInput);

    // 5b. 章立て構成レビュー (F-003b) — 重複/網羅漏れ/順序/粒度 等を校正し、
    //     妥当な改善版が返れば採用する。失敗しても致命ではない (元アウトラインで続行)。
    let finalChapters: ChapterPlan[] = result.chapters;
    let reviewToStore: (OutlineReviewOutput & { revised_applied: boolean }) | null = null;
    try {
      const review = await reviewOutlineFn({
        jobId,
        bookId,
        genre,
        themeContext,
        chapters: result.chapters,
        targetTotalChars: DEFAULT_TARGET_TOTAL_CHARS,
      });
      const applied =
        review.revised_chapters !== undefined &&
        isValidRevisedOutline(review.revised_chapters, DEFAULT_TARGET_TOTAL_CHARS);
      if (applied) {
        finalChapters = review.revised_chapters!;
      }
      reviewToStore = { ...review, revised_applied: applied };
      log.info(
        {
          task: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
          jobId,
          bookId,
          issues: review.issues.length,
          overall_ok: review.overall_ok,
          revised_applied: applied,
        },
        'outline structural review complete',
      );
    } catch (reviewErr) {
      log.warn(
        { task: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME, jobId, bookId, err: reviewErr },
        'outline_review failed — keeping original outline',
      );
    }

    // 6. Outline.upsert — book_id @unique のため 1 行を維持し、再生成時は同行 update.
    //    再生成 (rejectNote 付き) では status を 'pending_review' に戻し approved_at を null 化.
    const isRegeneration = rejectNote !== undefined && rejectNote.length > 0;
    const persistedRejectNote = rejectNote && rejectNote.length > 0 ? rejectNote : null;
    const upserted = await prisma.outline.upsert({
      where: { book_id: bookId },
      create: {
        book_id: bookId,
        chapters_json: finalChapters,
        review_json: reviewToStore ?? undefined,
        status: 'pending_review',
        reject_note: persistedRejectNote,
      },
      update: {
        chapters_json: finalChapters,
        review_json: reviewToStore ?? undefined,
        status: 'pending_review',
        reject_note: persistedRejectNote,
        approved_at: null,
      },
    });

    // 7. Job を done に遷移 (次タスクは自動 enqueue しない — 承認待ち停止)
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          outline_id: upserted.id,
          chapters_count: finalChapters.length,
          total_chars_estimate: finalChapters.reduce((a, c) => a + c.target_chars, 0),
          regenerated_from_rejected: isRegeneration,
          review_issues: reviewToStore ? reviewToStore.issues.length : null,
          review_revised_applied: reviewToStore ? reviewToStore.revised_applied : null,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
        jobId,
        bookId,
        outlineId: upserted.id,
        chaptersCount: result.chapters.length,
        regenerated: isRegeneration,
      },
      'pipeline.book.writer.outline done — Outline pending_review (awaiting user approval)',
    );

    // 7a. per_book コストチェック enqueue (F-034 / T-07-02)
    await addJob(
      ALERT_COST_CHECK_TASK_NAME,
      { scope: 'per_book', book_id: bookId },
    );

    // 8. SSE 進捗配信 — phase=awaiting_outline_approval で UI に承認待ちを通知.
    await notifyJobChangeFn(
      {
        jobId,
        status: 'done',
        kind: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
        bookId,
        phase: 'awaiting_outline_approval',
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
        { task: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed',
      );
    }
    throw err;
  } finally {
    try {
      await releaseLock({ bookId, holder: `pipeline:${jobId}` });
    } catch (releaseErr) {
      log.warn(
        { task: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME, jobId, bookId, err: releaseErr },
        'failed to release BookLock (will be swept by locks.sweep)',
      );
    }
  }
}

/** DB の genre 文字列を WriterOutlineInput 入力 enum に正規化 (未知値は null fallback). */
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
export const pipelineBookWriterOutlineTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runPipelineBookWriterOutline(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};
