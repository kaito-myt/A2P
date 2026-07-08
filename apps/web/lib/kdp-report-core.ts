/**
 * F-056 — KDP ダッシュボード XLSX (実物レポート) の取込。
 *
 * KDP の「電子書籍のロイヤリティ」シートを読み、(ASIN, 年月) ごとに JPY ロイヤリティを
 * 合算して SalesRecord に upsert する。列はヘッダ名で解決 (列順に依存しない)。
 * 非 JPY 通貨の行は集計から除外し件数を返す (単一 JP アカウント運用を前提)。
 */
import { fail, ok, type ActionResult } from '@a2p/contracts';

/** KDP ロイヤリティシートのヘッダ名。 */
const H = {
  date: 'ロイヤリティ発生日',
  title: 'タイトル',
  asin: 'ASIN',
  royalty: 'ロイヤリティ',
  currency: '通貨',
  netOrders: '実質注文数',
} as const;

export interface KdpRoyaltyRecord {
  asin: string;
  title: string;
  year_month: string; // YYYY-MM
  royalty_jpy: number; // 整数に丸めた合算値
}

export interface KdpAggregateResult {
  records: KdpRoyaltyRecord[];
  /** 非 JPY 通貨のため除外した行数。 */
  skippedNonJpy: number;
  /** ASIN/日付/金額が欠けて集計できなかった行数。 */
  skippedInvalid: number;
  parsedRows: number;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,¥\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 日付セル (文字列 'YYYY-MM-DD' or Date or Excel シリアル) → 'YYYY-MM'。 */
function toYearMonth(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (typeof v === 'string') {
    const m = v.match(/(\d{4})[-/](\d{1,2})/);
    if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}`;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel シリアル日付 (1900 系)。25569 = 1970-01-01。
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
  }
  return null;
}

/**
 * KDP ロイヤリティ行 (ヘッダ名キーのオブジェクト配列) を (ASIN, 年月) で合算する純関数。
 */
export function aggregateKdpRoyalties(rawRows: Array<Record<string, unknown>>): KdpAggregateResult {
  const byKey = new Map<string, KdpRoyaltyRecord>();
  let skippedNonJpy = 0;
  let skippedInvalid = 0;

  for (const row of rawRows) {
    const asin = String(row[H.asin] ?? '').trim();
    const ym = toYearMonth(row[H.date]);
    const royalty = toNum(row[H.royalty]);
    const currency = String(row[H.currency] ?? '').trim().toUpperCase();

    if (!asin || !ym || royalty === null) {
      skippedInvalid += 1;
      continue;
    }
    if (currency && currency !== 'JPY') {
      skippedNonJpy += 1;
      continue;
    }

    const key = `${asin}|${ym}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.royalty_jpy += royalty;
    } else {
      byKey.set(key, {
        asin,
        title: String(row[H.title] ?? '').trim(),
        year_month: ym,
        royalty_jpy: royalty,
      });
    }
  }

  const records = [...byKey.values()].map((r) => ({ ...r, royalty_jpy: Math.round(r.royalty_jpy) }));
  return { records, skippedNonJpy, skippedInvalid, parsedRows: rawRows.length };
}

/**
 * XLSX バッファから「電子書籍のロイヤリティ」シートのヘッダ名キー行配列を得る。
 * SheetJS を遅延 import (テストでは aggregateKdpRoyalties を直接使う)。
 */
export async function parseKdpWorkbook(buffer: Buffer | ArrayBuffer): Promise<Array<Record<string, unknown>>> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  // シート名で優先解決 → 無ければ ASIN と ロイヤリティ 両列を持つシートを探す。
  const preferred = wb.SheetNames.find((n) => n.includes('電子書籍のロイヤリティ'))
    ?? wb.SheetNames.find((n) => n.includes('ロイヤリティ') && !n.includes('概要'));

  const candidates = preferred ? [preferred] : wb.SheetNames;
  for (const name of candidates) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null }) as Array<Record<string, unknown>>;
    if (rows.length > 0 && H.asin in rows[0]! && H.royalty in rows[0]!) {
      return rows;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// 取込 (SalesRecord upsert) — DI 可能なコア
// ---------------------------------------------------------------------------

export interface KdpImportDeps {
  bookRepo: {
    findFirst: (args: {
      where: { asin?: string; title?: string };
      select: { id: true; title: true };
    }) => Promise<{ id: string; title: string } | null>;
  };
  /** 未登録 ASIN を「外部書籍」として登録するための作成関数 (opts.createMissing 時のみ使用)。 */
  createExternalBook?: (rec: KdpRoyaltyRecord) => Promise<{ id: string } | null>;
  salesRecordRepo: {
    findUnique: (args: {
      where: { book_id_year_month: { book_id: string; year_month: string } };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
    upsert: (args: {
      where: { book_id_year_month: { book_id: string; year_month: string } };
      create: { book_id: string; year_month: string; royalty_jpy: number; review_count: number; source: string };
      update: { royalty_jpy: number; source: string };
    }) => Promise<unknown>;
  };
}

export interface KdpImportResult {
  inserted: number;
  updated: number;
  /** 外部書籍として新規登録した冊数。 */
  createdExternal: number;
  /** 該当書籍 (ASIN) が見つからず取り込めなかったレコード。 */
  notFound: Array<{ asin: string; title: string; year_month: string; royalty_jpy: number }>;
  skippedNonJpy: number;
  skippedInvalid: number;
  parsedRows: number;
}

export async function importKdpRecordsCore(
  agg: KdpAggregateResult,
  deps: KdpImportDeps,
  opts: { createMissing?: boolean } = {},
): Promise<ActionResult<KdpImportResult>> {
  if (agg.records.length === 0 && agg.parsedRows === 0) {
    return fail('validation', 'ロイヤリティ行が見つかりませんでした（KDP ダッシュボードの xlsx か確認してください）');
  }

  let inserted = 0;
  let updated = 0;
  let createdExternal = 0;
  const notFound: KdpImportResult['notFound'] = [];

  for (const rec of agg.records) {
    // 1. ASIN 一致 → 2. タイトル完全一致 → 3. 主題(コロン前)一致 の順で書籍を解決。
    let book: { id: string; title?: string } | null =
      await deps.bookRepo.findFirst({ where: { asin: rec.asin }, select: { id: true, title: true } });
    if (!book && rec.title) {
      book = await deps.bookRepo.findFirst({ where: { title: rec.title }, select: { id: true, title: true } });
    }
    if (!book && rec.title) {
      const main = rec.title.split(/[:：]/)[0]!.trim();
      if (main && main !== rec.title) {
        book = await deps.bookRepo.findFirst({ where: { title: main }, select: { id: true, title: true } });
      }
    }
    // 未登録 → opts.createMissing なら外部書籍として登録。
    if (!book && opts.createMissing && deps.createExternalBook) {
      const created = await deps.createExternalBook(rec);
      if (created) {
        book = created;
        createdExternal += 1;
      }
    }
    if (!book) {
      notFound.push(rec);
      continue;
    }
    const existing = await deps.salesRecordRepo.findUnique({
      where: { book_id_year_month: { book_id: book.id, year_month: rec.year_month } },
      select: { id: true },
    });
    await deps.salesRecordRepo.upsert({
      where: { book_id_year_month: { book_id: book.id, year_month: rec.year_month } },
      create: { book_id: book.id, year_month: rec.year_month, royalty_jpy: rec.royalty_jpy, review_count: 0, source: 'manual' },
      update: { royalty_jpy: rec.royalty_jpy, source: 'manual' },
    });
    if (existing) updated += 1;
    else inserted += 1;
  }

  return ok({
    inserted,
    updated,
    createdExternal,
    notFound,
    skippedNonJpy: agg.skippedNonJpy,
    skippedInvalid: agg.skippedInvalid,
    parsedRows: agg.parsedRows,
  });
}
