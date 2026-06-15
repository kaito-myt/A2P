'use server';

/**
 * Model Assignment Server Actions (T-02-11, F-022/F-023).
 *
 * UI (S-019) から呼ばれる upsert / revert SA。薄いラッパに留め、業務ロジック
 * (zod 検証 / DB update / audit_log) は `lib/model-assignments-core.ts` 側。
 *
 * トランザクション境界: `prisma.$transaction` で tx クライアントを取得し、
 * core に `runTransaction` deps として注入する (model-catalog-core.ts と同設計)。
 *
 * 仕様根拠: docs/05 §4.3.9.
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  revertModelAssignmentCore,
  upsertModelAssignmentCore,
  type ModelAssignmentsDeps,
  type RunTransactionFn,
} from '@/lib/model-assignments-core';

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      modelAssignmentRepo: tx.modelAssignment,
      auditLogRepo: tx.auditLog,
    }),
  );

async function buildDeps(): Promise<ModelAssignmentsDeps> {
  const session = await getSessionOrThrow();
  return {
    modelAssignmentRepo: prisma.modelAssignment,
    modelCatalogRepo: prisma.modelCatalog,
    auditLogRepo: prisma.auditLog,
    session,
    runTransaction: realRunTransaction,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.modelAssignments.errors.unknown);
}

export async function upsertModelAssignment(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  let deps: ModelAssignmentsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await upsertModelAssignmentCore(input, deps);
  if (result.ok) revalidatePath('/models/assignments');
  return result;
}

export async function revertModelAssignment(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  let deps: ModelAssignmentsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await revertModelAssignmentCore(input, deps);
  if (result.ok) revalidatePath('/models/assignments');
  return result;
}
