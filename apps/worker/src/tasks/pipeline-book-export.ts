import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  acquireBookLock as defaultAcquireBookLock,
  releaseBookLock as defaultReleaseBookLock,
} from '@a2p/agents/lib/book-lock';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';
import { buildDocx as defaultBuildDocx } from '@a2p/output-word';
import { buildPdf as defaultBuildPdf } from '@a2p/output-pdf';
import { resizeCover as defaultResizeCover } from '@a2p/output-image';
import {
  uploadBuffer as defaultUploadBuffer,
  downloadBuffer as defaultDownloadBuffer,
  bookArtifact,
  type UploadResult,
} from '@a2p/storage';

import {
  notifyJobChange as defaultNotifyJobChange,
  type JobChangeNotifyPayload,
} from '../lib/notify-job-change.js';
import { ALERT_COST_CHECK_TASK_NAME } from './alert-cost-check.js';
import { OPTIMIZER_PROMPT_GENERATE_TASK_NAME } from './optimizer-prompt-generate.js';

/**
 * `pipeline.book.export` タスク (docs/05 §5.3.9, F-012/F-013/F-014/F-015)
 *
 * Phase 1: サムネ全候補完了 or bulkAdoptCovers から呼ばれる。
 * docx / pdf / png_cover の 3 種を順次生成 -> R2 PUT -> Artifact x3 INSERT ->
 * Book.status='done', done_at=now() -> BookLock 解放 -> 完了通知 (pg_notify + メール)。
 *
 * Cover(status='adopted') が無い場合は cover_png をスキップ (docx + pdf のみ)。
 */

export const PIPELINE_BOOK_EXPORT_TASK_NAME = 'pipeline.book.export';

export const PipelineBookExportPayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
});
export type PipelineBookExportPayload = z.infer<typeof PipelineBookExportPayloadSchema>;

/** Prisma 部分 I/F -- テストで mock しやすいよう最小サブセット。 */
export interface PipelineBookExportPrisma {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  job: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true; book_id: true };
    }) => Promise<{ status: string; book_id: string | null } | null>;
    findFirst: (args: {
      where: { kind: string; status: { in: string[] } };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
    create: (args: {
      data: {
        kind: string;
        book_id: null;
        status: string;
        payload_json: unknown;
      };
    }) => Promise<{ id: string }>;
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
        title: true;
        subtitle: true;
      };
    }) => Promise<{
      id: string;
      title: string;
      subtitle: string | null;
    } | null>;
    update: (args: {
      where: { id: string };
      data: {
        status: string;
        done_at: Date;
        updated_at: Date;
      };
    }) => Promise<unknown>;
    count: (args: { where: { status: string } }) => Promise<number>;
  };
  chapter: {
    findMany: (args: {
      where: { book_id: string };
      select: {
        id: true;
        index: true;
        heading: true;
        body_md: true;
      };
      orderBy: { index: 'asc' };
    }) => Promise<
      Array<{
        id: string;
        index: number;
        heading: string;
        body_md: string;
      }>
    >;
  };
  cover: {
    findFirst: (args: {
      where: { book_id: string; status: string };
      select: { id: true; r2_key: true };
    }) => Promise<{ id: string; r2_key: string } | null>;
  };
  artifact: {
    create: (args: {
      data: {
        book_id: string;
        kind: string;
        r2_key: string;
        byte_size: number;
        checksum: string;
      };
    }) => Promise<{ id: string }>;
  };
}

export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineBookExportDeps {
  prisma?: PipelineBookExportPrisma;
  logger?: Logger;
  acquireLock?: typeof defaultAcquireBookLock;
  releaseLock?: typeof defaultReleaseBookLock;
  buildDocx?: typeof defaultBuildDocx;
  buildPdf?: typeof defaultBuildPdf;
  resizeCover?: typeof defaultResizeCover;
  uploadBuffer?: typeof defaultUploadBuffer;
  downloadBuffer?: typeof defaultDownloadBuffer;
  now?: () => Date;
  notifyJobChange?: (
    payload: JobChangeNotifyPayload,
    deps: {
      prisma: { $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> };
      logger?: Logger;
    },
  ) => Promise<{ ok: boolean }>;
  /** placeholder: SP-06 で sendEmail に差し替え */
  sendMail?: (params: { template: string; data: Record<string, unknown> }) => Promise<void>;
  /** テスト用: true にすると optimizer.prompt.generate enqueue をスキップする */
  skipOptimizerTrigger?: boolean;
}

export async function runPipelineBookExport(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookExportDeps = {},
): Promise<void> {
  const parsed = PipelineBookExportPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.export payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId, job_id: jobId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_EXPORT_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PipelineBookExportPrisma);
  const acquireLock = deps.acquireLock ?? defaultAcquireBookLock;
  const releaseLock = deps.releaseLock ?? defaultReleaseBookLock;
  const buildDocxFn = deps.buildDocx ?? defaultBuildDocx;
  const buildPdfFn = deps.buildPdf ?? defaultBuildPdf;
  const resizeCoverFn = deps.resizeCover ?? defaultResizeCover;
  const uploadBufferFn = deps.uploadBuffer ?? defaultUploadBuffer;
  const downloadBufferFn = deps.downloadBuffer ?? defaultDownloadBuffer;
  const notifyJobChangeFn = deps.notifyJobChange ?? defaultNotifyJobChange;
  const now = deps.now ?? (() => new Date());
  const sendMailFn = deps.sendMail ?? defaultSendMail;

  // 1. Idempotency: skip if already done
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
      { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId },
      'job already done — skipping (idempotent)',
    );
    return;
  }

  // 2. CAS: queued/failed -> running
  const casResult = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (casResult.count === 0) {
    log.info(
      {
        task: PIPELINE_BOOK_EXPORT_TASK_NAME,
        jobId,
        bookId,
        observedStatus: existing.status,
      },
      'job not in queued/failed state — skipping (probably already running on another worker)',
    );
    return;
  }

  // 3. BookLock acquire
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
        { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed after lock acquire failure',
      );
    }
    throw lockErr;
  }

  try {
    // 4. Fetch Book + Chapters
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: { id: true, title: true, subtitle: true },
    });
    if (!book) {
      throw new NotFoundError(`Book not found: ${bookId}`, {
        details: { bookId, jobId },
      });
    }

    const chapters = await prisma.chapter.findMany({
      where: { book_id: bookId },
      select: { id: true, index: true, heading: true, body_md: true },
      orderBy: { index: 'asc' },
    });
    if (chapters.length === 0) {
      throw new NotFoundError(
        `No chapters found for export: ${bookId} (writer/editor not run?)`,
        { details: { bookId, jobId } },
      );
    }

    const artifactIds: string[] = [];

    // 5. Build docx
    const docxBuffer = await buildDocxFn(
      { title: book.title, subtitle: book.subtitle },
      chapters.map((c) => ({ index: c.index, heading: c.heading, body_md: c.body_md })),
    );
    const docxKey = bookArtifact(bookId, 'docx');
    const docxUpload = await uploadBufferFn(
      docxKey,
      docxBuffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const docxArtifact = await prisma.artifact.create({
      data: {
        book_id: bookId,
        kind: 'docx',
        r2_key: docxUpload.key,
        byte_size: docxUpload.size,
        checksum: docxUpload.sha256,
      },
    });
    artifactIds.push(docxArtifact.id);
    log.info(
      { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId, kind: 'docx', size: docxUpload.size },
      'docx artifact created',
    );

    // 6. Build PDF
    const pdfBuffer = await buildPdfFn(
      { title: book.title, subtitle: book.subtitle },
      chapters.map((c) => ({ index: c.index, heading: c.heading, body_md: c.body_md })),
    );
    const pdfKey = bookArtifact(bookId, 'pdf');
    const pdfUpload = await uploadBufferFn(pdfKey, pdfBuffer, 'application/pdf');
    const pdfArtifact = await prisma.artifact.create({
      data: {
        book_id: bookId,
        kind: 'pdf',
        r2_key: pdfUpload.key,
        byte_size: pdfUpload.size,
        checksum: pdfUpload.sha256,
      },
    });
    artifactIds.push(pdfArtifact.id);
    log.info(
      { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId, kind: 'pdf', size: pdfUpload.size },
      'pdf artifact created',
    );

    // 7. Cover PNG (skip if no adopted cover)
    let coverArtifactId: string | null = null;
    const adoptedCover = await prisma.cover.findFirst({
      where: { book_id: bookId, status: 'adopted' },
      select: { id: true, r2_key: true },
    });
    if (adoptedCover) {
      const rawCoverBuffer = await downloadBufferFn(adoptedCover.r2_key);
      if (!rawCoverBuffer) {
        log.warn(
          { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId, r2Key: adoptedCover.r2_key },
          'adopted cover raw image not found in R2 — skipping cover_png',
        );
      } else {
        const resizedBuffer = await resizeCoverFn(rawCoverBuffer);
        const coverFilename = `${adoptedCover.id}-2560x1600.png`;
        const coverKey = bookArtifact(bookId, 'cover_png', coverFilename);
        const coverUpload = await uploadBufferFn(coverKey, resizedBuffer, 'image/png');
        const coverArtifact = await prisma.artifact.create({
          data: {
            book_id: bookId,
            kind: 'cover_png',
            r2_key: coverUpload.key,
            byte_size: coverUpload.size,
            checksum: coverUpload.sha256,
          },
        });
        coverArtifactId = coverArtifact.id;
        artifactIds.push(coverArtifact.id);
        log.info(
          {
            task: PIPELINE_BOOK_EXPORT_TASK_NAME,
            jobId,
            bookId,
            kind: 'cover_png',
            size: coverUpload.size,
          },
          'cover_png artifact created',
        );
      }
    } else {
      log.info(
        { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId },
        'no adopted cover found — skipping cover_png generation',
      );
    }

    // 8. Book.status='done', done_at=now()
    const doneAt = now();
    await prisma.book.update({
      where: { id: bookId },
      data: {
        status: 'done',
        done_at: doneAt,
        updated_at: doneAt,
      },
    });

    // 9. Job.status='done'
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          artifact_ids: artifactIds,
          cover_artifact_id: coverArtifactId,
          docx_size: docxUpload.size,
          pdf_size: pdfUpload.size,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_EXPORT_TASK_NAME,
        jobId,
        bookId,
        artifactCount: artifactIds.length,
      },
      'pipeline.book.export done',
    );

    // 9b. 10 冊出版完了トリガー: done 冊数が 10 の倍数なら optimizer を enqueue (T-11-03)
    // best-effort: 失敗しても export の done 状態に影響させない
    try {
      if (!deps.skipOptimizerTrigger) {
        const doneCount = await prisma.book.count({ where: { status: 'done' } });
        if (doneCount > 0 && doneCount % 10 === 0) {
          // 冪等性: queued/running の optimizer Job が既に存在する場合はスキップ
          const existingOptimizerJob = await prisma.job.findFirst({
            where: { kind: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, status: { in: ['queued', 'running'] } },
            select: { id: true },
          });
          if (existingOptimizerJob) {
            log.info(
              { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId, doneCount, existingOptimizerJobId: existingOptimizerJob.id },
              'optimizer.prompt.generate already queued/running — skipping duplicate enqueue',
            );
          } else {
            const optimizerJob = await prisma.job.create({
              data: {
                kind: OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
                book_id: null,
                status: 'queued',
                payload_json: {
                  trigger: 'cron_10_books',
                  job_id: '',
                },
              },
            });
            // payload_json.job_id に生成した Job.id を使って enqueue
            await addJob(
              OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
              { trigger: 'cron_10_books', job_id: optimizerJob.id },
              { maxAttempts: 2 },
            );
            log.info(
              { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId, doneCount, optimizerJobId: optimizerJob.id },
              'optimizer.prompt.generate enqueued (10-book trigger)',
            );
          }
        }
      }
    } catch (triggerErr) {
      log.warn(
        { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId, err: triggerErr },
        'optimizer trigger failed (non-fatal)',
      );
    }

    // 9a. per_book コストチェック enqueue (F-034 / T-07-02)
    await addJob(
      ALERT_COST_CHECK_TASK_NAME,
      { scope: 'per_book', book_id: bookId },
    );

    // 10. SSE notify
    await notifyJobChangeFn(
      {
        jobId,
        status: 'done',
        kind: PIPELINE_BOOK_EXPORT_TASK_NAME,
        bookId,
        phase: 'export_done',
      },
      { prisma, logger: log },
    );

    // 11. Completion email (placeholder until SP-06)
    try {
      await sendMailFn({
        template: 'book-done',
        data: {
          bookId,
          title: book.title,
          artifactCount: artifactIds.length,
        },
      });
    } catch (mailErr) {
      log.warn(
        { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId, err: mailErr },
        'completion email failed (non-fatal)',
      );
    }
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
        { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed',
      );
    }
    throw err;
  } finally {
    try {
      await releaseLock({ bookId, holder: `pipeline:${jobId}` });
    } catch (releaseErr) {
      log.warn(
        { task: PIPELINE_BOOK_EXPORT_TASK_NAME, jobId, bookId, err: releaseErr },
        'failed to release BookLock (will be swept by locks.sweep)',
      );
    }
  }
}

async function defaultSendMail(params: {
  template: string;
  data: Record<string, unknown>;
}): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    `[sendMail placeholder] template=${params.template} data=${JSON.stringify(params.data)}`,
  );
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
export const pipelineBookExportTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runPipelineBookExport(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};
