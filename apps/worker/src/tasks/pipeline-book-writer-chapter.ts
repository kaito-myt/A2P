import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { generateChapter as defaultGenerateChapter } from '@a2p/agents/writer/chapter';
import type { Genre } from '@a2p/contracts/agents';
import {
  ChapterPlanSchema,
  type WriterChapterInput,
  type WriterChapterOutput,
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
 * `pipeline.book.writer.chapter` タスク (docs/05 §5.3.4, F-004 / F-011)
 *
 * 1 タスク = 1 章。親 `pipeline.book.writer.chapters.dispatch` から N 個 enqueue され、
 * graphile-worker の `concurrency` + 親側 `p-limit(WORKER_CHAPTER_CONCURRENCY=4)` で並列実行される。
 *
 * フロー (docs/05 §5.2 共通ポリシー + §13 #5 冪等性 + T-04-04 outline と同形):
 *   1. payload zod parse (book_id / job_id / outline_id / chapter_index / feedback?)
 *   2. 内部 `Job` 行を CAS で `running` に更新。既に `done` ならスキップ。
 *   3. Book + Outline + ThemeCandidate を fetch、`outline.chapters_json` から chapter_index に
 *      対応する `ChapterPlan` を抽出 (zod 検証)。
 *   4. 直前章までの `Chapter` 行 (book_id 同じ + index < chapter_index) を読み出し、
 *      `previousChaptersSummary` を「heading + body_md 先頭 200 字」で構築 (docs/05 §5.3.4 簡易実装)。
 *   5. `generateChapter({ jobId, bookId, accountId, genre, outlineChapter, themeContext,
 *      previousChaptersSummary, feedback })` 呼出。
 *   6. `Chapter.upsert({ where: { book_id_index } })` で 1 行を維持
 *      (再実行で同 chapter_index を上書き)。SP-04 §4 T-04-06 で Editor が version+1 を扱う。
 *   7. 内部 `Job.status='done'` + `result_json={ chapter_id, char_count, chapter_index, is_last? }`。
 *   8. **完了監視 → editor enqueue**: 同 book_id の `Chapter.count()` が
 *      `outline.chapters_json.length` に達したら `pipeline.book.editor` 用の **新規 Job INSERT** +
 *      addJob (parent_job_id=<本章 jobId>)。SP-04 §4 注釈の「dispatch 後の完了監視は章 task
 *      自身が atomic に判定」方式を採用。
 *      - race 抑制: editor enqueue は `editorEnqueueGuard` (book 単位の advisory 判定) で
 *        同一書籍に既に `pipeline.book.editor` の queued/running/done Job が存在しないことを
 *        確認してから INSERT する (二重 enqueue 防止)。
 *   9. `notifyJobChange({ status, kind, bookId, phase? })` で SSE 配信。
 *  10. **BookLock は取らない**: BookLock は `book_id` 主キー = 同一書籍に 1 holder のみ。
 *      N 章並列実行で衝突するため、章 worker は lock-free で動作する。
 *      章間の書き込み競合は `Chapter @@unique([book_id, index])` で防がれる。
 *      他系統 (revision_run / kdp_submit) との衝突は `Book.status='running'` で論理保護される。
 *
 * エラー方針:
 *   - payload zod 違反 / outline.chapters_json zod 違反 → `ValidationError`
 *   - Book / Outline / Theme 不在、chapter_index 範囲外 → `NotFoundError` + Job=failed 降格
 *   - `generateChapter` AgentError / ProviderError → 透過 throw + Job=failed
 *   - Chapter.upsert / editor enqueue 失敗 → 透過 throw + Job=failed
 *   - notifyJobChange 失敗 → warn のみで継続 (T-03-11 設計)
 */

export const PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME = 'pipeline.book.writer.chapter';

/** F-050 修正コメントスキーマ (Writer 入力と同形)。 */
const FeedbackItemSchema = z.object({
  body: z.string().min(1).max(2000),
  priority: z.enum(['must', 'should', 'may']),
});

/** docs/05 §5.3.4: `{ book_id, job_id, outline_id, chapter_index, feedback? }`. */
export const PipelineBookWriterChapterPayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
  outline_id: z.string().min(1),
  /** 1-indexed (ChapterPlan.index と一致)。 */
  chapter_index: z.number().int().min(1),
  /** F-050 修正コメント反映 (再実行時、`revision.book.apply` から forward)。 */
  feedback: z.array(FeedbackItemSchema).max(50).optional(),
});
export type PipelineBookWriterChapterPayload = z.infer<
  typeof PipelineBookWriterChapterPayloadSchema
>;

/** Prisma 部分 I/F — テストで mock しやすいよう最小サブセット。 */
export interface PipelineBookWriterChapterPrisma {
  /** notifyJobChange (pg_notify) 用. */
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
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
  outline: {
    findUnique: (args: {
      where: { id: string };
      select: { id: true; book_id: true; chapters_json: true; status: true };
    }) => Promise<{
      id: string;
      book_id: string;
      chapters_json: unknown;
      status: string;
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
    /** 直前章のサマリ用 fetch — index < N で並べる. */
    findMany: (args: {
      where: { book_id: string; index: { lt: number } };
      select: { index: true; heading: true; body_md: true };
      orderBy: { index: 'asc' };
    }) => Promise<Array<{ index: number; heading: string; body_md: string }>>;
    count: (args: { where: { book_id: string } }) => Promise<number>;
    upsert: (args: {
      where: { book_id_index: { book_id: string; index: number } };
      create: {
        book_id: string;
        index: number;
        heading: string;
        body_md: string;
        status: string;
        char_count: number;
        version: number;
      };
      update: {
        heading: string;
        body_md: string;
        status: string;
        char_count: number;
      };
    }) => Promise<{ id: string; book_id: string; index: number }>;
  };
}

/** `helpers.addJob` の最小 I/F (kickoff / marketer と同形). */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineBookWriterChapterDeps {
  prisma?: PipelineBookWriterChapterPrisma;
  logger?: Logger;
  generateChapter?: typeof defaultGenerateChapter;
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

const ALLOWED_GENRES = new Set<string>(['practical', 'business', 'self_help']);

/** 直前章の本文先頭抜粋字数 (docs/05 §5.3.4 簡易要約)。 */
const PREVIOUS_CHAPTER_EXCERPT_CHARS = 200;
/** previousChaptersSummary 全体の上限 (WriterChapterInputSchema.previousChaptersSummary.max=4000)。 */
const PREVIOUS_SUMMARY_MAX_CHARS = 3800;

/**
 * graphile-worker から呼ばれる Task 本体は下の `pipelineBookWriterChapterTask`.
 * このヘルパは DI を受け取りテストから直接呼べる.
 */
export async function runPipelineBookWriterChapter(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookWriterChapterDeps = {},
): Promise<void> {
  const parsed = PipelineBookWriterChapterPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.writer.chapter payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const {
    book_id: bookId,
    job_id: jobId,
    outline_id: outlineId,
    chapter_index: chapterIndex,
    feedback,
  } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME}`);
  const prisma =
    deps.prisma ?? (defaultPrisma as unknown as PipelineBookWriterChapterPrisma);
  const generateChapterFn = deps.generateChapter ?? defaultGenerateChapter;
  const notifyJobChangeFn = deps.notifyJobChange ?? defaultNotifyJobChange;
  const now = deps.now ?? (() => new Date());

  // 1. 冪等性チェック: 既に done なら skip
  const existing = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true, book_id: true },
  });
  if (!existing) {
    throw new NotFoundError(`Job not found: ${jobId}`, {
      details: { jobId, bookId, chapterIndex },
    });
  }
  if (existing.status === 'done') {
    log.info(
      { task: PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME, jobId, bookId, chapterIndex },
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
        task: PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
        jobId,
        bookId,
        chapterIndex,
        observedStatus: existing.status,
      },
      'job not in queued/failed state — skipping (probably already running on another worker)',
    );
    return;
  }

  try {
    // 3. Book + Outline + Theme fetch
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
        details: { bookId, jobId, chapterIndex },
      });
    }
    if (!book.theme_id) {
      throw new NotFoundError(`Book has no theme_id: ${bookId}`, {
        details: { bookId, jobId },
      });
    }

    const outline = await prisma.outline.findUnique({
      where: { id: outlineId },
      select: { id: true, book_id: true, chapters_json: true, status: true },
    });
    if (!outline) {
      throw new NotFoundError(`Outline not found: ${outlineId}`, {
        details: { outlineId, bookId, jobId },
      });
    }
    if (outline.book_id !== bookId) {
      throw new ValidationError(
        `Outline.book_id mismatch: outline=${outline.book_id} payload=${bookId}`,
        { details: { outlineId, outlineBookId: outline.book_id, payloadBookId: bookId } },
      );
    }

    // outline.chapters_json は ChapterPlan[] 形式 (docs/05 §6.3.2 / Outline.chapters_json)
    const chaptersRaw = outline.chapters_json;
    if (!Array.isArray(chaptersRaw)) {
      throw new ValidationError(
        `Outline.chapters_json is not an array: ${outlineId}`,
        { details: { outlineId } },
      );
    }
    const totalChapters = chaptersRaw.length;
    const targetRaw = chaptersRaw.find(
      (c) =>
        typeof c === 'object' && c !== null &&
        (c as { index?: unknown }).index === chapterIndex,
    );
    if (!targetRaw) {
      throw new NotFoundError(
        `Outline has no chapter at index ${chapterIndex}: ${outlineId}`,
        { details: { outlineId, chapterIndex, totalChapters } },
      );
    }
    const outlineChapter = ChapterPlanSchema.parse(targetRaw);

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

    // 4. 直前章までの Chapter 行を読み、previousChaptersSummary を構築
    const previousSummary = await buildPreviousChaptersSummary({
      prisma,
      bookId,
      chapterIndex,
    });

    // 5. generateChapter 呼出
    const genre = normalizeGenre(theme.genre);
    const themeContext: WriterChapterInput['themeContext'] = {
      title: (book.title && book.title.length > 0 ? book.title : theme.title).slice(0, 200),
      hook: (theme.hook ?? '').slice(0, 800) || '(no hook)',
      target_reader:
        (theme.target_reader ?? '').slice(0, 300) || '(no target_reader)',
    };
    const subtitle = book.subtitle ?? theme.subtitle ?? null;
    if (subtitle && subtitle.length > 0) {
      themeContext.subtitle = subtitle.slice(0, 200);
    }

    const chapterInput: WriterChapterInput = {
      jobId,
      bookId,
      accountId: book.account_id,
      genre,
      outlineChapter,
      themeContext,
    };
    if (previousSummary.length > 0) {
      chapterInput.previousChaptersSummary = previousSummary;
    }
    if (feedback && feedback.length > 0) {
      chapterInput.feedback = feedback;
    }

    const result: WriterChapterOutput = await generateChapterFn(chapterInput);

    // 6. Chapter.upsert — book_id_index @unique で 1 行を維持
    //    再実行 (CAS で queued/failed → running を経由) では同行 update で body_md 上書き.
    //    version は新規 1 / 既存は据え置き (Editor T-04-06 で +1)。
    const upserted = await prisma.chapter.upsert({
      where: { book_id_index: { book_id: bookId, index: chapterIndex } },
      create: {
        book_id: bookId,
        index: chapterIndex,
        heading: result.heading,
        body_md: result.body_md,
        status: 'done',
        char_count: result.char_count,
        version: 1,
      },
      update: {
        heading: result.heading,
        body_md: result.body_md,
        status: 'done',
        char_count: result.char_count,
      },
    });

    // 7. 完了監視 → editor enqueue 判定
    //    同一 book の Chapter 行数が outline.chapters_json.length に達していれば、
    //    自分が最終章担当として `pipeline.book.editor` を enqueue する.
    //    二重 enqueue は editorEnqueueGuard で防ぐ.
    const completedCount = await prisma.chapter.count({
      where: { book_id: bookId },
    });
    const isLast = completedCount >= totalChapters;
    let editorJobId: string | null = null;
    if (isLast) {
      const existingEditorJob = await prisma.job.findFirst({
        where: {
          book_id: bookId,
          kind: 'pipeline.book.editor',
          status: { in: ['queued', 'running', 'done'] },
        },
        select: { id: true },
      });
      if (existingEditorJob) {
        log.info(
          {
            task: PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
            jobId,
            bookId,
            chapterIndex,
            existingEditorJobId: existingEditorJob.id,
          },
          'editor Job already enqueued for this book — skipping duplicate',
        );
      } else {
        const editorJob = await prisma.job.create({
          data: {
            kind: 'pipeline.book.editor',
            book_id: bookId,
            parent_job_id: jobId,
            status: 'queued',
            payload_json: { book_id: bookId },
          },
        });
        await addJob(
          'pipeline.book.editor',
          { book_id: bookId, job_id: editorJob.id },
          { maxAttempts: 3 },
        );
        editorJobId = editorJob.id;
        log.info(
          {
            task: PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
            jobId,
            bookId,
            chapterIndex,
            editorJobId,
            completedCount,
            totalChapters,
          },
          'all chapters complete — pipeline.book.editor enqueued',
        );
      }
    }

    // 8. Job を done に遷移
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          chapter_id: upserted.id,
          chapter_index: chapterIndex,
          char_count: result.char_count,
          is_last: isLast,
          editor_job_id: editorJobId,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
        jobId,
        bookId,
        chapterIndex,
        chapterId: upserted.id,
        charCount: result.char_count,
        completedCount,
        totalChapters,
        isLast,
      },
      'pipeline.book.writer.chapter done',
    );

    // 8a. per_book コストチェック enqueue (F-034 / T-07-02)
    await addJob(
      ALERT_COST_CHECK_TASK_NAME,
      { scope: 'per_book', book_id: bookId },
    );

    // 9. SSE 進捗配信
    const notifyPayload: JobChangeNotifyPayload = {
      jobId,
      status: 'done',
      kind: PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
      bookId,
    };
    if (isLast) {
      notifyPayload.phase = 'chapters_complete';
    }
    await notifyJobChangeFn(notifyPayload, { prisma, logger: log });
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
        {
          task: PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
          jobId,
          bookId,
          chapterIndex,
          err: jobUpdateErr,
        },
        'failed to mark internal Job as failed',
      );
    }
    throw err;
  }
}

/**
 * 直前章の `Chapter` 行から `previousChaptersSummary` を構築。
 * SP-04 §4 T-04-05: 「heading + body_md 先頭 200 字」の簡易要約。
 * 全体が 3800 字を超えたら古い章から切り詰める (WriterChapterInputSchema.previousChaptersSummary.max=4000)。
 */
async function buildPreviousChaptersSummary(args: {
  prisma: PipelineBookWriterChapterPrisma;
  bookId: string;
  chapterIndex: number;
}): Promise<string> {
  const rows = await args.prisma.chapter.findMany({
    where: { book_id: args.bookId, index: { lt: args.chapterIndex } },
    select: { index: true, heading: true, body_md: true },
    orderBy: { index: 'asc' },
  });
  if (rows.length === 0) return '';

  const segments = rows.map((r) => {
    const excerpt = [...r.body_md].slice(0, PREVIOUS_CHAPTER_EXCERPT_CHARS).join('');
    return `第${r.index}章: ${r.heading}\n${excerpt}`;
  });

  let total = segments.join('\n\n');
  // 末尾 (最新章) を優先して残すため、超過時は先頭から削る
  while ([...total].length > PREVIOUS_SUMMARY_MAX_CHARS && segments.length > 1) {
    segments.shift();
    total = segments.join('\n\n');
  }
  // 単一章でも上限超過なら codepoint 単位で切り詰める
  if ([...total].length > PREVIOUS_SUMMARY_MAX_CHARS) {
    total = [...total].slice(0, PREVIOUS_SUMMARY_MAX_CHARS).join('');
  }
  return total;
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
export const pipelineBookWriterChapterTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runPipelineBookWriterChapter(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};
