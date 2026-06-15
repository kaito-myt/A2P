'use server';

/**
 * Alerts Server Actions (T-07-08, S-028, F-024/F-034/F-036).
 *
 * SA は薄いラッパに留め、業務ロジックは `lib/alerts-core.ts` 側。
 *
 * 仕様根拠: docs/05 §4.3.17
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  markAlertsCore,
  type AlertsDeps,
  type MarkAlertsResult,
} from '@/lib/alerts-core';

async function buildDeps(): Promise<AlertsDeps> {
  const session = await getSessionOrThrow();
  return {
    alertRepo: prisma.alert,
    session,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.alerts.errors.unknown);
}

export async function markAlerts(
  input: unknown,
): Promise<ActionResult<MarkAlertsResult>> {
  let deps: AlertsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await markAlertsCore(input, deps);
  if (result.ok) {
    revalidatePath('/alerts');
    revalidatePath('/dashboard');
  }
  return result;
}
