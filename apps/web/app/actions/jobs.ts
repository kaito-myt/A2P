'use server';

/**
 * Jobs Server Actions (T-04-11, T-07-07, F-016/F-046).
 *
 * SA は薄いラッパに留め、業務ロジック (zod 検証 / Job.retries++ /
 * 失敗ステップ判定 / enqueue / audit_log) は `lib/jobs-core.ts` 側。
 *
 * resumePausedBook: docs/05 §4.3.14 — paused_cost 状態の書籍を続行/中止。
 *
 * 仕様根拠: docs/05 §4.3.14, SP-04 §4 T-04-11, SP-07 §4 T-07-07.
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';
import {
  retryJobCore,
  bulkRetryJobsCore,
  resumePausedBookCore,
  cancelJobCore,
  type JobsDeps,
  type RetryJobResult,
  type BulkRetryJobsResult,
  type ResumePausedBookDeps,
  type CancelJobDeps,
} from '@/lib/jobs-core';

async function buildDeps(): Promise<JobsDeps> {
  const session = await getSessionOrThrow();
  return {
    jobRepo: prisma.job,
    chapterRepo: prisma.chapter,
    outlineRepo: prisma.outline,
    auditLogRepo: prisma.auditLog,
    session,
    enqueueJob,
  };
}

async function buildResumeDeps(): Promise<ResumePausedBookDeps> {
  const session = await getSessionOrThrow();
  return {
    bookRepo: prisma.book,
    jobRepo: prisma.job,
    bookLockRepo: prisma.bookLock,
    auditLogRepo: prisma.auditLog,
    session,
    enqueueJob,
  };
}

async function buildCancelDeps(): Promise<CancelJobDeps> {
  const session = await getSessionOrThrow();
  return {
    jobRepo: prisma.job,
    bookRepo: prisma.book,
    bookLockRepo: prisma.bookLock,
    auditLogRepo: prisma.auditLog,
    session,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.jobs.errors.unknown);
}

export async function retryJob(
  input: unknown,
): Promise<ActionResult<RetryJobResult>> {
  let deps: JobsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await retryJobCore(input, deps);
  if (result.ok) {
    revalidatePath('/books');
    revalidatePath('/dashboard');
  }
  return result;
}

// ---------------------------------------------------------------------------
// bulkRetryJobs (T-09-01, F-046, docs/05 §4.3.14)
// ---------------------------------------------------------------------------

export async function bulkRetryJobs(
  input: unknown,
): Promise<ActionResult<BulkRetryJobsResult>> {
  let deps: JobsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await bulkRetryJobsCore(input, deps);
  if (result.ok) {
    revalidatePath('/jobs');
    revalidatePath('/books');
    revalidatePath('/dashboard');
  }
  return result;
}

// ---------------------------------------------------------------------------
// resumePausedBook (T-07-07, F-034/F-046, docs/05 §4.3.14)
// ---------------------------------------------------------------------------

export async function resumePausedBook(
  input: unknown,
): Promise<ActionResult<void>> {
  let deps: ResumePausedBookDeps;
  try {
    deps = await buildResumeDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await resumePausedBookCore(input, deps);
  if (result.ok) {
    revalidatePath('/cost');
    revalidatePath('/books');
    revalidatePath('/dashboard');
  }
  return result;
}

// ---------------------------------------------------------------------------
// cancelJob (T-09-02, F-016, docs/05 §4.3.14)
// ---------------------------------------------------------------------------

export async function cancelJob(
  input: unknown,
): Promise<ActionResult<void>> {
  let deps: CancelJobDeps;
  try {
    deps = await buildCancelDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await cancelJobCore(input, deps);
  if (result.ok) {
    revalidatePath('/jobs');
    revalidatePath('/books');
    revalidatePath('/dashboard');
  }
  return result;
}
