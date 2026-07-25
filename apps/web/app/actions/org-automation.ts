'use server';

/**
 * 経営（AI 組織）自律運用フラグ Server Action。
 *
 * SA は薄いラッパに留め、業務ロジックは `lib/org-automation-core.ts` 側。
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  updateOrgAutomationCore,
  type OrgAutomationDeps,
} from '@/lib/org-automation-core';

export async function updateOrgAutomation(input: unknown): Promise<ActionResult<void>> {
  let deps: OrgAutomationDeps;
  try {
    const session = await getSessionOrThrow();
    deps = {
      appSettingsRepo: prisma.appSettings as unknown as OrgAutomationDeps['appSettingsRepo'],
      auditLogRepo: prisma.auditLog,
      session,
    };
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.orgAutomation.errors.unknown);
  }
  const result = await updateOrgAutomationCore(input, deps);
  if (result.ok) revalidatePath('/org');
  return result;
}
