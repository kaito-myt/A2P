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
import { createBatchPlanCore } from '@/lib/batches-core';
import { buildBatchesDeps } from '@/lib/batches-deps';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';
import {
  AcceptThemesAndStageBatchInputSchema,
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
 * 「採用」= テーマ採用 + 夜間バッチ計画を自動作成する 1 本道アクション。
 *
 * 従来は「採用」(status のみ) と「採用してバッチ計画へ」(手動 /batches/new) の
 * 2 ボタンに分かれ、採用しただけの `accepted` テーマがバッチに入らず放置される
 * 事故が起きていた。本アクションで採用と同時に BatchPlan を自動生成し、
 * 夜間ディスパッチャ (batch-plan-dispatcher) が planned_at (既定: 今夜 23:00 JST)
 * に自動キックする。運営者はバッチ画面で確認・前倒しキックできるが、放置しても
 * 今夜書籍生成が走る (手間ゼロ)。
 *
 * フロー:
 *   1. 選択テーマの pending を accepted に遷移 (rejected 混在は弾く)
 *   2. createBatchPlanCore で BatchPlan + BatchPlanItem*N を scheduled 生成
 *   3. `/batches` へ redirect する URL を返す
 */
export async function acceptThemesAndCreateBatch(
  input: unknown,
): Promise<
  ActionResult<{
    batch_id: string;
    item_count: number;
    scheduled_at: string;
    redirect_to: string;
  }>
> {
  // 入力 (theme_ids) を先に検証しておく — 採用/バッチ双方で使う。
  const parsed = AcceptThemesAndStageBatchInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', messages.themes.errors.bulkValidation, parsed.error.flatten());
  }
  const themeIds = parsed.data.theme_ids;

  let themesDeps: ThemesDeps;
  try {
    themesDeps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }

  // 1. 採用遷移 (pending -> accepted)。rejected 混在 / 不在は ValidationError で弾かれる。
  const accepted = await acceptThemesAndStageBatchCore({ theme_ids: themeIds }, themesDeps);
  if (!accepted.ok) return accepted;

  // 2. バッチ計画を自動生成 (concurrency / planned_at は既定値)。
  const batchesDeps = buildBatchesDeps(themesDeps.session);
  const created = await createBatchPlanCore({ themeIds }, batchesDeps);
  if (!created.ok) return created;

  revalidatePath('/themes');
  revalidatePath('/batches');
  return ok({
    batch_id: created.data.batch_id,
    item_count: created.data.item_count,
    scheduled_at: created.data.scheduled_at,
    redirect_to: '/batches',
  });
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
