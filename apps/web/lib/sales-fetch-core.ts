/**
 * triggerSalesFetch SA のコアロジック (T-12-06, F-038).
 *
 * `app/actions/sales.ts` (SA ラッパ) から呼ばれる業務ロジック。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする。
 *
 * 仕様根拠: docs/05 §4.3.13 / docs/02 F-038 / SP-12 T-12-06
 */
import { z } from 'zod';

import { isA2PError, fail, ok, type ActionResult } from '@a2p/contracts';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

export const TriggerSalesFetchInputSchema = z.object({
  account_id: z.string().min(1, '必須項目です'),
  year_month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'YYYY-MM 形式で入力してください')
    .optional(),
});

export type TriggerSalesFetchInput = z.infer<typeof TriggerSalesFetchInputSchema>;

// ---------------------------------------------------------------------------
// 結果型
// ---------------------------------------------------------------------------

export interface TriggerSalesFetchResult {
  job_id: string;
  run_id: string;
}

// ---------------------------------------------------------------------------
// DI 境界
// ---------------------------------------------------------------------------

export interface SalesFetchRunRepo {
  create(args: {
    data: { account_id: string; year_month: string; status: string };
  }): Promise<{ id: string }>;
}

export interface SalesFetchEnqueueFn {
  (
    taskName: string,
    payload: unknown,
    spec: { jobKey?: string },
  ): Promise<string>;
}

export interface TriggerSalesFetchDeps {
  salesFetchRunRepo: SalesFetchRunRepo;
  enqueueJob: SalesFetchEnqueueFn;
  session: AuthenticatedSession;
  /** 「今」を固定（テスト用） */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// 当月 YYYY-MM を生成するユーティリティ
// ---------------------------------------------------------------------------

export function currentYearMonth(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ---------------------------------------------------------------------------
// コアロジック
// ---------------------------------------------------------------------------

/**
 * sales.fetch ジョブを手動で起動する。
 *
 * - year_month 省略時は当月
 * - jobKey でアカウント+年月単位の重複防止
 */
export async function triggerSalesFetchCore(
  rawInput: unknown,
  deps: TriggerSalesFetchDeps,
): Promise<ActionResult<TriggerSalesFetchResult>> {
  // zod parse
  const parsed = TriggerSalesFetchInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail('validation', messages.salesFetch.errors.validation, {
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
  }

  const { account_id } = parsed.data;
  const now = deps.now?.() ?? new Date();
  const year_month = parsed.data.year_month ?? currentYearMonth(now);

  // SalesFetchRun INSERT (status=running)
  let run: { id: string };
  try {
    run = await deps.salesFetchRunRepo.create({
      data: { account_id, year_month, status: 'running' },
    });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.salesFetch.errors.unknown);
  }

  // addJob with jobKey for deduplication
  const jobKey = `sales-fetch-${account_id}-${year_month}`;
  let job_id: string;
  try {
    job_id = await deps.enqueueJob(
      'sales.fetch',
      { account_id, year_month },
      { jobKey },
    );
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.salesFetch.errors.enqueueFailed);
  }

  return ok({ job_id, run_id: run.id });
}
