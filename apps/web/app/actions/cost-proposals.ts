'use server';

/**
 * F-062 — コスト改善提案の承認/却下 Server Actions（薄いラッパ）。
 * 実行ロジックは `lib/cost-proposal-core.ts`。
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  approveCostProposalCore,
  dismissCostProposalCore,
  type CostProposalDeps,
} from '@/lib/cost-proposal-core';

async function buildDeps(): Promise<CostProposalDeps> {
  const session = await getSessionOrThrow();
  return {
    proposalRepo: prisma.costImprovementProposal as unknown as CostProposalDeps['proposalRepo'],
    modelAssignmentRepo: prisma.modelAssignment as unknown as CostProposalDeps['modelAssignmentRepo'],
    appSettingsRepo: prisma.appSettings as unknown as CostProposalDeps['appSettingsRepo'],
    auditLogRepo: prisma.auditLog as unknown as CostProposalDeps['auditLogRepo'],
    session,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.costDashboard.proposals.error);
}

export async function approveCostProposal(input: unknown) {
  let deps: CostProposalDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const res = await approveCostProposalCore(input, deps);
  revalidatePath('/cost');
  return res;
}

export async function dismissCostProposal(input: unknown) {
  let deps: CostProposalDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const res = await dismissCostProposalCore(input, deps);
  revalidatePath('/cost');
  return res;
}
