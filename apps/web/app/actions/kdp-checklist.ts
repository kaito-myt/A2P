'use server';

/**
 * KDP 入稿チェックリスト Server Actions (T-08-04, S-015).
 *
 * SA は薄いラッパに留め、業務ロジックは `lib/kdp-checklist-core.ts` 側。
 *
 * 仕様根拠: docs/05 §4.3.16
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  updateChecklistCore,
  type ChecklistDeps,
} from '@/lib/kdp-checklist-core';

async function buildDeps(): Promise<ChecklistDeps> {
  const session = await getSessionOrThrow();
  return {
    kdpSubmissionProgressRepo: prisma.kdpSubmissionProgress as unknown as ChecklistDeps['kdpSubmissionProgressRepo'],
    bookRepo: prisma.book as unknown as ChecklistDeps['bookRepo'],
    session,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.kdpChecklist.errors.unknown);
}

export async function updateChecklist(
  input: unknown,
): Promise<ActionResult<void>> {
  let deps: ChecklistDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await updateChecklistCore(input, deps);
  if (result.ok) {
    revalidatePath('/kdp/checklist');
  }
  return result;
}
