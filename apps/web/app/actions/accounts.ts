'use server';

/**
 * Account Server Actions (F-044 / S-003 / S-004 / T-01-11)。
 *
 * SA は薄いラッパに留め、業務ロジック (zod 検証 / KDP credentials 暗号化 /
 * audit_log INSERT) は `lib/accounts-core.ts` に切り出す (テスト容易化)。
 *
 * 仕様根拠: docs/05 §4.3.1。
 */
import { revalidatePath } from 'next/cache';
import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { encryptKdpCredentials } from '@a2p/crypto';
import { prisma } from '@a2p/db';
import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  archiveAccountCore,
  createAccountCore,
  updateAccountCore,
  type AccountsDeps,
} from '@/lib/accounts-core';

async function buildDeps(): Promise<AccountsDeps> {
  const session = await getSessionOrThrow();
  return {
    accountRepo: prisma.account,
    auditLogRepo: prisma.auditLog,
    session,
    encrypt: (plaintext) => encryptKdpCredentials(plaintext),
  };
}

/** Auth 失敗等で deps が組めなかった時の共通 fail マッピング。 */
function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.accounts.detail.errors.unknown);
}

export async function createAccount(input: unknown): Promise<ActionResult<{ id: string }>> {
  let deps: AccountsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await createAccountCore(input, deps);
  if (result.ok) {
    revalidatePath('/accounts');
    revalidatePath(`/accounts/${result.data.id}`);
  }
  return result;
}

export async function updateAccount(input: unknown): Promise<ActionResult<void>> {
  let deps: AccountsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await updateAccountCore(input, deps);
  if (result.ok) {
    revalidatePath('/accounts');
    if (input && typeof input === 'object' && 'id' in input && typeof input.id === 'string') {
      revalidatePath(`/accounts/${input.id}`);
    }
  }
  return result;
}

export async function archiveAccount(id: string): Promise<ActionResult<void>> {
  let deps: AccountsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await archiveAccountCore(id, deps);
  if (result.ok) {
    revalidatePath('/accounts');
  }
  return result;
}
