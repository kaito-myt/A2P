'use server';

/**
 * Covers Server Actions (T-05-09, F-019).
 *
 * SA は薄いラッパに留め、業務ロジック (zod 検証 / Cover.status 遷移 /
 * export enqueue / audit_log) は `lib/covers-core.ts` 側。
 *
 * 仕様根拠: docs/05 §4.3.6, SP-05 §4 T-05-09.
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';
import {
  bulkAdoptCoversCore,
  regenerateCoverCore,
  regenerateCoverTextCore,
  type BulkAdoptCoversResult,
  type RegenerateCoverResult,
  type RegenerateCoverTextResult,
  type CoversDeps,
  type RunTransactionFn,
} from '@/lib/covers-core';

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      coverRepo: tx.cover,
      jobRepo: tx.job,
      auditLogRepo: tx.auditLog,
    }),
  );

async function buildDeps(): Promise<CoversDeps> {
  const session = await getSessionOrThrow();
  return {
    coverRepo: prisma.cover,
    bookRepo: prisma.book,
    jobRepo: prisma.job,
    auditLogRepo: prisma.auditLog,
    runTransaction: realRunTransaction,
    session,
    enqueueJob,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.covers.errors.unknown);
}

export async function bulkAdoptCovers(
  input: unknown,
): Promise<ActionResult<BulkAdoptCoversResult>> {
  let deps: CoversDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await bulkAdoptCoversCore(input, deps);
  if (result.ok) {
    revalidatePath('/covers');
    revalidatePath('/books');
    revalidatePath('/dashboard');
  }
  return result;
}

export async function regenerateCover(
  input: unknown,
): Promise<ActionResult<RegenerateCoverResult>> {
  let deps: CoversDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await regenerateCoverCore(input, deps);
  if (result.ok) {
    revalidatePath('/covers');
    revalidatePath('/books');
  }
  return result;
}

export async function regenerateCoverText(
  input: unknown,
): Promise<ActionResult<RegenerateCoverTextResult>> {
  let deps: CoversDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await regenerateCoverTextCore(input, deps);
  if (result.ok) {
    revalidatePath('/covers');
    revalidatePath('/books');
  }
  return result;
}

const COVER_RECHECK_TASK = 'pipeline.book.cover.recheck';

/**
 * recheckBookCovers — 既存カバーの文字崩れを後追い検証し、崩れた候補を
 * 自動再生成する裏側ジョブ (pipeline.book.cover.recheck) を起動する (F-007b)。
 */
export async function recheckBookCovers(
  input: unknown,
): Promise<ActionResult<{ book_id: string; job_id: string }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    return authFail(err);
  }

  const bookId =
    typeof input === 'object' && input !== null && 'book_id' in input
      ? String((input as { book_id: unknown }).book_id)
      : '';
  if (!bookId) return fail('validation', messages.covers.errors.unknown);

  try {
    // 二重起動防止: queued/running の recheck ジョブがあれば再利用。
    const existing = await prisma.job.findFirst({
      where: { book_id: bookId, kind: COVER_RECHECK_TASK, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    let jobId = existing?.id ?? null;
    if (!jobId) {
      const job = await prisma.job.create({
        data: { kind: COVER_RECHECK_TASK, book_id: bookId, status: 'queued', payload_json: { book_id: bookId } },
      });
      jobId = job.id;
      await enqueueJob(COVER_RECHECK_TASK, { book_id: bookId, job_id: jobId });
    }

    revalidatePath('/covers');
    revalidatePath('/books');
    return { ok: true, data: { book_id: bookId, job_id: jobId } };
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.covers.errors.unknown);
  }
}
