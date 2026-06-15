'use server';

/**
 * plans Server Actions (T-08-02, F-002).
 *
 * SA は薄いラッパに留め、業務ロジックは `lib/plans-core.ts` 側。
 *
 * 仕様根拠: docs/05 §4.3.2.
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';
import { generatePlan } from '@a2p/agents/marketer/plan';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import { regeneratePlanCore, type PlansDeps } from '@/lib/plans-core';

async function buildDeps(): Promise<PlansDeps> {
  const session = await getSessionOrThrow();

  return {
    accountRepo: prisma.account,
    bookRepo: prisma.book as unknown as PlansDeps['bookRepo'],
    salesRecordRepo: prisma.salesRecord as unknown as PlansDeps['salesRecordRepo'],
    publishingPlanRepo: prisma.publishingPlan,
    auditLogRepo: prisma.auditLog,
    generatePlan,
    session,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.plans.errors.unknown);
}

export async function regeneratePlan(
  input: unknown,
): Promise<ActionResult<{ plan_id: string }>> {
  let deps: PlansDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await regeneratePlanCore(input, deps);
  if (result.ok) {
    const raw = input as Record<string, unknown>;
    const accountId = typeof raw?.account_id === 'string' ? raw.account_id : null;
    if (accountId) revalidatePath(`/accounts/${accountId}/plans`);
  }
  return result;
}
