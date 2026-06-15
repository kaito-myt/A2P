'use server';

/**
 * Outlines Server Actions (T-04-07, F-018).
 *
 * SA は薄いラッパに留め、業務ロジック (zod 検証 / Outline.status 遷移 /
 * Book.status='running' / Job INSERT / enqueue / audit_log / per-row エラー収集)
 * は `lib/outlines-core.ts` 側。
 *
 * トランザクション境界 (themes-core / batches-core と同設計):
 *   - bulkApproveOutlines: outline 更新 + book.status='running' + job INSERT + audit を 1 tx
 *     (enqueue は tx 外、失敗は failed_items に収集)
 *   - bulkRejectOutlines:  outline 更新 (status=rejected + reject_note) + job INSERT + audit を 1 tx
 *
 * 仕様根拠: docs/05 §4.3.5, SP-04 §4 T-04-07.
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';
import {
  bulkApproveOutlinesCore,
  bulkRejectOutlinesCore,
  type BulkApproveOutlinesResult,
  type BulkRejectOutlinesResult,
  type OutlinesDeps,
  type RunTransactionFn,
} from '@/lib/outlines-core';

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      outlineRepo: tx.outline,
      bookRepo: tx.book,
      jobRepo: tx.job,
      auditLogRepo: tx.auditLog,
    }),
  );

async function buildDeps(): Promise<OutlinesDeps> {
  const session = await getSessionOrThrow();
  return {
    outlineRepo: prisma.outline,
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
  return fail('unknown', messages.outlines.errors.bulkApproveUnknown);
}

export async function bulkApproveOutlines(
  input: unknown,
): Promise<ActionResult<BulkApproveOutlinesResult>> {
  let deps: OutlinesDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await bulkApproveOutlinesCore(input, deps);
  if (result.ok) {
    revalidatePath('/outlines');
    revalidatePath('/books');
    revalidatePath('/dashboard');
  }
  return result;
}

export async function bulkRejectOutlines(
  input: unknown,
): Promise<ActionResult<BulkRejectOutlinesResult>> {
  let deps: OutlinesDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await bulkRejectOutlinesCore(input, deps);
  if (result.ok) {
    revalidatePath('/outlines');
    revalidatePath('/books');
  }
  return result;
}
