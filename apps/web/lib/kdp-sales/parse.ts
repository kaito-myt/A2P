/**
 * KDP レポート (xlsx/csv) パーサ (docs/09 §3.1, T-KS-02)。
 *
 * SheetJS(xlsx) で全シートを走査し、ヘッダ行を検出して列をマッピングし、
 * ASIN 別に (販売数 / KENP / ロイヤリティ) を月単位で抽出する。
 *
 * 実 KDP レポートの 2 形式に対応する:
 *  1. 「月別ロイヤリティ明細 (Prior Month Royalties)」
 *     - シート: 「電子書籍のロイヤリティ」(有料販売) + 「既読 KENPC」(KENP 読了＋KENPロイヤリティ)
 *     - 月は各シート先頭の「販売期間 | 6月 2026」メタ行に入る (行単位ではない)
 *     - 「既読 KENPC」に ASIN 別 KENP ロイヤリティ金額列が存在する ← 最も正確
 *  2. 「ロイヤリティ推定 (Royalties Estimator)」
 *     - シート: 「概要」(月次合計) / 「電子書籍のロイヤリティ」(月×ASIN 有料販売) /
 *       「既読 KENPC」(KENP ページ数のみ・金額なし) など
 *     - 月は各行の日付列 (ロイヤリティ発生日 / 日付) に入る
 *     - KENP ロイヤリティは ASIN 別には無く「概要」の月次合計から按分する
 *
 * KDP のレポート種別・言語(EN/JA)によるヘッダ表記ゆれに耐えるよう、ヘッダ名の
 * 正規化 + エイリアス一致で列を特定する。throw せず、取れた行だけ返す。
 */
import * as XLSX from 'xlsx';

import type { KdpReportRow, KdpMonthlySummary } from './normalize';

/**
 * レポート種別。
 *  - 'confirmed': 月別ロイヤリティ明細 (確定値。ASIN 別 KENP ロイヤリティ金額あり)
 *  - 'estimate' : ロイヤリティ推定 (「概要」月次合計から KENP を按分する当月見込み)
 */
export type KdpReportKind = 'confirmed' | 'estimate';

export interface ParseResult {
  rows: KdpReportRow[];
  /** 「概要」シート由来の月次サマリ (Estimator の KENP ロイヤリティ按分に使う) */
  monthlySummaries: KdpMonthlySummary[];
  /** レポート種別 (確定 or 見込み)。「概要」シートを持つものを Estimator=見込みとみなす。 */
  reportKind: KdpReportKind;
  /** rows / summaries に現れた月 (YYYY-MM) の昇順ユニーク一覧 */
  months: string[];
  /** 走査したシート名 */
  sheetsSeen: string[];
  /** データを抽出できたシート名 */
  sheetsParsed: string[];
  /** デバッグ用: 検出したヘッダの例 (先頭シート) */
  detectedHeaders: string[];
}

type ColumnKey =
  | 'asin'
  | 'title'
  | 'marketplace'
  | 'currency'
  | 'units_sold'
  | 'kenp_read'
  | 'royalty'
  | 'royalty_jpy'
  | 'date';

/** ヘッダ正規化: 小文字化 + 空白/記号/かっこ除去 (日本語はそのまま残す)。 */
function normHeader(h: unknown): string {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[\s_\-/()（）［］\[\].,:：]/g, '')
    .trim();
}

const isAsin = (h: string): boolean => h === 'asin' || h === 'asinisbn' || h === 'isbn';
const isTitle = (h: string): boolean =>
  h === 'title' || h === 'タイトル' || h === '書名' || h === '本のタイトル';
const isMarketplace = (h: string): boolean =>
  h.includes('marketplace') || h.includes('マーケットプレイス') || h === 'マーケット' || h === 'store';
const isCurrency = (h: string): boolean => h === 'currency' || h === '通貨' || h === 'currencycode';
const isKenp = (h: string): boolean =>
  h.includes('kenp') ||
  h.includes('kindleeditionnormalizedpages') ||
  h.includes('既読') ||
  h.includes('ページ既読') ||
  h.includes('normalizedpagesread');
const isUnits = (h: string): boolean =>
  h === 'unitssold' ||
  h === 'netunitssold' ||
  h === 'netunits' ||
  h === '販売部数' ||
  h === '正味販売部数' ||
  h === '実質注文数' ||
  h === '販売数' ||
  h === '注文数' ||
  h === '注文';
const isPreferredUnits = (h: string): boolean =>
  h.includes('実質') || h.includes('正味') || h.includes('net');
/** ロイヤリティ「金額」列 (「ロイヤリティ発生日」等の日付列を拾わないよう厳格一致)。 */
const isRoyaltyAmount = (h: string): boolean =>
  h === 'ロイヤリティ' ||
  h === 'ロイヤルティ' ||
  h === 'royalty' ||
  h === '推定ロイヤリティ' ||
  h === 'ロイヤリティ額';
/** 「概要」シートの通貨別ロイヤリティ列のうち JPY 建て。 */
const isRoyaltyJpy = (h: string): boolean => h === 'ロイヤリティjpy' || h === 'royaltyjpy';
const isDate = (h: string): boolean =>
  h.includes('発生日') || h === '日付' || h.includes('date') || h === '販売期間' || h === '日';

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

/** ASIN らしさ (10 桁英数)。緩め。 */
function looksLikeAsin(v: unknown): boolean {
  const s = String(v ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(s);
}

const EN_MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 日付/期間セルから "YYYY-MM" を取り出す。対応表記:
 *  - 2026-07 / 2026-07-01 / 2026/07 / 2026.07 / 2026年7月
 *  - 7月 2026 / 6月 2026 (KDP 日本語メタ行)
 *  - July 2026 / Jun 2026
 */
export function parseMonth(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/(\d{4})[-/年.](\d{1,2})/);
  if (m && m[1] && m[2]) return `${m[1]}-${pad2(Number(m[2]))}`;
  m = s.match(/(\d{1,2})\s*月[\s,、]*(\d{4})/);
  if (m && m[1] && m[2]) return `${m[2]}-${pad2(Number(m[1]))}`;
  m = s.toLowerCase().match(/([a-z]+)\.?\s+(\d{4})/);
  if (m && m[1] && m[2]) {
    const mo = EN_MONTHS[m[1]];
    if (mo) return `${m[2]}-${pad2(mo)}`;
  }
  return null;
}

interface HeaderMap {
  headerRow: number;
  map: Partial<Record<ColumnKey, number>>;
  headers: string[];
}

/** 1 行 (cells) を列マップに変換する。 */
function mapCells(cells: unknown[]): Partial<Record<ColumnKey, number>> {
  const map: Partial<Record<ColumnKey, number>> = {};
  cells.forEach((cell, ci) => {
    const h = normHeader(cell);
    if (!h) return;
    if (map.asin === undefined && isAsin(h)) map.asin = ci;
    if (isUnits(h) && (map.units_sold === undefined || isPreferredUnits(h))) map.units_sold = ci;
    if (map.kenp_read === undefined && isKenp(h)) map.kenp_read = ci;
    if (map.royalty === undefined && isRoyaltyAmount(h)) map.royalty = ci;
    if (map.royalty_jpy === undefined && isRoyaltyJpy(h)) map.royalty_jpy = ci;
    if (map.currency === undefined && isCurrency(h)) map.currency = ci;
    if (map.marketplace === undefined && isMarketplace(h)) map.marketplace = ci;
    if (map.title === undefined && isTitle(h)) map.title = ci;
    if (map.date === undefined && isDate(h)) map.date = ci;
  });
  return map;
}

/**
 * シートのヘッダ行を検出する。
 * ヘッダ行 = ASIN と (royalty/units/kenp のいずれか) を含む最初の行、
 * または (ASIN 無しで) royalty_jpy と kenp を含む「概要」行。
 */
function findHeaderRow(matrix: unknown[][]): HeaderMap | null {
  const scan = Math.min(matrix.length, 30);
  for (let r = 0; r < scan; r++) {
    const cells = matrix[r] ?? [];
    const map = mapCells(cells);
    const hasBookData =
      map.royalty !== undefined || map.units_sold !== undefined || map.kenp_read !== undefined;
    const isDetail = map.asin !== undefined && hasBookData;
    const isSummary =
      map.asin === undefined && map.royalty_jpy !== undefined && map.kenp_read !== undefined;
    if (isDetail || isSummary) {
      return { headerRow: r, map, headers: cells.map((c) => String(c ?? '')) };
    }
  }
  return null;
}

/** ヘッダ行より前のメタ行から月 (販売期間) を推定する。 */
function detectSheetMonth(matrix: unknown[][], headerRow: number): string | null {
  const scan = Math.min(headerRow, 5);
  for (let r = 0; r < scan; r++) {
    for (const cell of matrix[r] ?? []) {
      const mo = parseMonth(cell);
      if (mo) return mo;
    }
  }
  return null;
}

type SheetRole = 'combined' | 'paid' | 'kenp' | 'summary' | 'ignore';

function classify(map: Partial<Record<ColumnKey, number>>): SheetRole {
  if (map.asin !== undefined) {
    const hasUnits = map.units_sold !== undefined;
    const hasKenp = map.kenp_read !== undefined;
    const hasRoyalty = map.royalty !== undefined;
    if (hasUnits && hasKenp) return 'combined';
    if (hasKenp) return 'kenp';
    if (hasRoyalty || hasUnits) return 'paid';
    return 'ignore';
  }
  if (map.royalty_jpy !== undefined && map.kenp_read !== undefined) return 'summary';
  return 'ignore';
}

export function parseKdpReportWorkbook(buffer: Buffer | ArrayBuffer): ParseResult {
  const rows: KdpReportRow[] = [];
  const monthlySummaries: KdpMonthlySummary[] = [];
  const sheetsSeen: string[] = [];
  const sheetsParsed: string[] = [];
  let detectedHeaders: string[] = [];

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    return {
      rows,
      monthlySummaries,
      reportKind: 'confirmed',
      months: [],
      sheetsSeen,
      sheetsParsed,
      detectedHeaders,
    };
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
    const header = findHeaderRow(matrix);
    if (!header) continue;

    const { headerRow, map } = header;
    const role = classify(map);
    if (role === 'ignore') continue;

    const sheetMonth = detectSheetMonth(matrix, headerRow);
    sheetsParsed.push(sheetName);
    if (detectedHeaders.length === 0) detectedHeaders = header.headers.filter(Boolean);

    for (let r = headerRow + 1; r < matrix.length; r++) {
      const cells = matrix[r] ?? [];
      const rowMonth =
        (map.date !== undefined ? parseMonth(cells[map.date]) : null) ?? sheetMonth;

      if (role === 'summary') {
        if (!rowMonth) continue;
        const kenp = map.kenp_read !== undefined ? parseNumber(cells[map.kenp_read]) : 0;
        const royaltyJpy = map.royalty_jpy !== undefined ? parseNumber(cells[map.royalty_jpy]) : 0;
        if (kenp === 0 && royaltyJpy === 0) continue;
        monthlySummaries.push({ month: rowMonth, kenp_read: kenp, royalty_jpy: royaltyJpy });
        continue;
      }

      const asin = String(map.asin !== undefined ? cells[map.asin] ?? '' : '').trim().toUpperCase();
      if (!looksLikeAsin(asin)) continue; // フッタ/合計行など

      // combined: units も kenp も royalty も同一行に存在 (単一シート型レポート)
      // paid: 有料販売シート → units + royalty
      // kenp: KENP シート → kenp + (あれば KENP ロイヤリティ)
      const units =
        role !== 'kenp' && map.units_sold !== undefined ? parseNumber(cells[map.units_sold]) : 0;
      const kenp =
        role !== 'paid' && map.kenp_read !== undefined ? parseNumber(cells[map.kenp_read]) : 0;
      const royalty = map.royalty !== undefined ? parseNumber(cells[map.royalty]) : 0;
      if (units === 0 && kenp === 0 && royalty === 0) continue;

      rows.push({
        asin,
        title: map.title !== undefined ? String(cells[map.title] ?? '').trim() || null : null,
        marketplace:
          map.marketplace !== undefined ? String(cells[map.marketplace] ?? '').trim() || null : null,
        currency: map.currency !== undefined ? String(cells[map.currency] ?? '').trim() || null : null,
        month: rowMonth,
        units_sold: units,
        kenp_read: kenp,
        royalty,
        royalty_kind: role === 'kenp' ? 'kenp' : 'paid',
      });
    }
  }

  const monthSet = new Set<string>();
  for (const r of rows) if (r.month) monthSet.add(r.month);
  for (const s of monthlySummaries) monthSet.add(s.month);
  const months = Array.from(monthSet).sort();

  // 「概要」シート (月次サマリ) を持つのは Estimator のみ → 見込み扱い。
  const reportKind: KdpReportKind = monthlySummaries.length > 0 ? 'estimate' : 'confirmed';

  return { rows, monthlySummaries, reportKind, months, sheetsSeen, sheetsParsed, detectedHeaders };
}
