'use server';

/**
 * KDP 自動入稿キュー Server Actions (T-08-09, F-041).
 *
 * サーバから直接 KDP へ入稿することはできない (Amazon が入稿の都度インタラクティブな
 * 2FA 再認証を要求するため)。本 SA は `Book.kdp_publish_queued` を立てる/降ろすだけで、
 * 実際の入稿操作はローカルのアシスト出版ツール (`scripts/kdp-publish.mjs`、運営者が
 * 対話的にログインして実行) がキューを拾って行う。
 *
 * SA は薄いラッパに留め、業務ロジックは `lib/kdp-submit-core.ts` 側。
 *
 * 仕様根拠: docs/05 §4.3.16 / packages/db/schema.prisma Book.kdp_publish_queued
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  submitToKdpCore,
  unqueueFromKdpCore,
  type KdpSubmitDeps,
  type SubmitToKdpOutput,
  type UnqueueFromKdpOutput,
} from '@/lib/kdp-submit-core';

async function buildDeps(): Promise<KdpSubmitDeps> {
  const session = await getSessionOrThrow();
  return {
    bookRepo: prisma.book as unknown as KdpSubmitDeps['bookRepo'],
    revisionCommentRepo: prisma.revisionComment as unknown as KdpSubmitDeps['revisionCommentRepo'],
    auditLogRepo: prisma.auditLog,
    session,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.kdpSubmit.errors.unknown);
}

export async function submitToKdp(input: unknown): Promise<ActionResult<SubmitToKdpOutput>> {
  let deps: KdpSubmitDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await submitToKdpCore(input, deps);
  if (result.ok) {
    revalidatePath('/kdp/checklist');
    for (const { book_id } of result.data.queued) {
      revalidatePath(`/kdp/checklist/${book_id}`);
    }
  }
  return result;
}

export async function unqueueFromKdp(input: unknown): Promise<ActionResult<UnqueueFromKdpOutput>> {
  let deps: KdpSubmitDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await unqueueFromKdpCore(input, deps);
  if (result.ok) {
    revalidatePath('/kdp/checklist');
    for (const { book_id } of result.data.unqueued) {
      revalidatePath(`/kdp/checklist/${book_id}`);
    }
  }
  return result;
}
