'use server';

/**
 * Model Catalog Server Actions (T-02-10, F-024/F-025).
 *
 * UI (S-020) から呼ばれる手動更新 / 手動編集の SA。薄いラッパに留め、
 * 業務ロジック (zod 検証 / DB update / audit_log) は `lib/model-catalog-core.ts`。
 *
 * 仕様根拠: docs/05 §4.3.10.
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';
import {
  editCatalogEntryCore,
  refreshModelCatalogCore,
  type ModelCatalogDeps,
} from '@/lib/model-catalog-core';

async function buildDeps(): Promise<ModelCatalogDeps> {
  const session = await getSessionOrThrow();
  return {
    modelCatalogRepo: prisma.modelCatalog,
    auditLogRepo: prisma.auditLog,
    session,
    enqueueJob,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.modelCatalog.errors.unknown);
}

export async function refreshModelCatalog(
  input?: unknown,
): Promise<ActionResult<{ job_id: string }>> {
  let deps: ModelCatalogDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await refreshModelCatalogCore(input, deps);
  if (result.ok) revalidatePath('/models/catalog');
  return result;
}

export async function editCatalogEntry(input: unknown): Promise<ActionResult<{ id: string }>> {
  let deps: ModelCatalogDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await editCatalogEntryCore(input, deps);
  if (result.ok) revalidatePath('/models/catalog');
  return result;
}
