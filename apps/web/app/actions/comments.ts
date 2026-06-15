'use server';

/**
 * Comments Server Actions (T-06-01, F-049).
 *
 * SA は薄いラッパに留め、業務ロジック (zod 検証 / RevisionComment CRUD /
 * Book フラグ再計算 / audit_log) は `lib/comments-core.ts` 側。
 *
 * 仕様根拠: docs/05 §4.3.7, SP-06 §4 T-06-01.
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  createCommentCore,
  updateCommentCore,
  deleteCommentCore,
  bulkChangePriorityCore,
  type CreateCommentResult,
  type BulkChangePriorityResult,
  type CommentsDeps,
  type RunTransactionFn,
} from '@/lib/comments-core';

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      commentRepo: tx.revisionComment,
      bookRepo: tx.book,
      auditLogRepo: tx.auditLog,
    }),
  );

async function buildDeps(): Promise<CommentsDeps> {
  const session = await getSessionOrThrow();
  return {
    commentRepo: prisma.revisionComment,
    bookRepo: prisma.book,
    auditLogRepo: prisma.auditLog,
    runTransaction: realRunTransaction,
    session,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.comments.errors.unknown);
}

export async function createComment(
  input: unknown,
): Promise<ActionResult<CreateCommentResult>> {
  let deps: CommentsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await createCommentCore(input, deps);
  if (result.ok) {
    revalidatePath('/books');
    revalidatePath('/comments');
    revalidatePath('/dashboard');
  }
  return result;
}

export async function updateComment(
  input: unknown,
): Promise<ActionResult<void>> {
  let deps: CommentsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await updateCommentCore(input, deps);
  if (result.ok) {
    revalidatePath('/books');
    revalidatePath('/comments');
  }
  return result;
}

export async function deleteComment(
  input: unknown,
): Promise<ActionResult<void>> {
  let deps: CommentsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await deleteCommentCore(input, deps);
  if (result.ok) {
    revalidatePath('/books');
    revalidatePath('/comments');
    revalidatePath('/dashboard');
  }
  return result;
}

export async function bulkChangePriority(
  input: unknown,
): Promise<ActionResult<BulkChangePriorityResult>> {
  let deps: CommentsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await bulkChangePriorityCore(input, deps);
  if (result.ok) {
    revalidatePath('/books');
    revalidatePath('/comments');
    revalidatePath('/dashboard');
  }
  return result;
}
