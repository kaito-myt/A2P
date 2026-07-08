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

  const createMissing = formData.get('create_external') === 'true';

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const rows = await parseKdpWorkbook(buffer);
    const agg = aggregateKdpRoyalties(rows);

    // 外部書籍作成用: 登録先アカウント (最初の active) を一度だけ解決。
    let accountId: string | null = null;
    if (createMissing) {
      const acct = await prisma.account.findFirst({
        where: { status: 'active' },
        orderBy: { created_at: 'asc' },
        select: { id: true },
      });
      accountId = acct?.id ?? null;
    }

    const createdByAsin = new Map<string, string>();
    const res = await importKdpRecordsCore(
      agg,
      {
        bookRepo: prisma.book as unknown as KdpImportDeps['bookRepo'],
        salesRecordRepo: prisma.salesRecord as unknown as KdpImportDeps['salesRecordRepo'],
        createExternalBook: async (rec) => {
          if (!accountId) return null;
          // 同一 ASIN が複数月にまたがる場合、1冊を使い回す (unique asin 制約対策)。
          const cached = createdByAsin.get(rec.asin);
          if (cached) return { id: cached };
          const title = (rec.title.split(/[:：]/)[0]?.trim() || rec.title).slice(0, 200);
          const book = await prisma.book.create({
            data: {
              account_id: accountId,
              title,
              asin: rec.asin,
              // KDP から取り込んだ外部書籍 (本ツール未生成)。
              status: 'external',
              publish_status: 'published',
              prompt_version_ids_json: {},
              model_assignment_snapshot: {},
            },
            select: { id: true },
          });
          createdByAsin.set(rec.asin, book.id);
          return { id: book.id };
        },
      },
      { createMissing },
    );
    if (res.ok) {
      revalidatePath('/sales');
      revalidatePath('/sales/manual');
      revalidatePath('/books');
    }
    return res;
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', 'KDP レポートの解析に失敗しました');
  }
}
