'use server';

/**
 * KDP 売上レポート取込 Server Actions (docs/09 §3, T-KS-04)。
 *
 * - previewSalesReport(FormData): アップロードされた xlsx/csv をパース・正規化し、
 *   ASIN→書籍の突合結果 + 合計 + 警告を返す (DB 未反映のプレビュー)。
 * - commitSalesReport(JSON): プレビューで確認した正規化行を sales_records に upsert し、
 *   sales_fetch_runs に手動取込履歴を残す。
 *
 * ジャンル拡張やスクレイプに依存せず、KDP のダウンロードレポートから確実に売上を取り込む。
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { fail, ok, isA2PError, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { parseKdpReportWorkbook } from '@/lib/kdp-sales/parse';
import { normalizeKdpRows, type NormalizedSalesRow } from '@/lib/kdp-sales/normalize';

const YM_RE = /^\d{4}-\d{2}$/;
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB

export interface SalesImportPreviewRow extends NormalizedSalesRow {
  /** 突合できた書籍 (無ければ null = 未知 ASIN) */
  bookId: string | null;
  bookTitle: string | null;
  bookStatus: string | null;
}

export interface SalesImportPreview {
  yearMonth: string;
  rows: SalesImportPreviewRow[];
  totals: { royalty_jpy: number; units_sold: number; kenp_read: number };
  matchedCount: number;
  unknownAsinCount: number;
  /** 円換算できなかった通貨 → 行数 */
  unconvertedCurrencies: Record<string, number>;
  sheetsSeen: string[];
  sheetsParsed: string[];
  detectedHeaders: string[];
  fxUsdJpy: number;
}

/** model_catalog から USD→JPY の代表レートを取得 (無ければ 150 fallback)。 */
async function getFxUsdJpy(): Promise<number> {
  const row = await prisma.modelCatalog.findFirst({
    where: { is_current: true },
    select: { fx_rate_usd_jpy: true },
    orderBy: { fetched_at: 'desc' },
  });
  const v = row ? Number(row.fx_rate_usd_jpy) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 150;
}

export async function previewSalesReport(
  formData: FormData,
): Promise<ActionResult<SalesImportPreview>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unauthorized', '認証が必要です');
  }

  const yearMonth = String(formData.get('year_month') ?? '').trim();
  if (!YM_RE.test(yearMonth)) {
    return fail('validation', '対象年月 (YYYY-MM) を指定してください');
  }
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return fail('validation', 'レポートファイル (xlsx/csv) を選択してください');
  }
  if (file.size > MAX_FILE_BYTES) {
    return fail('validation', 'ファイルが大きすぎます (最大 15MB)');
  }

  let parsed;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    parsed = parseKdpReportWorkbook(buf);
  } catch {
    return fail('parse_error', 'ファイルの読み込みに失敗しました');
  }

  if (parsed.rows.length === 0) {
    return fail(
      'parse_error',
      parsed.sheetsSeen.length === 0
        ? 'ファイルを解釈できませんでした (xlsx/csv 形式か確認してください)'
        : 'レポートから売上行を検出できませんでした (ASIN/ロイヤリティ列を含むKDPレポートか確認してください)',
    );
  }

  const fxUsdJpy = await getFxUsdJpy();
  const norm = normalizeKdpRows(parsed.rows, { fxToJpy: { USD: fxUsdJpy } });

  const asins = norm.rows.map((r) => r.asin);
  const books = await prisma.book.findMany({
    where: { asin: { in: asins } },
    select: { id: true, asin: true, title: true, status: true },
  });
  const bookByAsin = new Map(books.map((b) => [b.asin, b]));

  const rows: SalesImportPreviewRow[] = norm.rows.map((r) => {
    const b = r.asin ? bookByAsin.get(r.asin) : undefined;
    return {
      ...r,
      bookId: b?.id ?? null,
      bookTitle: b?.title ?? null,
      bookStatus: b?.status ?? null,
    };
  });
  const matchedCount = rows.filter((r) => r.bookId).length;

  return ok({
    yearMonth,
    rows,
    totals: norm.totals,
    matchedCount,
    unknownAsinCount: rows.length - matchedCount,
    unconvertedCurrencies: norm.unconvertedCurrencies,
    sheetsSeen: parsed.sheetsSeen,
    sheetsParsed: parsed.sheetsParsed,
    detectedHeaders: parsed.detectedHeaders,
    fxUsdJpy,
  });
}

const CommitSchema = z.object({
  account_id: z.string().min(1),
  year_month: z.string().regex(YM_RE),
  rows: z
    .array(
      z.object({
        asin: z.string().min(1),
        royalty_jpy: z.number().int(),
        units_sold: z.number().int(),
        kenp_read: z.number().int(),
      }),
    )
    .min(1)
    .max(5000),
});

export interface SalesImportCommitResult {
  upserted: number;
  skippedUnknownAsin: number;
  runId: string;
}

export async function commitSalesReport(
  input: unknown,
): Promise<ActionResult<SalesImportCommitResult>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unauthorized', '認証が必要です');
  }

  const parsed = CommitSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', '取込データが不正です', parsed.error.flatten());
  }
  const { account_id, year_month, rows } = parsed.data;

  // 手動取込の実行履歴を作成 (running → done)。
  const run = await prisma.salesFetchRun.create({
    data: { account_id, year_month, status: 'running' },
  });

  const asins = rows.map((r) => r.asin);
  const books = await prisma.book.findMany({
    where: { asin: { in: asins } },
    select: { id: true, asin: true },
  });
  const bookByAsin = new Map(books.map((b) => [b.asin, b.id]));

  let upserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const bookId = bookByAsin.get(r.asin);
    if (!bookId) {
      skipped++;
      continue;
    }
    try {
      await prisma.salesRecord.upsert({
        where: { book_id_year_month: { book_id: bookId, year_month } },
        create: {
          book_id: bookId,
          year_month,
          royalty_jpy: r.royalty_jpy,
          units_sold: r.units_sold,
          kenp_read: r.kenp_read,
          source: 'manual_upload',
        },
        update: {
          royalty_jpy: r.royalty_jpy,
          units_sold: r.units_sold,
          kenp_read: r.kenp_read,
          source: 'manual_upload',
        },
      });
      upserted++;
    } catch {
      // 個別行の失敗はスキップ (全体は継続)
      skipped++;
    }
  }

  await prisma.salesFetchRun.update({
    where: { id: run.id },
    data: {
      status: 'done',
      records_upserted: upserted,
      finished_at: new Date(),
      ...(skipped > 0 ? { error_message: `未突合 ASIN ${skipped} 件をスキップ` } : {}),
    },
  });

  revalidatePath('/sales');
  return ok({ upserted, skippedUnknownAsin: skipped, runId: run.id });
}
