import type { JobHelpers, Task } from 'graphile-worker';
import pLimit from 'p-limit';
import { z } from 'zod';

import { parseEnv } from '@a2p/contracts/env';
import { ChapterPlanSchema } from '@a2p/contracts/agents/writer';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import {
  notifyJobChange as defaultNotifyJobChange,
  type JobChangeNotifyPayload,
} from '../lib/notify-job-change.js';
import { PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME } from './pipeline-book-writer-chapter.js';

/**
 * `pipeline.book.writer.chapters.dispatch` タスク (SP-04 T-04-05 親タスク)
 *
 * 親タスクとして `bulkApproveOutlines` SA (T-04-07) から呼ばれ、Outline 承認済の
 * `Book` に対し、章数 N 個の `pipeline.book.writer.chapter` を一括 enqueue する。
 *
 * 設計判断 (docs/05 §5.3.4 / §14 #4):
 *   - **p-limit はあくまで dispatch 内の addJob 投入時の並列制御**。実行並列度は
 *     graphile-worker 側の `WORKER_BOOK_CONCURRENCY` × runner concurrency で決まる
 *     (docs/03 §F JQ-01/JQ-02)。dispatch の p-limit は「短時間に大量 addJob で DB 負荷が
 *     スパイクするのを抑える」目的のスロットリング。
 *   - **完了監視は章タスク側の atomic 判定で行う**。dispatch は addJob 完走で即 done に
 *     遷移し、editor enqueue は最終章タスクが自身で判定 (Chapter.count === N) する設計。
 *     spec §4 注釈「親で p-limit 制御 + 完了監視で次フェーズ enqueue」を、dispatch では
 *     enqueue を担い、監視は子タスクで担う分担に分解した。
 *   - **BookLock は取らない**。章ワーカが並列で同 book に書き込むため、
 *     `book_id` 主キーの BookLock では 1 holder しか取れず衝突する。
 *     書き込みの安全性は `Chapter @@unique([book_id, index])` で担保される。
 *
 * フロー (docs/05 §5.2 共通ポリシー + §13 #5 冪等性 + T-04-04 outline と同形):
 *   1. payload zod parse (book_id / job_id / outline_id)
 *   2. 内部 `Job` 行を CAS で `running` に更新。既に `done` ならスキップ。
 *   3. Outline fetch + `chapters_json` を `ChapterPlan[]` として zod 検証。
 *      Outline.status === 'approved' でない場合は ValidationError (承認後にのみ起動される前提)。
 *   4. **再実行冪等性**: 既存の `pipeline.book.writer.chapter` Job (book_id, status in queued|running|done)
 *      を集計し、未 enqueue の chapter_index だけ追加投入する (再実行で N 倍化を防ぐ)。
 *   5. `p-limit(env.WORKER_CHAPTER_CONCURRENCY=4)` で章ジョブ N 件を並列に
 *      `prisma.job.create + addJob`. 各章 Job は `parent_job_id=<dispatch jobId>`。
 *   6. dispatch Job を done に遷移 (`result_json: { enqueued: N, skipped, chapter_indices }`).
 *   7. notifyJobChange.
 *
 * エラー方針:
 *   - payload zod 違反 / outline.chapters_json zod 違反 → `ValidationError`
 *   - Outline / Book 不在 → `NotFoundError`
 *   - Outline.status !== 'approved' → `ValidationError` (未承認では enqueue 拒否)
 *   - 章 Job INSERT or addJob 失敗 → 透過 throw + dispatch Job=failed (graphile-worker retry)
 *     - p-limit は失敗章で停止せず可能な限り進めず Promise.all で fail-fast。
 *       再実行時は step 4 の重複排除で未 enqueue 分のみ追加投入される。
 *   - notifyJobChange 失敗 → warn のみで継続
 */

export const PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME =
  'pipeline.book.writer.chapters.dispatch';

/** docs/05 §5.3.4 親タスク payload. */
export const PipelineBookWriterChaptersDispatchPayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
  outline_id: z.string().min(1),
});
export type PipelineBookWriterChaptersDispatchPayload = z.infer<
  typeof PipelineBookWriterChaptersDispatchPayloadSchema
>;

/** Prisma 部分 I/F. */
export interface PipelineBookWriterChaptersDispatchPrisma {
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
    findMany: (args: {
      where: {
        book_id: string;
        kind: string;
        status: { in: string[] };
      };
      select: { id: true; payload_json: true };
    }) => Promise<Array<{ id: string; payload_json: unknown }>>;
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
      select: { id: true };
    }) => Promise<{ id: string } | null>;
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
}

/** `helpers.addJob` の最小 I/F. */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineBookWriterChaptersDispatchDeps {
  prisma?: PipelineBookWriterChaptersDispatchPrisma;
  logger?: Logger;
  /** dispatch 内の p-limit 並列度 (既定: env.WORKER_CHAPTER_CONCURRENCY)。テストで小さい値に差替可能。 */
  chapterConcurrency?: number;
  now?: () => Date;
  notifyJobChange?: (
    payload: JobChangeNotifyPayload,
    deps: {
      prisma: { $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> };
      logger?: Logger;
    },
  ) => Promise<{ ok: boolean }>;
}

/**
 * graphile-worker から呼ばれる Task 本体は下の `pipelineBookWriterChaptersDispatchTask`.
 * このヘルパは DI を受け取りテストから直接呼べる.
 */
export async function runPipelineBookWriterChaptersDispatch(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookWriterChaptersDispatchDeps = {},
): Promise<void> {
  const parsed = PipelineBookWriterChaptersDispatchPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(
      'pipeline.book.writer.chapters.dispatch payload が不正です',
      { details: { issues: parsed.error.issues } },
    );
  }
  const { book_id: bookId, job_id: jobId, outline_id: outlineId } = parsed.data;

  const log =
    deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME}`);
  const prisma =
    deps.prisma ??
    (defaultPrisma as unknown as PipelineBookWriterChaptersDispatchPrisma);
  const notifyJobChangeFn = deps.notifyJobChange ?? defaultNotifyJobChange;
  const now = deps.now ?? (() => new Date());
  // 既定は env から、未指定なら 4 (env.WORKER_CHAPTER_CONCURRENCY のデフォルト)。
  // テストで env を引かないよう deps.chapterConcurrency を優先。
  const concurrency =
    deps.chapterConcurrency ?? resolveChapterConcurrencyFromEnv(log);

  // 1. 冪等性
  const existing = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true, book_id: true },
  });
  if (!existing) {
    throw new NotFoundError(`Job not found: ${jobId}`, {
      details: { jobId, bookId, outlineId },
    });
  }
  if (existing.status === 'done') {
    log.info(
      {
        task: PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
        jobId,
        bookId,
        outlineId,
      },
      'job already done — skipping (idempotent)',
    );
    return;
  }

  // 2. CAS
  const casResult = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (casResult.count === 0) {
    log.info(
      {
        task: PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
        jobId,
        bookId,
        outlineId,
        observedStatus: existing.status,
      },
      'job not in queued/failed state — skipping (probably already running on another worker)',
    );
    return;
  }

  try {
    // 3. Book + Outline fetch
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: { id: true },
    });
    if (!book) {
      throw new NotFoundError(`Book not found: ${bookId}`, {
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
    if (outline.status !== 'approved') {
      throw new ValidationError(
        `Outline.status must be 'approved' to dispatch chapters: got '${outline.status}'`,
        { details: { outlineId, status: outline.status } },
      );
    }

    const chaptersRaw = outline.chapters_json;
    if (!Array.isArray(chaptersRaw)) {
      throw new ValidationError(
        `Outline.chapters_json is not an array: ${outlineId}`,
        { details: { outlineId } },
      );
    }
    const chapters = chaptersRaw.map((c, i) => {
      try {
        return ChapterPlanSchema.parse(c);
      } catch (zerr) {
        throw new ValidationError(
          `Outline.chapters_json[${i}] is invalid ChapterPlan`,
          { details: { outlineId, index: i, cause: String(zerr) } },
        );
      }
    });

    // 4. 既存の chapter Job (queued/running/done) を引いて重複 enqueue を回避
    const existingChapterJobs = await prisma.job.findMany({
      where: {
        book_id: bookId,
        kind: PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
        status: { in: ['queued', 'running', 'done'] },
      },
      select: { id: true, payload_json: true },
    });
    const alreadyEnqueuedIndices = new Set<number>();
    for (const j of existingChapterJobs) {
      const p = j.payload_json as { chapter_index?: unknown } | null;
      if (p && typeof p.chapter_index === 'number') {
        alreadyEnqueuedIndices.add(p.chapter_index);
      }
    }

    const toEnqueue = chapters.filter(
      (c) => !alreadyEnqueuedIndices.has(c.index),
    );
    const skipped = chapters.length - toEnqueue.length;

    // 5. p-limit で章ジョブを並列 enqueue
    const limit = pLimit(concurrency);
    const childJobIds: Array<{ chapter_index: number; child_job_id: string }> = [];
    await Promise.all(
      toEnqueue.map((c) =>
        limit(async () => {
          const childPayload = {
            book_id: bookId,
            outline_id: outlineId,
            chapter_index: c.index,
          } as const;
          const childJob = await prisma.job.create({
            data: {
              kind: PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
              book_id: bookId,
              parent_job_id: jobId,
              status: 'queued',
              payload_json: childPayload,
            },
          });
          await addJob(
            PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
            {
              book_id: bookId,
              job_id: childJob.id,
              outline_id: outlineId,
              chapter_index: c.index,
            },
            { maxAttempts: 3 },
          );
          childJobIds.push({ chapter_index: c.index, child_job_id: childJob.id });
        }),
      ),
    );

    // 6. dispatch Job done
    childJobIds.sort((a, b) => a.chapter_index - b.chapter_index);
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          total_chapters: chapters.length,
          enqueued: toEnqueue.length,
          skipped_already_enqueued: skipped,
          chapter_concurrency: concurrency,
          children: childJobIds,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
        jobId,
        bookId,
        outlineId,
        totalChapters: chapters.length,
        enqueued: toEnqueue.length,
        skipped,
        concurrency,
      },
      'pipeline.book.writer.chapters.dispatch done — chapters enqueued',
    );

    // 7. notify
    await notifyJobChangeFn(
      {
        jobId,
        status: 'done',
        kind: PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
        bookId,
        phase: 'chapters_dispatched',
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
        {
          task: PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
          jobId,
          bookId,
          outlineId,
          err: jobUpdateErr,
        },
        'failed to mark internal Job as failed',
      );
    }
    throw err;
  }
}

/**
 * env から `WORKER_CHAPTER_CONCURRENCY` を解決。parseEnv 失敗時は warn して既定 4 fallback。
 * test では deps.chapterConcurrency を渡して env を引かない。
 */
function resolveChapterConcurrencyFromEnv(log: Logger): number {
  try {
    const env = parseEnv();
    return env.WORKER_CHAPTER_CONCURRENCY;
  } catch (err) {
    log.warn(
      { err },
      'failed to parse env for WORKER_CHAPTER_CONCURRENCY — using default 4',
    );
    return 4;
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

/** graphile-worker 用エクスポート. */
export const pipelineBookWriterChaptersDispatchTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runPipelineBookWriterChaptersDispatch(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};
