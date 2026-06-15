import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  acquireBookLock as defaultAcquireBookLock,
  releaseBookLock as defaultReleaseBookLock,
} from '@a2p/agents/lib/book-lock';
import { editBook as defaultEditBook } from '@a2p/agents/editor';
import type { Genre } from '@a2p/contracts/agents';
import {
  type EditorChapterInput,
  type EditorInput,
  type EditorOutput,
} from '@a2p/contracts/agents/editor';
import { RevisionFeedbackItemSchema } from '@a2p/contracts/agents/writer';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import {
  notifyJobChange as defaultNotifyJobChange,
  type JobChangeNotifyPayload,
} from '../lib/notify-job-change.js';
import { ALERT_COST_CHECK_TASK_NAME } from './alert-cost-check.js';
import { PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME } from './pipeline-book-thumbnail-text.js';

/**
 * `pipeline.book.editor` タスク (docs/05 §5.3.5, F-005 / R-05)
 *
 * 全章執筆完了済の `Book` に対し、Editor エージェントで全章を統合校閲し、
 * 巻末に AI 開示文を挿入する。各章は `Chapter.body_md` を更新 (version+1) し、
 * 旧 body を `ChapterRevision` に退避する (F-050 ロールバック用)。
 *
 * 起動経路: `pipeline.book.writer.chapter` の最終章タスクが Chapter.count===N を
 * 検出して内部 Job INSERT + addJob する (T-04-05 設計)。
 *
 * フロー (T-04-04 outline と同形 + ChapterRevision 退避 + thumbnail enqueue):
 *   1. payload zod parse (book_id / job_id / feedback?)
 *   2. 内部 `Job` 行を CAS で `running` に更新。既に `done` ならスキップ。
 *   3. BookLock `pipeline:<job_id>` 取得 (TTL 30 分、docs/05 §3 規約)。
 *   4. Book + ThemeCandidate + Chapter[] (book_id ASC) + AppSettings.ai_disclosure_text を fetch。
 *      - Chapter 0 件 → NotFoundError (Writer chapter が未実行 / 部分失敗)
 *      - AppSettings 1 行不在 → NotFoundError (seed 投入済が前提、運用上ありえない)
 *      - ai_disclosure_text が空文字 → ValidationError (R-05 違反防止)
 *   5. `editBook({ jobId, bookId, accountId, genre, themeContext, chapters,
 *      aiDisclosureText, feedback })` 呼出 (token_usage は editBook 内で role='editor' 記録)。
 *   6. **章ごとに atomic な ChapterRevision INSERT + Chapter update**:
 *      - 各章を **1 トランザクション** に閉じる (全章まとめると tx が長大化して
 *        Postgres ロック競合を起こすため、章単位の atomic boundary を選択)。
 *      - ChapterRevision: `version=旧version, body_md=旧body, reason='editor:<job_id>'`
 *      - Chapter: `body_md=校閲後, version=旧+1, char_count=新` (heading は変えない契約)
 *   7. **完了 enqueue**: `pipeline.book.thumbnail.text` 用の新規 `Job` INSERT + addJob
 *      (parent_job_id=本ジョブ)。docs/05 §5.3.5 に明記された次フェーズ chain。
 *      - 重複防止: 既存 thumbnail.text Job (queued/running/done) を findFirst で除外。
 *   8. 内部 `Job.status='done'` + `result_json={ revisions_count, ai_disclosure_appended,
 *      thumbnail_text_job_id }`
 *   9. `notifyJobChange({ phase: 'editor_done' })` で SSE 配信。
 *  10. finally で BookLock 解放。
 *
 * エラー方針 (T-04-04/05 と同形):
 *   - payload zod 違反 → `ValidationError`
 *   - Book / Theme / AppSettings 不在 / Chapter 0 件 → `NotFoundError` (内部 Job=failed 降格)
 *   - `editBook` AgentError / ProviderError → 透過 throw + Job=failed
 *   - 章 transaction 失敗 → 透過 throw + Job=failed (Postgres 側で部分 rollback、
 *     既処理済の章はそのまま、本ジョブ再実行時は冪等に再校閲 = 同 body から +1 で版重複なし
 *     とは限らないが、editor 再実行は基本的に「最新版から再校閲」になるため設計上許容)
 *   - BookLock acquire 失敗 (ConflictError) → 透過 throw + Job=failed
 *   - notifyJobChange 失敗 → warn のみで継続 (T-03-11 設計)
 */

export const PIPELINE_BOOK_EDITOR_TASK_NAME = 'pipeline.book.editor';

/** docs/05 §5.3.5: `{ book_id, job_id, feedback? }`. */
export const PipelineBookEditorPayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
  /** F-050 修正コメント反映 — Revision Applier (SP-06) から forward 想定。 */
  feedback: z.array(RevisionFeedbackItemSchema).max(50).optional(),
});
export type PipelineBookEditorPayload = z.infer<typeof PipelineBookEditorPayloadSchema>;

/** Prisma トランザクションクライアントの最小 I/F (章単位 atomic 用)。 */
export interface PipelineBookEditorTxClient {
  chapterRevision: {
    create: (args: {
      data: {
        chapter_id: string;
        book_id: string;
        version: number;
        body_md: string;
        reason: string;
      };
    }) => Promise<{ id: string }>;
  };
  chapter: {
    update: (args: {
      where: { id: string };
      data: {
        body_md: string;
        version: number;
        char_count: number;
        updated_at?: Date;
      };
    }) => Promise<{ id: string }>;
  };
}

/** Prisma 部分 I/F — テストで mock しやすいよう最小サブセット。 */
export interface PipelineBookEditorPrisma {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  /** 章単位 atomic (ChapterRevision INSERT + Chapter update) 用. */
  $transaction: <T>(fn: (tx: PipelineBookEditorTxClient) => Promise<T>) => Promise<T>;
  job: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true; book_id: true };
    }) => Promise<{ status: string; book_id: string | null } | null>;
    findFirst: (args: {
      where: {
        book_id: string;
        kind: string;
        status: { in: string[] };
      };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
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
  chapter: {
    findMany: (args: {
      where: { book_id: string };
      select: {
        id: true;
        index: true;
        heading: true;
        body_md: true;
        version: true;
      };
      orderBy: { index: 'asc' };
    }) => Promise<
      Array<{
        id: string;
        index: number;
        heading: string;
        body_md: string;
        version: number;
      }>
    >;
  };
  appSettings: {
    findUnique: (args: {
      where: { id: string };
      select: { ai_disclosure_text: true };
    }) => Promise<{ ai_disclosure_text: string } | null>;
  };
}

/** `helpers.addJob` の最小 I/F (kickoff / writer.chapter と同形). */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineBookEditorDeps {
  prisma?: PipelineBookEditorPrisma;
  logger?: Logger;
  editBook?: typeof defaultEditBook;
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

const ALLOWED_GENRES = new Set<string>(['practical', 'business', 'self_help']);

/**
 * graphile-worker から呼ばれる Task 本体は下の `pipelineBookEditorTask`.
 * このヘルパは DI を受け取りテストから直接呼べる.
 */
export async function runPipelineBookEditor(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookEditorDeps = {},
): Promise<void> {
  const parsed = PipelineBookEditorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.editor payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId, job_id: jobId, feedback } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_EDITOR_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PipelineBookEditorPrisma);
  const editBookFn = deps.editBook ?? defaultEditBook;
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
      { task: PIPELINE_BOOK_EDITOR_TASK_NAME, jobId, bookId },
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
        task: PIPELINE_BOOK_EDITOR_TASK_NAME,
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
        { task: PIPELINE_BOOK_EDITOR_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed after lock acquire failure',
      );
    }
    throw lockErr;
  }

  try {
    // 4. Book + Theme + Chapter[] + AppSettings fetch
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

    const chapters = await prisma.chapter.findMany({
      where: { book_id: bookId },
      select: { id: true, index: true, heading: true, body_md: true, version: true },
      orderBy: { index: 'asc' },
    });
    if (chapters.length === 0) {
      throw new NotFoundError(
        `No chapters found for editor: ${bookId} (writer.chapter not run?)`,
        { details: { bookId, jobId } },
      );
    }

    const appSettings = await prisma.appSettings.findUnique({
      where: { id: 'singleton' },
      select: { ai_disclosure_text: true },
    });
    if (!appSettings) {
      throw new NotFoundError('AppSettings singleton row not found', {
        details: { bookId, jobId },
      });
    }
    const aiDisclosureText = (appSettings.ai_disclosure_text ?? '').trim();
    if (aiDisclosureText.length === 0) {
      throw new ValidationError(
        'AppSettings.ai_disclosure_text が空です (R-05 違反防止)',
        { details: { bookId, jobId } },
      );
    }

    // 5. editBook 呼出 (token_usage は editBook 内で role='editor', book_id 紐付け INSERT)
    const genre = normalizeGenre(theme.genre);
    const themeContext: EditorInput['themeContext'] = {
      title: (book.title && book.title.length > 0 ? book.title : theme.title).slice(0, 200),
      hook: (theme.hook ?? '').slice(0, 800) || '(no hook)',
      target_reader:
        (theme.target_reader ?? '').slice(0, 300) || '(no target_reader)',
    };
    const subtitle = book.subtitle ?? theme.subtitle ?? null;
    if (subtitle && subtitle.length > 0) {
      themeContext.subtitle = subtitle.slice(0, 200);
    }

    const editorChapters: EditorChapterInput[] = chapters.map((c) => ({
      index: c.index,
      heading: c.heading,
      body_md: c.body_md,
    }));

    const editorInput: EditorInput = {
      jobId,
      bookId,
      accountId: book.account_id,
      genre,
      themeContext,
      chapters: editorChapters,
      aiDisclosureText,
      feedback: feedback ?? [],
    };

    const result: EditorOutput = await editBookFn(editorInput);

    // 6. 章ごとに atomic ChapterRevision INSERT + Chapter update (version+1)
    //    index で result と既存 Chapter を紐付け (editBook 契約で index 順序維持)。
    const byIndex = new Map<number, (typeof chapters)[number]>();
    for (const c of chapters) byIndex.set(c.index, c);

    let revisionsCount = 0;
    const reason = `editor:${jobId}`;
    for (const updated of result.chapters) {
      const original = byIndex.get(updated.index);
      if (!original) {
        // editBook は index 一致を保証するが、防衛的に skip + warn
        log.warn(
          { task: PIPELINE_BOOK_EDITOR_TASK_NAME, jobId, bookId, index: updated.index },
          'editor returned chapter index that does not match any Chapter row — skipping',
        );
        continue;
      }
      // body_md が同一なら revision 退避 + version bump をスキップしてもよいが、
      // T-04-06 受入基準「version++」を満たすため常に書く (Editor は校閲を行った前提)。
      const newCharCount = [...updated.body_md].length;
      await prisma.$transaction(async (tx) => {
        await tx.chapterRevision.create({
          data: {
            chapter_id: original.id,
            book_id: bookId,
            version: original.version,
            body_md: original.body_md,
            reason,
          },
        });
        await tx.chapter.update({
          where: { id: original.id },
          data: {
            body_md: updated.body_md,
            version: original.version + 1,
            char_count: newCharCount,
            updated_at: now(),
          },
        });
      });
      revisionsCount += 1;
    }

    // 7. 完了で pipeline.book.thumbnail.text を enqueue (docs/05 §5.3.5)
    //    重複防止: 既存 queued/running/done を除外
    let thumbnailJobId: string | null = null;
    const existingThumbnail = await prisma.job.findFirst({
      where: {
        book_id: bookId,
        kind: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
        status: { in: ['queued', 'running', 'done'] },
      },
      select: { id: true },
    });
    if (existingThumbnail) {
      log.info(
        {
          task: PIPELINE_BOOK_EDITOR_TASK_NAME,
          jobId,
          bookId,
          existingThumbnailJobId: existingThumbnail.id,
        },
        'thumbnail.text Job already enqueued for this book — skipping duplicate',
      );
    } else {
      const thumbnailJob = await prisma.job.create({
        data: {
          kind: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
          book_id: bookId,
          parent_job_id: jobId,
          status: 'queued',
          payload_json: { book_id: bookId },
        },
      });
      await addJob(
        PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
        { book_id: bookId, job_id: thumbnailJob.id },
        { maxAttempts: 3 },
      );
      thumbnailJobId = thumbnailJob.id;
    }

    // 8. 内部 Job を done に遷移
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          revisions_count: revisionsCount,
          ai_disclosure_appended: result.ai_disclosure_appended,
          thumbnail_text_job_id: thumbnailJobId,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_EDITOR_TASK_NAME,
        jobId,
        bookId,
        revisionsCount,
        aiDisclosureAppended: result.ai_disclosure_appended,
        thumbnailJobId,
      },
      'pipeline.book.editor done',
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
        kind: PIPELINE_BOOK_EDITOR_TASK_NAME,
        bookId,
        phase: 'editor_done',
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
        { task: PIPELINE_BOOK_EDITOR_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed',
      );
    }
    throw err;
  } finally {
    try {
      await releaseLock({ bookId, holder: `pipeline:${jobId}` });
    } catch (releaseErr) {
      log.warn(
        { task: PIPELINE_BOOK_EDITOR_TASK_NAME, jobId, bookId, err: releaseErr },
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
export const pipelineBookEditorTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runPipelineBookEditor(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};
