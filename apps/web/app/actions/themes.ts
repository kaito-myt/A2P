'use server';

/**
 * Themes Server Actions (T-03-06 / T-03-07, F-001 / F-017).
 *
 * SA は薄いラッパに留め、業務ロジック (zod 検証 / Job INSERT / enqueue /
 * audit_log / bulk status 遷移) は `lib/themes-core.ts` 側。
 *
 * トランザクション境界: bulk SA は `prisma.$transaction` で tx クライアントを
 * 取得し、core に `runTransaction` deps として注入する (model-assignments-core
 * と同設計)。
 *
 * 仕様根拠: docs/05 §4.3.3.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isA2PError, fail, ok, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';
import {
  acceptThemesAndStageBatchCore,
  bulkDecideThemesCore,
  generateThemesCore,
  type RunTransactionFn,
  type ThemesDeps,
} from '@/lib/themes-core';

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      themeCandidateRepo: tx.themeCandidate,
      auditLogRepo: tx.auditLog,
    }),
  );

async function buildDeps(): Promise<ThemesDeps> {
  const session = await getSessionOrThrow();
  return {
    accountRepo: prisma.account,
    jobRepo: prisma.job,
    auditLogRepo: prisma.auditLog,
    themeCandidateRepo: prisma.themeCandidate,
    runTransaction: realRunTransaction,
    session,
    enqueueJob,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.themes.errors.unknown);
}

export async function generateThemes(
  input: unknown,
): Promise<ActionResult<{ session_id: string; job_id: string }>> {
  let deps: ThemesDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await generateThemesCore(input, deps);
  if (result.ok) revalidatePath('/themes');
  return result;
}

export async function bulkDecideThemes(
  input: unknown,
): Promise<ActionResult<{ updated: number }>> {
  let deps: ThemesDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await bulkDecideThemesCore(input, deps);
  if (result.ok) revalidatePath('/themes');
  return result;
}

export async function acceptThemesAndStageBatch(
  input: unknown,
): Promise<ActionResult<{ staged_count: number; redirect_to: string }>> {
  let deps: ThemesDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await acceptThemesAndStageBatchCore(input, deps);
  if (result.ok) revalidatePath('/themes');
  return result;
}

/**
 * テーマに著者名 / レーベル名 (マスタ) を割り当てる。
 * 空文字 / undefined は「未選択 (null)」として扱う。表紙の著者名等に使用される。
 */
const UpdateThemeNamingSchema = z.object({
  theme_id: z.string().min(1),
  author_name_id: z.string().nullish(),
  label_name_id: z.string().nullish(),
});

export async function updateThemeNaming(input: unknown): Promise<ActionResult<void>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    return authFail(err);
  }
  const parsed = UpdateThemeNamingSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', messages.themes.errors.unknown, parsed.error.flatten());
  }
  try {
    await prisma.themeCandidate.update({
      where: { id: parsed.data.theme_id },
      data: {
        author_name_id: parsed.data.author_name_id ? parsed.data.author_name_id : null,
        label_name_id: parsed.data.label_name_id ? parsed.data.label_name_id : null,
      },
    });
    revalidatePath(`/themes/${parsed.data.theme_id}`);
    revalidatePath('/themes');
    return ok(undefined as void);
  } catch (err) {
    return authFail(err);
  }
}
