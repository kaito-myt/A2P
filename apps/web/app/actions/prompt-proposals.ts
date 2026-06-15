'use server';

/**
 * Prompt Proposals / AB Distribution Server Actions (T-11-04, T-11-06)
 *
 * SA は薄いラッパに留め、業務ロジックは lib/prompt-proposals-core.ts,
 * lib/ab-distribution-core.ts 側。
 *
 * トランザクション境界: decideProposal / rollbackAutoApproved は `prisma.$transaction`
 * で tx クライアントを取得し core に注入する (model-assignments.ts と同設計)。
 * startAbDistribution は単純 upsert のためトランザクション不要。
 *
 * 設計根拠: docs/05 §4.3.12, §4.3.11
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  decideProposalCore,
  rollbackAutoApprovedCore,
  type DecideProposalDeps,
  type RunTransactionFn,
} from '@/lib/prompt-proposals-core';
import {
  startAbDistributionCore,
  type AbDistributionDeps,
} from '@/lib/ab-distribution-core';

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      proposalRepo: {
        findById: (id) => tx.promptProposal.findUnique({ where: { id } }),
        update: ({ where, data }) =>
          tx.promptProposal.update({ where, data: data as Parameters<typeof tx.promptProposal.update>[0]['data'] }),
      },
      promptRepo: {
        findActiveByRoleGenre: ({ role, genre }) =>
          tx.prompt.findFirst({
            where: { role, genre: genre ?? null, status: 'active' },
          }),
        findPreviousVersion: ({ role, genre, currentVersion }) =>
          tx.prompt.findFirst({
            where: {
              role,
              genre: genre ?? null,
              version: { lt: currentVersion },
              status: 'archived',
            },
            orderBy: { version: 'desc' },
          }),
        update: ({ where, data }) =>
          tx.prompt.update({ where, data: data as Parameters<typeof tx.prompt.update>[0]['data'] }),
        create: ({ data }) =>
          tx.prompt.create({ data: data as Parameters<typeof tx.prompt.create>[0]['data'] }),
      },
      auditLogRepo: tx.auditLog,
    }),
  );

async function buildDeps(): Promise<DecideProposalDeps> {
  const session = await getSessionOrThrow();
  return {
    proposalRepo: {
      findById: (id) => prisma.promptProposal.findUnique({ where: { id } }),
      update: ({ where, data }) =>
        prisma.promptProposal.update({ where, data: data as Parameters<typeof prisma.promptProposal.update>[0]['data'] }),
    },
    promptRepo: {
      findActiveByRoleGenre: ({ role, genre }) =>
        prisma.prompt.findFirst({
          where: { role, genre: genre ?? null, status: 'active' },
        }),
      findPreviousVersion: ({ role, genre, currentVersion }) =>
        prisma.prompt.findFirst({
          where: {
            role,
            genre: genre ?? null,
            version: { lt: currentVersion },
            status: 'archived',
          },
          orderBy: { version: 'desc' },
        }),
      update: ({ where, data }) =>
        prisma.prompt.update({ where, data: data as Parameters<typeof prisma.prompt.update>[0]['data'] }),
      create: ({ data }) =>
        prisma.prompt.create({ data: data as Parameters<typeof prisma.prompt.create>[0]['data'] }),
    },
    auditLogRepo: prisma.auditLog,
    session,
    runTransaction: realRunTransaction,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.promptProposals.errors.unknown);
}

export async function decideProposal(
  input: unknown,
): Promise<ActionResult<{ new_prompt_id?: string }>> {
  let deps: DecideProposalDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await decideProposalCore(input, deps);
  if (result.ok) {
    revalidatePath('/prompts');
    revalidatePath('/prompts/proposals');
  }
  return result;
}

export async function rollbackAutoApproved(
  input: unknown,
): Promise<ActionResult<{ new_prompt_id?: string }>> {
  let deps: DecideProposalDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await rollbackAutoApprovedCore(input, deps);
  if (result.ok) {
    revalidatePath('/prompts');
    revalidatePath('/prompts/proposals');
  }
  return result;
}

async function buildAbDistributionDeps(): Promise<AbDistributionDeps> {
  const session = await getSessionOrThrow();
  return {
    appSettingsRepo: prisma.appSettings as unknown as AbDistributionDeps['appSettingsRepo'],
    auditLogRepo: prisma.auditLog,
    session,
  };
}

export async function startAbDistribution(
  input: unknown,
): Promise<ActionResult<void>> {
  let deps: AbDistributionDeps;
  try {
    deps = await buildAbDistributionDeps();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.abDistribution.errors.unknown);
  }
  const result = await startAbDistributionCore(input, deps);
  if (result.ok) {
    revalidatePath('/prompts');
  }
  return result;
}
