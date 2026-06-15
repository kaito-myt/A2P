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
