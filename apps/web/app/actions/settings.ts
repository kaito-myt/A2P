'use server';

/**
 * Settings Server Actions (T-07-09, S-027).
 *
 * SA は薄いラッパに留め、業務ロジックは `lib/settings-core.ts` 側。
 *
 * 仕様根拠: docs/05 §4.3.15
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  updateSettingsCore,
  type SettingsDeps,
} from '@/lib/settings-core';

async function buildDeps(): Promise<SettingsDeps> {
  const session = await getSessionOrThrow();
  return {
    appSettingsRepo: prisma.appSettings as unknown as SettingsDeps['appSettingsRepo'],
    auditLogRepo: prisma.auditLog,
    session,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.settings.errors.unknown);
}

export async function updateSettings(
  input: unknown,
): Promise<ActionResult<void>> {
  let deps: SettingsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await updateSettingsCore(input, deps);
  if (result.ok) {
    revalidatePath('/settings');
  }
  return result;
}
