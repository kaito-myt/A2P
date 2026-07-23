/**
 * KDP レポート (xlsx/csv) パーサ (docs/09 §3.1, T-KS-02)。
 *
 * SheetJS(xlsx) で全シートを走査し、ヘッダ行を検出して列をマッピングし、
 * (ASIN / タイトル / マーケットプレイス / 通貨 / 販売数 / KENP / ロイヤリティ) を抽出する。
 * KDP のレポート種別・言語(EN/JA)によるヘッダ表記ゆれに耐えるよう、ヘッダ名の
 * 正規化 + エイリアス一致で列を特定する。throw せず、取れた行だけ返す。
 */
import * as XLSX from 'xlsx';

import type { KdpReportRow } from './normalize';

export interface ParseResult {
  rows: KdpReportRow[];
  /** 走査したシート名 */
  sheetsSeen: string[];
  /** ヘッダを検出できたシート名 */
  sheetsParsed: string[];
  /** デバッグ用: 検出したヘッダの例 (先頭シート) */
  detectedHeaders: string[];
}

type ColumnKey = 'asin' | 'title' | 'marketplace' | 'currency' | 'units_sold' | 'kenp_read' | 'royalty';

/** ヘッダ正規化: 小文字化 + 空白/記号/かっこ除去 (日本語はそのまま残す)。 */
function normHeader(h: unknown): string {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[\s_\-/()（）［］\[\].,:：]/g, '')
    .trim();
}

/** 正規化済みヘッダが、そのキーのエイリアスに一致/部分一致するか。 */
const HEADER_MATCHERS: Record<ColumnKey, (h: string) => boolean> = {
  asin: (h) => h === 'asin' || h === 'asinisbn' || h === 'isbn',
  title: (h) => h === 'title' || h === 'タイトル' || h === '書名' || h === '本のタイトル',
  marketplace: (h) => h.includes('marketplace') || h.includes('マーケットプレイス') || h === 'マーケット' || h === 'store',
  currency: (h) => h === 'currency' || h === '通貨' || h === 'currencycode',
  // KENP を units より先に判定する (「kenpread」等が units 判定に吸われないよう normalize 側で順序管理)
  kenp_read: (h) =>
    h.includes('kenp') ||
    h.includes('kindleeditionnormalizedpages') ||
    h.includes('既読') ||
    h.includes('ページ既読') ||
    h.includes('normalizedpagesread'),
  units_sold: (h) =>
    h === 'unitssold' ||
    h === 'netunitssold' ||
    h === 'netunits' ||
    h === '販売部数' ||
    h === '正味販売部数' ||
    h === '販売数' ||
    h === '注文数' ||
    h === '注文',
  royalty: (h) => h.includes('royalty') || h.includes('ロイヤリティ') || h.includes('ロイヤルティ'),
};

/** 数値パース: ¥ $ , スペース 全角 を除去して Number 化。空/不正は 0。 */
function parseNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '')
    .replace(/[¥$€£,\s]/g, '')
    .replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)); // 全角→半角
  if (s === '' || s === '-') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** ASIN らしさ (B0 で始まる 10 桁英数、または 10 桁英数)。緩め。 */
function looksLikeAsin(v: unknown): boolean {
  const s = String(v ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(s);
}

/**
 * 1 シートの行列 (array-of-arrays) からヘッダ行 index と列マップを検出する。
 * ヘッダ行 = ASIN と (royalty または units または kenp) の両方のエイリアスを含む最初の行。
 */
function detectColumns(
  matrix: unknown[][],
): { headerRow: number; map: Partial<Record<ColumnKey, number>>; headers: string[] } | null {
  const scan = Math.min(matrix.length, 30); // ヘッダは通常先頭付近
  for (let r = 0; r < scan; r++) {
    const cells = matrix[r] ?? [];
    const map: Partial<Record<ColumnKey, number>> = {};
    cells.forEach((cell, ci) => {
      const h = normHeader(cell);
      if (!h) return;
      // KENP を units より優先 (同一セルで両方マッチすることは稀だが順序を固定)
      if (HEADER_MATCHERS.asin(h) && map.asin === undefined) map.asin = ci;
      else if (HEADER_MATCHERS.kenp_read(h) && map.kenp_read === undefined) map.kenp_read = ci;
      else if (HEADER_MATCHERS.units_sold(h) && map.units_sold === undefined) map.units_sold = ci;
      else if (HEADER_MATCHERS.royalty(h) && map.royalty === undefined) map.royalty = ci;
      else if (HEADER_MATCHERS.currency(h) && map.currency === undefined) map.currency = ci;
      else if (HEADER_MATCHERS.marketplace(h) && map.marketplace === undefined) map.marketplace = ci;
      else if (HEADER_MATCHERS.title(h) && map.title === undefined) map.title = ci;
    });
    const hasData = map.royalty !== undefined || map.units_sold !== undefined || map.kenp_read !== undefined;
    if (map.asin !== undefined && hasData) {
      return { headerRow: r, map, headers: cells.map((c) => String(c ?? '')) };
    }
  }
  return null;
}

export function parseKdpReportWorkbook(buffer: Buffer | ArrayBuffer): ParseResult {
  const rows: KdpReportRow[] = [];
  const sheetsSeen: string[] = [];
  const sheetsParsed: string[] = [];
  let detectedHeaders: string[] = [];

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    return { rows, sheetsSeen, sheetsParsed, detectedHeaders };
  }

  for (const sheetName of wb.SheetNames) {
    sheetsSeen.push(sheetName);
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: null,
    });
    const detected = detectColumns(matrix);
    if (!detected) continue;
    sheetsParsed.push(sheetName);
    if (detectedHeaders.length === 0) detectedHeaders = detected.headers.filter(Boolean);

    const { headerRow, map } = detected;
    for (let r = headerRow + 1; r < matrix.length; r++) {
      const cells = matrix[r] ?? [];
      const asinRaw = map.asin !== undefined ? cells[map.asin] : null;
      const asin = String(asinRaw ?? '').trim().toUpperCase();
      // ASIN 列があってもフッタ/合計行など ASIN でない行はスキップ。
      if (!asin || !looksLikeAsin(asin)) continue;

      const units = map.units_sold !== undefined ? parseNumber(cells[map.units_sold]) : 0;
      const kenp = map.kenp_read !== undefined ? parseNumber(cells[map.kenp_read]) : 0;
      const royalty = map.royalty !== undefined ? parseNumber(cells[map.royalty]) : 0;
      if (units === 0 && kenp === 0 && royalty === 0) continue; // 実績ゼロ行は無視

      rows.push({
        asin,
        title: map.title !== undefined ? String(cells[map.title] ?? '').trim() || null : null,
        marketplace: map.marketplace !== undefined ? String(cells[map.marketplace] ?? '').trim() || null : null,
        currency: map.currency !== undefined ? String(cells[map.currency] ?? '').trim() || null : null,
        units_sold: units,
        kenp_read: kenp,
        royalty,
      });
    }
  }

  return { rows, sheetsSeen, sheetsParsed, detectedHeaders };
}
