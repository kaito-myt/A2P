'use server';

/**
 * RevisionRun Server Actions (T-06-07, F-050).
 *
 * SA は薄いラッパに留め、業務ロジック (zod 検証 / BookLock 排他検査 /
 * コスト推定 / RevisionRun INSERT / enqueue) は `lib/revision-runs-core.ts` 側。
 *
 * 仕様根拠: docs/05 §4.3.8, SP-06 §4 T-06-07.
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';
import {
  createRevisionRunCore,
  rollbackRevisionRunCore,
  type CreateRevisionRunResult,
  type RollbackRevisionRunResult,
  type RevisionRunsDeps,
  type RollbackRevisionRunDeps,
  type RunTransactionFn,
  type RollbackRunTransactionFn,
} from '@/lib/revision-runs-core';

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      commentRepo: tx.revisionComment,
      revisionRunRepo: tx.revisionRun,
      auditLogRepo: tx.auditLog,
    }),
  );

const realRollbackRunTransaction: RollbackRunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      commentRepo: tx.revisionComment,
      chapterRevisionRepo: tx.chapterRevision,
      chapterRepo: tx.chapter,
      bookRepo: tx.book,
      auditLogRepo: tx.auditLog,
    }),
  );

async function buildDeps(): Promise<RevisionRunsDeps> {
  const session = await getSessionOrThrow();
  return {
    commentRepo: prisma.revisionComment,
    bookLockRepo: prisma.bookLock,
    revisionRunRepo: prisma.revisionRun,
    auditLogRepo: prisma.auditLog,
    runTransaction: realRunTransaction,
    session,
    enqueueJob,
  };
}

async function buildRollbackDeps(): Promise<RollbackRevisionRunDeps> {
  const session = await getSessionOrThrow();
  return {
    commentRepo: prisma.revisionComment,
    chapterRevisionRepo: prisma.chapterRevision,
    chapterRepo: prisma.chapter,
    bookRepo: prisma.book,
    auditLogRepo: prisma.auditLog,
    runTransaction: realRollbackRunTransaction,
    session,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.revisionRuns.errors.unknown);
}

export async function createRevisionRun(
  input: unknown,
): Promise<ActionResult<CreateRevisionRunResult>> {
  let deps: RevisionRunsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await createRevisionRunCore(input, deps);
  if (result.ok) {
    revalidatePath('/comments');
    revalidatePath('/books');
    revalidatePath('/dashboard');
    revalidatePath('/revision-runs');
  }
  return result;
}

export async function rollbackRevisionRun(
  input: unknown,
): Promise<ActionResult<RollbackRevisionRunResult>> {
  let deps: RollbackRevisionRunDeps;
  try {
    deps = await buildRollbackDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await rollbackRevisionRunCore(input, deps);
  if (result.ok) {
    revalidatePath('/comments');
    revalidatePath('/books');
    revalidatePath('/dashboard');
    revalidatePath('/revision-runs');
  }
  return result;
}
