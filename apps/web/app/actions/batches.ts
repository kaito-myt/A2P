'use server';

/**
 * Batches Server Actions (T-03-09, F-010 / F-021).
 *
 * SA は薄いラッパに留め、業務ロジック (zod 検証 / BatchPlan INSERT / Job INSERT /
 * enqueueJob / audit_log) は `lib/batches-core.ts` 側。
 *
 * トランザクション境界:
 *  - createBatchPlan: BatchPlan + BatchPlanItem * N + audit_log を 1 tx で実行
 *  - kickBatchNow: per-item tx で Job INSERT → enqueue → BatchPlanItem.kicked、
 *    最終に BatchPlan.running + audit_log を 1 tx で実行
 *
 * 仕様根拠: docs/05 §4.3.4.
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import {
  createBatchPlanCore,
  kickBatchNowCore,
  type BatchesDeps,
  type CreateBatchPlanResult,
  type KickBatchNowResult,
} from '@/lib/batches-core';
import { buildBatchesDeps } from '@/lib/batches-deps';
import { messages } from '@/lib/messages';

async function buildDeps(): Promise<BatchesDeps> {
  const session = await getSessionOrThrow();
  return buildBatchesDeps(session);
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.batches.errors.unknown);
}

export async function createBatchPlan(
  input: unknown,
): Promise<ActionResult<CreateBatchPlanResult>> {
  let deps: BatchesDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await createBatchPlanCore(input, deps);
  if (result.ok) {
    revalidatePath('/batches');
    revalidatePath('/batches/new');
  }
  return result;
}

export async function kickBatchNow(
  input: unknown,
): Promise<ActionResult<KickBatchNowResult>> {
  let deps: BatchesDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await kickBatchNowCore(input, deps);
  if (result.ok) {
    revalidatePath('/batches');
    revalidatePath('/dashboard');
  }
  return result;
}
