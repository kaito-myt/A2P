'use server';

/**
 * docs/06 P4 増分2 — 販促アカウント台帳の接続 Server Actions（薄いラッパ）。
 * 検証/暗号化/監査は `lib/promotion-accounts-core.ts`。
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { encryptApiKey, maskApiKey } from '@a2p/crypto';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  connectPromotionAccountCore,
  archivePromotionAccountCore,
  type PromotionAccountsDeps,
} from '@/lib/promotion-accounts-core';

async function buildDeps(): Promise<PromotionAccountsDeps> {
  const session = await getSessionOrThrow();
  return {
    accountRepo: prisma.promotionAccount as unknown as PromotionAccountsDeps['accountRepo'],
    auditLogRepo: prisma.auditLog as unknown as PromotionAccountsDeps['auditLogRepo'],
    session,
    encrypt: (plain) => encryptApiKey(plain),
    mask: (plain) => maskApiKey(plain),
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.org.accounts.error);
}

export async function connectPromotionAccount(input: unknown) {
  let deps: PromotionAccountsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const res = await connectPromotionAccountCore(input, deps);
  if (res.ok) revalidatePath('/org/accounts');
  return res;
}

export async function archivePromotionAccount(input: unknown) {
  let deps: PromotionAccountsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const res = await archivePromotionAccountCore(input, deps);
  if (res.ok) revalidatePath('/org/accounts');
  return res;
}
