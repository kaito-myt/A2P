import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  generateCoverImage as defaultGenerateCoverImage,
  type GenerateCoverImageDeps,
} from '@a2p/agents/thumbnail/image';
import type { ThumbnailImageInput, ThumbnailImageOutput } from '@a2p/contracts/agents/thumbnail';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import {
  notifyJobChange as defaultNotifyJobChange,
  type JobChangeNotifyPayload,
} from '../lib/notify-job-change.js';
import { ALERT_COST_CHECK_TASK_NAME } from './alert-cost-check.js';
import { PIPELINE_BOOK_JUDGE_TASK_NAME } from './pipeline-book-judge.js';

/**
 * `pipeline.book.thumbnail.image` タスク (docs/05 ss5.3.7, F-007)
 *
 * `pipeline.book.thumbnail.text` から 3 並列 enqueue され、
 * 各 CoverTextProposal に対して gpt-image-1 でカバー画像を 1 枚生成する。
 *
 * フロー:
 *   1. payload zod parse (book_id / cover_text_id / job_id)
 *   2. 内部 `Job` 行を CAS で `running` に更新。既に `done` ならスキップ。
 *   3. CoverTextProposal fetch (title / subtitle 取得)。
 *   4. `generateCoverImage(input)` 呼出 (token_usage は内部 withImageLogging 経由で記録済)。
 *   5. 全候補完了判定: Cover(book_id, status='generated') の件数 >= 親 Job.children 数。
 *      全完了なら `pipeline.book.judge` を enqueue (retry_count=0)。
 *   6. 内部 `Job.status='done'` + result_json。
 *   7. `notifyJobChange({ phase })` で SSE 配信。
 *
 * BookLock: 個々の画像タスクでは不要。親の thumbnail.text が保持している。
 *
 * エラー方針:
 *   - payload zod 違反 -> ValidationError
 *   - Job / CoverTextProposal 不在 -> NotFoundError + Job=failed
 *   - generateCoverImage failure -> 透過 throw + Job=failed
 *   - notifyJobChange 失敗 -> warn のみで継続
 */

export const PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME = 'pipeline.book.thumbnail.image';

/** docs/05 ss5.3.7: `{ book_id, cover_text_id, job_id }`. */
export const PipelineBookThumbnailImagePayloadSchema = z.object({
  book_id: z.string().min(1),
  cover_text_id: z.string().min(1),
  job_id: z.string().min(1),
});
export type PipelineBookThumbnailImagePayload = z.infer<
  typeof PipelineBookThumbnailImagePayloadSchema
>;

/** Prisma 部分 I/F -- テストで mock しやすいよう最小サブセット。 */
export interface PipelineBookThumbnailImagePrisma {
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
    update: (args: {
      where: { id: string };
      data: { status: string; updated_at?: Date };
    }) => Promise<unknown>;
  };
  coverTextProposal: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        book_id: true;
        title: true;
        subtitle: true;
      };
    }) => Promise<{
      id: string;
      book_id: string;
      title: string;
      subtitle: string | null;
    } | null>;
  };
  cover: {
    count: (args: {
      where: { book_id: string; status: string };
    }) => Promise<number>;
  };
}

/** `helpers.addJob` の最小 I/F. */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineBookThumbnailImageDeps {
  prisma?: PipelineBookThumbnailImagePrisma;
  logger?: Logger;
  generateCoverImage?: (
    input: ThumbnailImageInput,
    deps?: GenerateCoverImageDeps,
  ) => Promise<ThumbnailImageOutput>;
  /** generateCoverImage に渡す内部 DI (R2, prisma, etc)。 */
  generateCoverImageDeps?: GenerateCoverImageDeps;
  now?: () => Date;
  notifyJobChange?: (
    payload: JobChangeNotifyPayload,
    deps: {
      prisma: { $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> };
      logger?: Logger;
    },
  ) => Promise<{ ok: boolean }>;
  /** 全候補完了と判定する Cover 件数。既定: 3 (docs/05 ss5.3.6 DEFAULT_PROPOSAL_COUNT)。 */
  expectedCoverCount?: number;
}

const DEFAULT_EXPECTED_COVER_COUNT = 3;

/**
 * graphile-worker から呼ばれる Task 本体は下の `pipelineBookThumbnailImageTask`.
 * このヘルパは DI を受け取りテストから直接呼べる.
 */
export async function runPipelineBookThumbnailImage(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookThumbnailImageDeps = {},
): Promise<void> {
  const parsed = PipelineBookThumbnailImagePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.thumbnail.image payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId, cover_text_id: coverTextId, job_id: jobId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PipelineBookThumbnailImagePrisma);
  const generateCoverImageFn = deps.generateCoverImage ?? defaultGenerateCoverImage;
  const generateCoverImageDeps = deps.generateCoverImageDeps;
  const notifyJobChangeFn = deps.notifyJobChange ?? defaultNotifyJobChange;
  const now = deps.now ?? (() => new Date());
  const expectedCoverCount = deps.expectedCoverCount ?? DEFAULT_EXPECTED_COVER_COUNT;

  // 1. 冪等性チェック: 既に done なら skip
  const existing = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true, book_id: true },
  });
  if (!existing) {
    throw new NotFoundError(`Job not found: ${jobId}`, {
      details: { jobId, bookId, coverTextId },
    });
  }
  if (existing.status === 'done') {
    log.info(
      { task: PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME, jobId, bookId, coverTextId },
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
        task: PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
        jobId,
        bookId,
        coverTextId,
        observedStatus: existing.status,
      },
      'job not in queued/failed state — skipping (probably already running on another worker)',
    );
    return;
  }

  try {
    // 3. CoverTextProposal fetch
    const coverText = await prisma.coverTextProposal.findUnique({
      where: { id: coverTextId },
      select: { id: true, book_id: true, title: true, subtitle: true },
    });
    if (!coverText) {
      throw new NotFoundError(`CoverTextProposal not found: ${coverTextId}`, {
        details: { coverTextId, bookId, jobId },
      });
    }
    if (coverText.book_id !== bookId) {
      throw new ValidationError(
        `CoverTextProposal.book_id mismatch: proposal=${coverText.book_id} payload=${bookId}`,
        { details: { coverTextId, coverTextBookId: coverText.book_id, payloadBookId: bookId } },
      );
    }

    // 4. generateCoverImage 呼出
    const imageInput: ThumbnailImageInput = {
      jobId,
      bookId,
      coverTextId,
      title: coverText.title,
      subtitle: coverText.subtitle ?? undefined,
      styleGuide: '',
      width: 1024,
      height: 1536,
    };

    const result: ThumbnailImageOutput = await generateCoverImageFn(
      imageInput,
      generateCoverImageDeps,
    );

    // 5. 全候補完了判定
    const coverCount = await prisma.cover.count({
      where: { book_id: bookId, status: 'generated' },
    });
    const allComplete = coverCount >= expectedCoverCount;

    let judgeJobId: string | null = null;
    if (allComplete) {
      // 二重 enqueue 防止: 既に pipeline.book.judge の Job が存在するか確認
      const existingJudgeJob = await prisma.job.findFirst({
        where: {
          book_id: bookId,
          kind: PIPELINE_BOOK_JUDGE_TASK_NAME,
          status: { in: ['queued', 'running', 'done'] },
        },
        select: { id: true },
      });
      if (existingJudgeJob) {
        log.info(
          {
            task: PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
            jobId,
            bookId,
            existingJudgeJobId: existingJudgeJob.id,
          },
          'judge Job already enqueued for this book — skipping duplicate',
        );
      } else {
        const judgeJob = await prisma.job.create({
          data: {
            kind: PIPELINE_BOOK_JUDGE_TASK_NAME,
            book_id: bookId,
            parent_job_id: jobId,
            status: 'queued',
            payload_json: { book_id: bookId, retry_count: 0 },
          },
        });
        await prisma.book.update({
          where: { id: bookId },
          data: { status: 'judging', updated_at: now() },
        });
        await addJob(
          PIPELINE_BOOK_JUDGE_TASK_NAME,
          { book_id: bookId, job_id: judgeJob.id, retry_count: 0 },
          { maxAttempts: 2 },
        );
        judgeJobId = judgeJob.id;
        log.info(
          {
            task: PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
            jobId,
            bookId,
            coverCount,
            expectedCoverCount,
            judgeJobId,
          },
          'all cover images complete — pipeline.book.judge enqueued',
        );
      }
    }

    // 6. 内部 Job を done に遷移
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          cover_id: result.coverId,
          r2_key: result.r2Key,
          all_complete: allComplete,
          cover_count: coverCount,
          judge_job_id: judgeJobId,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
        jobId,
        bookId,
        coverTextId,
        coverId: result.coverId,
        r2Key: result.r2Key,
        coverCount,
        allComplete,
      },
      'pipeline.book.thumbnail.image done',
    );

    // 6a. per_book コストチェック enqueue (F-034 / T-07-02)
    await addJob(
      ALERT_COST_CHECK_TASK_NAME,
      { scope: 'per_book', book_id: bookId },
    );

    // 7. SSE 進捗配信
    const notifyPayload: JobChangeNotifyPayload = {
      jobId,
      status: 'done',
      kind: PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
      bookId,
    };
    if (allComplete) {
      notifyPayload.phase = 'thumbnail_images_complete';
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
        { task: PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed',
      );
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

/** graphile-worker 用エクスポート. `buildTaskList()` から登録される. */
export const pipelineBookThumbnailImageTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runPipelineBookThumbnailImage(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};
