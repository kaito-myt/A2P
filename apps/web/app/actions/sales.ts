'use server';

/**
 * 売上 Server Actions (T-08-05, F-037, T-12-06).
 *
 * SA は薄いラッパに留め、業務ロジックは `lib/sales-core.ts` / `lib/sales-fetch-core.ts` 側。
 *
 * 仕様根拠: docs/05 §4.3.13, SP-12 T-12-06
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  upsertSalesCore,
  importSalesCsvCore,
  type SalesDeps,
  type ImportSalesCsvResult,
} from '@/lib/sales-core';
import {
  triggerSalesFetchCore,
  type TriggerSalesFetchResult,
} from '@/lib/sales-fetch-core';
import { enqueueJob } from '@/lib/graphile-client';

async function buildDeps(): Promise<SalesDeps> {
  const session = await getSessionOrThrow();
  return {
    salesRecordRepo: prisma.salesRecord as unknown as SalesDeps['salesRecordRepo'],
    bookRepo: prisma.book as unknown as SalesDeps['bookRepo'],
    auditLogRepo: prisma.auditLog,
    session,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.sales.errors.unknown);
}

export async function upsertSales(
  input: unknown,
): Promise<ActionResult<void>> {
  let deps: SalesDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await upsertSalesCore(input, deps);
  if (result.ok) {
    revalidatePath('/sales');
  }
  return result;
}

export async function importSalesCsv(
  input: unknown,
): Promise<ActionResult<ImportSalesCsvResult>> {
  let deps: SalesDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await importSalesCsvCore(input, deps);
  if (result.ok) {
    revalidatePath('/sales');
  }
  return result;
}

/**
 * sales.fetch ジョブを手動で起動する [F-038 S-017].
 *
 * - year_month 省略時は当月
 * - jobKey でアカウント+年月単位の重複防止
 */
export async function triggerSalesFetch(
  input: unknown,
): Promise<ActionResult<TriggerSalesFetchResult>> {
  let session: Awaited<ReturnType<typeof getSessionOrThrow>>;
  try {
    session = await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.salesFetch.errors.unknown);
  }

  const result = await triggerSalesFetchCore(input, {
    salesFetchRunRepo: prisma.salesFetchRun,
    enqueueJob,
    session,
  });

  if (result.ok) {
    revalidatePath('/sales');
  }

  return result;
}
