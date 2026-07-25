'use server';

/**
 * パイプライン設定 Server Action。
 *
 * SA は薄いラッパに留め、業務ロジックは `lib/pipeline-settings-core.ts` 側。
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  updatePipelineSettingsCore,
  type PipelineSettingsDeps,
} from '@/lib/pipeline-settings-core';

export async function updatePipelineSettings(input: unknown): Promise<ActionResult<void>> {
  let deps: PipelineSettingsDeps;
  try {
    const session = await getSessionOrThrow();
    deps = {
      appSettingsRepo: prisma.appSettings as unknown as PipelineSettingsDeps['appSettingsRepo'],
      auditLogRepo: prisma.auditLog,
      session,
    };
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.pipelineSettings.errors.unknown);
  }
  const result = await updatePipelineSettingsCore(input, deps);
  if (result.ok) revalidatePath('/pipeline/settings');
  return result;
}
