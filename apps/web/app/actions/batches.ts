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
import { prisma } from '@a2p/db';
import { getMonthlyTotalCost } from '@a2p/db/cost-aggregation';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import {
  createBatchPlanCore,
  kickBatchNowCore,
  type BatchesDeps,
  type CreateBatchPlanResult,
  type CreateBatchPlanTxFn,
  type KickBatchNowResult,
  type KickBatchNowTxFn,
} from '@/lib/batches-core';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';

const realCreateTransaction: CreateBatchPlanTxFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      batchPlanRepo: tx.batchPlan,
      batchPlanItemRepo: tx.batchPlanItem,
      auditLogRepo: tx.auditLog,
    }),
  );

const realKickTransaction: KickBatchNowTxFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      batchPlanRepo: tx.batchPlan,
      batchPlanItemRepo: tx.batchPlanItem,
      jobRepo: tx.job,
      auditLogRepo: tx.auditLog,
    }),
  );

async function buildDeps(): Promise<BatchesDeps> {
  const session = await getSessionOrThrow();
  return {
    themeCandidateRepo: prisma.themeCandidate,
    batchPlanRepo: prisma.batchPlan,
    batchPlanItemRepo: prisma.batchPlanItem,
    jobRepo: prisma.job,
    modelAssignmentRepo: prisma.modelAssignment,
    modelCatalogRepo: prisma.modelCatalog,
    auditLogRepo: prisma.auditLog,
    appSettingsRepo: prisma.appSettings as unknown as BatchesDeps['appSettingsRepo'],
    getMonthlyTotalCostFn: (_prismaArg, year, month) =>
      getMonthlyTotalCost(prisma, year, month),
    session,
    runCreateTransaction: realCreateTransaction,
    runKickTransaction: realKickTransaction,
    enqueueJob,
  };
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
