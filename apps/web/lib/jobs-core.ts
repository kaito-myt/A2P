/**
 * Jobs Server Action core logic (T-04-11, T-07-07, F-016/F-046).
 *
 * `app/actions/jobs.ts` (SA wrapper) から呼ばれる業務ロジック。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする
 * (outlines-core / themes-core と同パターン)。
 *
 * 仕様根拠:
 *  - docs/05 §4.3.14 retryJob / resumePausedBook SA
 *  - docs/02 F-016 受入基準: Editor 失敗で Writer 出力は破棄されない
 *  - docs/02 F-034 受入基準: 750 円到達でジョブ停止 → 運営者が「続行」「中止」
 *  - docs/02 F-046 受入基準: リトライ操作が監査ログに残る
 *  - SP-04 §4 T-04-11: from_step='auto' / 'this_step' / retries++ / audit_log
 *  - SP-07 §4 T-07-07: resumePausedBook continue/cancel + audit_log
 *
 * パイプラインステップ順序 (docs/05 §5.3):
 *   kickoff -> marketer -> writer.outline -> writer.chapters.dispatch
 *   -> writer.chapter -> editor -> thumbnail.text -> thumbnail.image
 *   -> judge -> export
 *
 * retryJob(auto):
 *   失敗ジョブの book_id に紐づく全ジョブを調べ、最も進んでいる
 *   失敗ステップから再開する。
 *   - Editor 失敗 → Editor だけ再 enqueue (Writer 出力を再利用)
 *   - Chapter 一部完了 → 未完了章 (status!='done') のみ再 enqueue
 *     + 完了済章は触らない
 *   - Outline 失敗 → Outline ステップから再 enqueue
 *
 * retryJob(this_step):
 *   指定ジョブの kind に応じたタスクを 1 つ再 enqueue する。
 *
 * resumePausedBook(continue):
 *   cost_status='paused' の書籍を再開。最後に cancel された pipeline Job の
 *   kind から Book.status を推定し、そのステップを再 enqueue する。
 *
 * resumePausedBook(cancel):
 *   paused 書籍を中止。Book.status='cancelled'、BookLock 解放。
 */
import { z } from 'zod';

import {
  NotFoundError,
  ValidationError,
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import { Prisma } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// Pipeline step ordering (docs/05 §5.3)
// ---------------------------------------------------------------------------

const PIPELINE_STEP_ORDER: readonly string[] = [
  'pipeline.book.kickoff',
  'pipeline.book.marketer',
  'pipeline.book.writer.outline',
  'pipeline.book.writer.chapters.dispatch',
  'pipeline.book.writer.chapter',
  'pipeline.book.editor',
  'pipeline.book.thumbnail.text',
  'pipeline.book.thumbnail.image',
  'pipeline.book.judge',
  'pipeline.book.export',
];

function stepIndex(kind: string): number {
  const idx = PIPELINE_STEP_ORDER.indexOf(kind);
  return idx >= 0 ? idx : -1;
}

// ---------------------------------------------------------------------------
// zod schemas (docs/05 §4.3.14)
// ---------------------------------------------------------------------------

// from_step: 'auto' = retry from best failed step (existing behaviour)
//            'this_step' = retry exactly the job's own kind (existing behaviour)
//            PIPELINE_STEP_ORDER value = resume from that specific step (S-026 "ステップから再開")
export const RetryJobInputSchema = z.object({
  job_id: z.string().min(1),
  from_step: z
    .string()
    .min(1)
    .refine(
      (v) =>
        v === 'auto' ||
        v === 'this_step' ||
        (PIPELINE_STEP_ORDER as readonly string[]).includes(v),
      { message: 'from_step must be "auto", "this_step", or a registered pipeline step kind' },
    )
    .default('auto'),
});
export type RetryJobInput = z.infer<typeof RetryJobInputSchema>;

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface JobRow {
  id: string;
  kind: string;
  book_id: string | null;
  status: string;
  retries: number;
  payload_json: unknown;
}

export interface ChapterRow {
  id: string;
  index: number;
  status: string;
}

export interface OutlineRow {
  id: string;
  status: string;
}

export interface JobRepoForRetry {
  findUnique(args: {
    where: { id: string };
    select: {
      id: true;
      kind: true;
      book_id: true;
      status: true;
      retries: true;
      payload_json: true;
    };
  }): Promise<JobRow | null>;
  findMany(args: {
    where: { book_id: string; kind?: string | { in: string[] }; status?: string | { in: string[] } };
    select: {
      id: true;
      kind: true;
      book_id: true;
      status: true;
      retries: true;
      payload_json: true;
    };
    orderBy?: { created_at: 'desc' };
  }): Promise<JobRow[]>;
  update(args: {
    where: { id: string };
    data: { retries?: number; status?: string };
  }): Promise<{ id: string }>;
  create(args: {
    data: Prisma.JobUncheckedCreateInput;
  }): Promise<{ id: string }>;
}

export interface ChapterRepoForRetry {
  findMany(args: {
    where: { book_id: string };
    select: { id: true; index: true; status: true };
  }): Promise<ChapterRow[]>;
}

export interface OutlineRepoForRetry {
  findUnique(args: {
    where: { book_id: string };
    select: { id: true; status: true };
  }): Promise<OutlineRow | null>;
}

export interface AuditLogRepoForRetry {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export type EnqueueJobFn = (
  taskName: string,
  payload: unknown,
) => Promise<string>;

export interface JobsDeps {
  jobRepo: JobRepoForRetry;
  chapterRepo: ChapterRepoForRetry;
  outlineRepo: OutlineRepoForRetry;
  auditLogRepo: AuditLogRepoForRetry;
  session: AuthenticatedSession;
  enqueueJob: EnqueueJobFn;
  now?: () => Date;
}

interface ResolvedDeps extends JobsDeps {
  now: () => Date;
}

function resolveDeps(d: JobsDeps): ResolvedDeps {
  return { ...d, now: d.now ?? (() => new Date()) };
}

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface RetryJobResult {
  new_job_id: string;
  /** Retried step kind. */
  retried_step: string;
  /** Additional job IDs created (e.g., per-chapter retry). */
  additional_job_ids?: string[];
}

// ---------------------------------------------------------------------------
// retryJobCore
// ---------------------------------------------------------------------------

export async function retryJobCore(
  raw: unknown,
  rawDeps: JobsDeps,
): Promise<ActionResult<RetryJobResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = RetryJobInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.jobs.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const { job_id: jobId, from_step: fromStep } = parsed.data;

    // 1. Fetch the target job
    const job = await deps.jobRepo.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        kind: true,
        book_id: true,
        status: true,
        retries: true,
        payload_json: true,
      },
    });
    if (!job) {
      throw new NotFoundError('Job not found', {
        userMessage: messages.jobs.errors.notFound,
        details: { job_id: jobId },
      });
    }

    if (job.status !== 'failed') {
      throw new ValidationError('Job is not in failed status', {
        userMessage: messages.jobs.errors.notFailed,
        details: { job_id: jobId, status: job.status },
      });
    }

    if (!job.book_id) {
      throw new ValidationError('Job has no book_id', {
        userMessage: messages.jobs.errors.noBookId,
        details: { job_id: jobId },
      });
    }

    const bookId = job.book_id;
    const originalRetries = job.retries;
    const newRetries = originalRetries + 1;

    // 2. Increment retries on the original job
    await deps.jobRepo.update({
      where: { id: jobId },
      data: { retries: newRetries },
    });

    let result: RetryJobResult;

    if (fromStep === 'this_step') {
      result = await retryThisStep(job, bookId, deps);
    } else if (fromStep === 'auto') {
      result = await retryAuto(job, bookId, deps);
    } else {
      // Specific pipeline step name — enqueue that exact step with from_step in payload
      result = await retryFromNamedStep(job, bookId, fromStep, deps);
    }

    // 3. Audit log (F-046)
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'job.retry',
        target_kind: 'job',
        target_id: jobId,
        before_json: {
          job_id: jobId,
          kind: job.kind,
          status: 'failed',
          retries: originalRetries,
          from_step: fromStep,
        } as unknown as Prisma.InputJsonValue,
        after_json: {
          new_job_id: result.new_job_id,
          retried_step: result.retried_step,
          retries: newRetries,
          additional_job_ids: result.additional_job_ids ?? [],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok(result);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.jobs.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// this_step: re-enqueue exactly the failed job's step
// ---------------------------------------------------------------------------

async function retryThisStep(
  job: JobRow,
  bookId: string,
  deps: ResolvedDeps,
): Promise<RetryJobResult> {
  const newJob = await deps.jobRepo.create({
    data: {
      kind: job.kind,
      book_id: bookId,
      status: 'queued',
      payload_json: buildPayloadForKind(job.kind, bookId, job.payload_json),
    },
  });

  try {
    await deps.enqueueJob(job.kind, {
      ...extractBasePayload(job.payload_json),
      book_id: bookId,
      job_id: newJob.id,
    });
  } catch (err) {
    throw new ValidationError('enqueue failed', {
      userMessage: messages.jobs.errors.enqueueFailed,
      cause: err,
    });
  }

  return {
    new_job_id: newJob.id,
    retried_step: job.kind,
  };
}

// ---------------------------------------------------------------------------
// named step: enqueue a specific pipeline step (S-026 "ステップから再開")
// The from_step value is carried in the payload so the worker can honor it.
// ---------------------------------------------------------------------------

async function retryFromNamedStep(
  job: JobRow,
  bookId: string,
  stepKind: string,
  deps: ResolvedDeps,
): Promise<RetryJobResult> {
  const newJob = await deps.jobRepo.create({
    data: {
      kind: stepKind,
      book_id: bookId,
      status: 'queued',
      payload_json: {
        ...extractBasePayload(job.payload_json),
        book_id: bookId,
        from_step: stepKind,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  try {
    await deps.enqueueJob(stepKind, {
      ...extractBasePayload(job.payload_json),
      book_id: bookId,
      job_id: newJob.id,
      from_step: stepKind,
    });
  } catch (err) {
    throw new ValidationError('enqueue failed', {
      userMessage: messages.jobs.errors.enqueueFailed,
      cause: err,
    });
  }

  return {
    new_job_id: newJob.id,
    retried_step: stepKind,
  };
}

// ---------------------------------------------------------------------------
// auto: find the latest failure point and resume from there
// ---------------------------------------------------------------------------

async function retryAuto(
  job: JobRow,
  bookId: string,
  deps: ResolvedDeps,
): Promise<RetryJobResult> {
  // Find all jobs for this book to understand pipeline state
  const bookJobs = await deps.jobRepo.findMany({
    where: { book_id: bookId },
    select: {
      id: true,
      kind: true,
      book_id: true,
      status: true,
      retries: true,
      payload_json: true,
    },
    orderBy: { created_at: 'desc' },
  });

  // Find the furthest failed step in the pipeline
  const failedJobs = bookJobs.filter((j) => j.status === 'failed');
  if (failedJobs.length === 0) {
    throw new NotFoundError('No failed steps found for auto retry', {
      userMessage: messages.jobs.errors.noFailedStep,
      details: { book_id: bookId },
    });
  }

  // Sort by pipeline order: find the most advanced failed step
  const latestFailedJob = failedJobs.reduce((best, curr) => {
    const bestIdx = stepIndex(best.kind);
    const currIdx = stepIndex(curr.kind);
    return currIdx > bestIdx ? curr : best;
  }, failedJobs[0]!);

  // Special case: chapter tasks with partial completion
  if (latestFailedJob.kind === 'pipeline.book.writer.chapter') {
    return retryIncompleteChapters(bookId, bookJobs, deps);
  }

  // Special case: chapters.dispatch failed
  if (latestFailedJob.kind === 'pipeline.book.writer.chapters.dispatch') {
    return retryChaptersDispatch(bookId, latestFailedJob, deps);
  }

  // General case: re-enqueue the failed step
  const newJob = await deps.jobRepo.create({
    data: {
      kind: latestFailedJob.kind,
      book_id: bookId,
      status: 'queued',
      payload_json: buildPayloadForKind(
        latestFailedJob.kind,
        bookId,
        latestFailedJob.payload_json,
      ),
    },
  });

  try {
    await deps.enqueueJob(latestFailedJob.kind, {
      ...extractBasePayload(latestFailedJob.payload_json),
      book_id: bookId,
      job_id: newJob.id,
    });
  } catch (err) {
    throw new ValidationError('enqueue failed', {
      userMessage: messages.jobs.errors.enqueueFailed,
      cause: err,
    });
  }

  return {
    new_job_id: newJob.id,
    retried_step: latestFailedJob.kind,
  };
}

// ---------------------------------------------------------------------------
// Chapter-level partial retry
// ---------------------------------------------------------------------------

async function retryIncompleteChapters(
  bookId: string,
  bookJobs: JobRow[],
  deps: ResolvedDeps,
): Promise<RetryJobResult> {
  // Find chapters that are not done
  const chapters = await deps.chapterRepo.findMany({
    where: { book_id: bookId },
    select: { id: true, index: true, status: true },
  });

  const incompleteChapters = chapters.filter((c) => c.status !== 'done');

  if (incompleteChapters.length === 0) {
    // All chapters done but chapter job was marked failed?
    // This can happen if the "all done" check or editor enqueue failed.
    // Fall back to enqueuing editor.
    const newJob = await deps.jobRepo.create({
      data: {
        kind: 'pipeline.book.editor',
        book_id: bookId,
        status: 'queued',
        payload_json: { book_id: bookId } as unknown as Prisma.InputJsonValue,
      },
    });
    await deps.enqueueJob('pipeline.book.editor', {
      book_id: bookId,
      job_id: newJob.id,
    });
    return {
      new_job_id: newJob.id,
      retried_step: 'pipeline.book.editor',
    };
  }

  // Create a job per incomplete chapter
  const additionalJobIds: string[] = [];
  let firstJobId: string | null = null;

  for (const ch of incompleteChapters) {
    const payload = {
      book_id: bookId,
      chapter_index: ch.index,
    } as unknown as Prisma.InputJsonValue;

    const newJob = await deps.jobRepo.create({
      data: {
        kind: 'pipeline.book.writer.chapter',
        book_id: bookId,
        status: 'queued',
        payload_json: payload,
      },
    });

    try {
      await deps.enqueueJob('pipeline.book.writer.chapter', {
        book_id: bookId,
        chapter_index: ch.index,
        job_id: newJob.id,
      });
    } catch (err) {
      throw new ValidationError('enqueue failed for chapter retry', {
        userMessage: messages.jobs.errors.enqueueFailed,
        cause: err,
        details: { chapter_index: ch.index },
      });
    }

    if (!firstJobId) {
      firstJobId = newJob.id;
    } else {
      additionalJobIds.push(newJob.id);
    }
  }

  return {
    new_job_id: firstJobId!,
    retried_step: 'pipeline.book.writer.chapter',
    additional_job_ids: additionalJobIds.length > 0 ? additionalJobIds : undefined,
  };
}

// ---------------------------------------------------------------------------
// chapters.dispatch retry
// ---------------------------------------------------------------------------

async function retryChaptersDispatch(
  bookId: string,
  failedJob: JobRow,
  deps: ResolvedDeps,
): Promise<RetryJobResult> {
  // Check if outline is approved (required for dispatch)
  const outline = await deps.outlineRepo.findUnique({
    where: { book_id: bookId },
    select: { id: true, status: true },
  });

  const payload: Record<string, unknown> = { book_id: bookId };
  if (outline) {
    payload.outline_id = outline.id;
  }

  const newJob = await deps.jobRepo.create({
    data: {
      kind: 'pipeline.book.writer.chapters.dispatch',
      book_id: bookId,
      status: 'queued',
      payload_json: payload as unknown as Prisma.InputJsonValue,
    },
  });

  try {
    await deps.enqueueJob('pipeline.book.writer.chapters.dispatch', {
      ...payload,
      job_id: newJob.id,
    });
  } catch (err) {
    throw new ValidationError('enqueue failed', {
      userMessage: messages.jobs.errors.enqueueFailed,
      cause: err,
    });
  }

  return {
    new_job_id: newJob.id,
    retried_step: 'pipeline.book.writer.chapters.dispatch',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the payload_json for a new Job row.
 * Strips job_id from the original payload (will be assigned after create).
 */
function buildPayloadForKind(
  kind: string,
  bookId: string,
  originalPayload: unknown,
): Prisma.InputJsonValue {
  const base = extractBasePayload(originalPayload);
  return { ...base, book_id: bookId } as unknown as Prisma.InputJsonValue;
}

/**
 * Extract payload fields from the original job, excluding job_id
 * (which is re-assigned after the new Job row is created).
 */
function extractBasePayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const { job_id: _jobId, ...rest } = payload as Record<string, unknown>;
    return rest;
  }
  return {};
}

// ===========================================================================
// bulkRetryJobsCore (T-09-01, F-046, docs/05 §4.3.14)
// ===========================================================================

export const BulkRetryJobsInputSchema = z.object({
  job_ids: z.array(z.string().min(1)).min(1),
});
export type BulkRetryJobsInput = z.infer<typeof BulkRetryJobsInputSchema>;

export interface BulkRetryJobsResult {
  retried_count: number;
  skipped: Array<{ job_id: string; reason: string }>;
}

// DI: reuse JobsDeps from retryJobCore.

export async function bulkRetryJobsCore(
  raw: unknown,
  rawDeps: JobsDeps,
): Promise<ActionResult<BulkRetryJobsResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = BulkRetryJobsInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.jobs.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  const { job_ids: jobIds } = parsed.data;
  const skipped: BulkRetryJobsResult['skipped'] = [];
  let retriedCount = 0;
  const retriedJobIds: string[] = [];

  try {
    for (const jobId of jobIds) {
      const job = await deps.jobRepo.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          kind: true,
          book_id: true,
          status: true,
          retries: true,
          payload_json: true,
        },
      });

      if (!job) {
        skipped.push({ job_id: jobId, reason: messages.jobs.errors.notFound });
        continue;
      }

      if (job.status !== 'failed') {
        skipped.push({
          job_id: jobId,
          reason:
            job.status === 'running'
              ? messages.jobs.bulk.skipReasonRunning
              : job.status === 'done'
                ? messages.jobs.bulk.skipReasonDone
                : messages.jobs.bulk.skipReasonNotRetriable, // covers cancelled/queued
        });
        continue;
      }

      // Delegate to per-job retry logic (reuses retryJobCore)
      const singleResult = await retryJobCore({ job_id: jobId, from_step: 'auto' }, deps);
      if (singleResult.ok) {
        retriedCount += 1;
        retriedJobIds.push(jobId);
      } else {
        skipped.push({
          job_id: jobId,
          reason: singleResult.error.message ?? messages.jobs.errors.unknown,
        });
      }
    }

    // Single batch audit log entry for the bulk action
    if (retriedCount > 0) {
      await deps.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'job.bulk_retry',
          target_kind: 'job',
          target_id: retriedJobIds[0]!,
          before_json: {
            job_ids: jobIds,
            total: jobIds.length,
          } as unknown as Prisma.InputJsonValue,
          after_json: {
            retried_count: retriedCount,
            retried_job_ids: retriedJobIds,
            skipped_count: skipped.length,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return ok({ retried_count: retriedCount, skipped });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.jobs.errors.unknown);
  }
}

// ===========================================================================
// resumePausedBookCore (T-07-07, F-034/F-046, docs/05 §4.3.14)
// ===========================================================================

// ---------------------------------------------------------------------------
// Pipeline kind → Book.status mapping
// ---------------------------------------------------------------------------

const PIPELINE_KIND_TO_BOOK_STATUS: Record<string, string> = {
  'pipeline.book.kickoff': 'running',
  'pipeline.book.marketer': 'running',
  'pipeline.book.writer.outline': 'running',
  'pipeline.book.writer.chapters.dispatch': 'running',
  'pipeline.book.writer.chapter': 'running',
  'pipeline.book.editor': 'editing',
  'pipeline.book.thumbnail.text': 'thumbnail',
  'pipeline.book.thumbnail.image': 'thumbnail',
  'pipeline.book.judge': 'judging',
  'pipeline.book.export': 'exporting',
};

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

export const ResumePausedBookInputSchema = z.object({
  book_id: z.string().min(1),
  decision: z.enum(['continue', 'cancel']),
});
export type ResumePausedBookInput = z.infer<typeof ResumePausedBookInputSchema>;

// ---------------------------------------------------------------------------
// DI boundary for resumePausedBook
// ---------------------------------------------------------------------------

export interface BookRowForResume {
  id: string;
  status: string;
  cost_status: string;
}

export interface BookRepoForResume {
  findUnique(args: {
    where: { id: string };
    select: { id: true; status: true; cost_status: true };
  }): Promise<BookRowForResume | null>;
  update(args: {
    where: { id: string };
    data: { status?: string; cost_status?: string };
  }): Promise<{ id: string }>;
}

export interface JobRowForResume {
  id: string;
  kind: string;
  book_id: string | null;
  status: string;
  payload_json: unknown;
}

export interface JobRepoForResume {
  findMany(args: {
    where: {
      book_id: string;
      kind?: { startsWith: string };
      status?: string | { in: string[] };
    };
    select: {
      id: true;
      kind: true;
      book_id: true;
      status: true;
      payload_json: true;
    };
    orderBy?: { created_at: 'desc' };
  }): Promise<JobRowForResume[]>;
  create(args: {
    data: Prisma.JobUncheckedCreateInput;
  }): Promise<{ id: string }>;
}

export interface BookLockRepoForResume {
  deleteMany(args: {
    where: { book_id: string };
  }): Promise<{ count: number }>;
}

export interface AuditLogRepoForResume {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export interface ResumePausedBookDeps {
  bookRepo: BookRepoForResume;
  jobRepo: JobRepoForResume;
  bookLockRepo: BookLockRepoForResume;
  auditLogRepo: AuditLogRepoForResume;
  session: AuthenticatedSession;
  enqueueJob: EnqueueJobFn;
}

// ---------------------------------------------------------------------------
// resumePausedBookCore
// ---------------------------------------------------------------------------

export async function resumePausedBookCore(
  raw: unknown,
  deps: ResumePausedBookDeps,
): Promise<ActionResult<void>> {
  const parsed = ResumePausedBookInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.costDashboard.errors.unknown);
  }

  const { book_id: bookId, decision } = parsed.data;

  try {
    const book = await deps.bookRepo.findUnique({
      where: { id: bookId },
      select: { id: true, status: true, cost_status: true },
    });

    if (!book) {
      throw new NotFoundError('Book not found', {
        userMessage: messages.costDashboard.errors.notFound,
        details: { book_id: bookId },
      });
    }

    if (book.status !== 'paused_cost' && book.cost_status !== 'paused') {
      throw new ValidationError('Book is not paused', {
        userMessage: messages.costDashboard.errors.notPaused,
        details: { book_id: bookId, status: book.status, cost_status: book.cost_status },
      });
    }

    if (decision === 'continue') {
      await resumeContinue(bookId, deps);
    } else {
      await resumeCancel(bookId, deps);
    }

    return ok(undefined);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.costDashboard.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// continue: restore Book.status + re-enqueue cancelled pipeline step
// ---------------------------------------------------------------------------

async function resumeContinue(
  bookId: string,
  deps: ResumePausedBookDeps,
): Promise<void> {
  // Find the latest cancelled pipeline.book.* job to determine resume point
  const cancelledJobs = await deps.jobRepo.findMany({
    where: {
      book_id: bookId,
      kind: { startsWith: 'pipeline.book.' },
      status: 'cancelled',
    },
    select: {
      id: true,
      kind: true,
      book_id: true,
      status: true,
      payload_json: true,
    },
    orderBy: { created_at: 'desc' },
  });

  if (cancelledJobs.length === 0) {
    throw new ValidationError('No cancelled pipeline job found for resume', {
      userMessage: messages.costDashboard.errors.noCancelledJob,
      details: { book_id: bookId },
    });
  }

  // Pick the most advanced cancelled step (latest in pipeline order)
  const resumeJob = cancelledJobs.reduce((best, curr) => {
    const bestIdx = stepIndex(best.kind);
    const currIdx = stepIndex(curr.kind);
    return currIdx > bestIdx ? curr : best;
  }, cancelledJobs[0]!);

  const restoredBookStatus = PIPELINE_KIND_TO_BOOK_STATUS[resumeJob.kind] ?? 'running';

  // Update Book: cost_status='normal', status restored
  await deps.bookRepo.update({
    where: { id: bookId },
    data: {
      cost_status: 'normal',
      status: restoredBookStatus,
    },
  });

  // Create a new Job row and enqueue
  const basePayload = extractBasePayload(resumeJob.payload_json);
  const newJob = await deps.jobRepo.create({
    data: {
      kind: resumeJob.kind,
      book_id: bookId,
      status: 'queued',
      payload_json: { ...basePayload, book_id: bookId } as unknown as Prisma.InputJsonValue,
    },
  });

  await deps.enqueueJob(resumeJob.kind, {
    ...basePayload,
    book_id: bookId,
    job_id: newJob.id,
  });

  // Audit log
  await deps.auditLogRepo.create({
    data: {
      actor_id: deps.session.user.id,
      action: 'book.resume',
      target_kind: 'book',
      target_id: bookId,
      before_json: {
        status: 'paused_cost',
        cost_status: 'paused',
      } as unknown as Prisma.InputJsonValue,
      after_json: {
        decision: 'continue',
        status: restoredBookStatus,
        cost_status: 'normal',
        resumed_step: resumeJob.kind,
        new_job_id: newJob.id,
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

// ---------------------------------------------------------------------------
// cancel: Book.status='cancelled' + BookLock release
// ---------------------------------------------------------------------------

async function resumeCancel(
  bookId: string,
  deps: ResumePausedBookDeps,
): Promise<void> {
  await deps.bookRepo.update({
    where: { id: bookId },
    data: {
      status: 'cancelled',
      cost_status: 'normal',
    },
  });

  await deps.bookLockRepo.deleteMany({
    where: { book_id: bookId },
  });

  await deps.auditLogRepo.create({
    data: {
      actor_id: deps.session.user.id,
      action: 'book.resume',
      target_kind: 'book',
      target_id: bookId,
      before_json: {
        status: 'paused_cost',
        cost_status: 'paused',
      } as unknown as Prisma.InputJsonValue,
      after_json: {
        decision: 'cancel',
        status: 'cancelled',
        cost_status: 'normal',
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

// ===========================================================================
// cancelJobCore (T-09-02, F-016, docs/05 §4.3.14)
// ===========================================================================

export const CancelJobInputSchema = z.object({
  job_id: z.string().min(1),
});
export type CancelJobInput = z.infer<typeof CancelJobInputSchema>;

// DI types for cancelJob — extend existing interfaces
export interface BookRepoForCancel {
  findUnique(args: {
    where: { id: string };
    select: { id: true; status: true };
  }): Promise<{ id: string; status: string } | null>;
  update(args: {
    where: { id: string };
    data: { status: string };
  }): Promise<{ id: string }>;
}

export interface BookLockRepoForCancel {
  deleteMany(args: { where: { book_id: string } }): Promise<{ count: number }>;
}

export interface CancelJobDeps {
  jobRepo: JobRepoForRetry;
  bookRepo: BookRepoForCancel;
  bookLockRepo: BookLockRepoForCancel;
  auditLogRepo: AuditLogRepoForRetry;
  session: AuthenticatedSession;
}

/** Terminal statuses — a job in these states cannot be cancelled. */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

/**
 * cancelJobCore — cancel a running/queued job.
 *
 * Per docs/05 §4.3.14:
 *  - Set Job.status='cancelled'
 *  - If job has a book_id and is a pipeline job, set Book.status='cancelled'
 *  - Release BookLock if held by this job (deleteMany on book_id)
 *  - Write audit_log action='job.cancel'
 *  - Reject with validation if already terminal (done/failed/cancelled)
 */
export async function cancelJobCore(
  raw: unknown,
  deps: CancelJobDeps,
): Promise<ActionResult<void>> {
  const parsed = CancelJobInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.jobs.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  const { job_id: jobId } = parsed.data;

  try {
    const job = await deps.jobRepo.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        kind: true,
        book_id: true,
        status: true,
        retries: true,
        payload_json: true,
      },
    });

    if (!job) {
      throw new NotFoundError('Job not found', {
        userMessage: messages.jobs.errors.notFound,
        details: { job_id: jobId },
      });
    }

    if (TERMINAL_STATUSES.has(job.status)) {
      throw new ValidationError('Job is already in a terminal state and cannot be cancelled', {
        userMessage: messages.jobs.errors.alreadyTerminal,
        details: { job_id: jobId, status: job.status },
      });
    }

    const priorStatus = job.status;

    // 1. Cancel the job row
    await deps.jobRepo.update({
      where: { id: jobId },
      data: { status: 'cancelled' },
    });

    // 2. If pipeline job with book_id: cancel the book + release BookLock
    const isPipeline = job.book_id !== null && job.kind.startsWith('pipeline.');
    if (isPipeline && job.book_id) {
      const bookId = job.book_id;

      const book = await deps.bookRepo.findUnique({
        where: { id: bookId },
        select: { id: true, status: true },
      });

      // Only update book if not already terminal
      if (book && !TERMINAL_STATUSES.has(book.status) && book.status !== 'paused_cost') {
        await deps.bookRepo.update({
          where: { id: bookId },
          data: { status: 'cancelled' },
        });
      }

      // Release BookLock regardless
      await deps.bookLockRepo.deleteMany({ where: { book_id: bookId } });
    }

    // 3. Audit log
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'job.cancel',
        target_kind: 'job',
        target_id: jobId,
        before_json: {
          job_id: jobId,
          kind: job.kind,
          status: priorStatus,
          book_id: job.book_id,
        } as unknown as Prisma.InputJsonValue,
        after_json: {
          status: 'cancelled',
          book_cancelled: isPipeline,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok(undefined);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.jobs.errors.unknown);
  }
}
