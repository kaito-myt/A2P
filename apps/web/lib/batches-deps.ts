/**
 * Batches Server Action 用の DI (BatchesDeps) 構築を共有化するモジュール。
 *
 * `app/actions/batches.ts` と `app/actions/themes.ts` (採用→自動バッチ作成) の
 * 双方から使う。'use server' ファイルからは非アクションを export できないため、
 * 依存ビルダーはこの通常 lib モジュールに置く。
 */
import { prisma } from '@a2p/db';
import { getMonthlyTotalCost } from '@a2p/db/cost-aggregation';

import type { AuthenticatedSession } from './auth-helpers';
import {
  type BatchesDeps,
  type CreateBatchPlanTxFn,
  type KickBatchNowTxFn,
} from './batches-core';
import { enqueueJob } from './graphile-client';

export const realCreateTransaction: CreateBatchPlanTxFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      batchPlanRepo: tx.batchPlan,
      batchPlanItemRepo: tx.batchPlanItem,
      auditLogRepo: tx.auditLog,
    }),
  );

export const realKickTransaction: KickBatchNowTxFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      batchPlanRepo: tx.batchPlan,
      batchPlanItemRepo: tx.batchPlanItem,
      jobRepo: tx.job,
      auditLogRepo: tx.auditLog,
    }),
  );

/** 認証済みセッションを受け取り BatchesDeps を組み立てる (本番配線)。 */
export function buildBatchesDeps(session: AuthenticatedSession): BatchesDeps {
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
