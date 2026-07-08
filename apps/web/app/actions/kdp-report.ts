'use server';

/**
 * F-056 — KDP ダッシュボード XLSX 取込の Server Action。
 * アップロードされた .xlsx をサーバで解析し SalesRecord に upsert する。
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import {
  aggregateKdpRoyalties,
  importKdpRecordsCore,
  parseKdpWorkbook,
  type KdpImportDeps,
  type KdpImportResult,
} from '@/lib/kdp-report-core';

const MAX_BYTES = 5 * 1024 * 1024; // 5MB

export async function importKdpReport(
  formData: FormData,
): Promise<ActionResult<KdpImportResult>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', 'KDP レポートの取込に失敗しました');
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return fail('validation', 'ファイルを選択してください');
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return fail('validation', 'ファイルサイズが不正です（5MB以下の .xlsx）');
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return fail('validation', 'KDP ダッシュボードの .xlsx を選択してください');
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const rows = await parseKdpWorkbook(buffer);
    const agg = aggregateKdpRoyalties(rows);
    const res = await importKdpRecordsCore(agg, {
      bookRepo: prisma.book as unknown as KdpImportDeps['bookRepo'],
      salesRecordRepo: prisma.salesRecord as unknown as KdpImportDeps['salesRecordRepo'],
    });
    if (res.ok) {
      revalidatePath('/sales');
      revalidatePath('/sales/manual');
    }
    return res;
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', 'KDP レポートの解析に失敗しました');
  }
}
