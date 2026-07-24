/**
 * KDP レポート行の正規化コア (docs/09 §2, T-KS-03)。
 *
 * パース済みの生行 (KdpReportRow[]) を、対象月・ASIN 単位に集約し、ロイヤリティを
 * 円換算して合算する **純関数**。ブラウザ/ワーカー双方から使えるよう外部依存を
 * 持たない (xlsx も prisma も触らない)。ASIN→book_id の解決は呼び出し側が行う。
 *
 * ロイヤリティは 2 系統を合算する:
 *  - 有料販売ロイヤリティ (royalty_kind='paid'): レポートに明細金額あり
 *  - KENP ロイヤリティ (royalty_kind='kenp'):
 *      「月別ロイヤリティ明細」は ASIN 別金額を持つ → そのまま合算
 *      「ロイヤリティ推定」は ASIN 別金額を持たない → 「概要」の月次合計から
 *      各書籍の KENP ページ数で按分して推定計上する
 */

/** パーサが 1 行から抽出する生データ (1 マーケットプレイス×1 タイトル分)。 */
export interface KdpReportRow {
  asin: string;
  title?: string | null;
  marketplace?: string | null;
  /** ロイヤリティの通貨コード ("JPY" / "USD" 等)。空/未検出は JPY 扱い。 */
  currency?: string | null;
  /** この行が属する月 (YYYY-MM)。未検出は null。 */
  month?: string | null;
  units_sold: number;
  kenp_read: number;
  /** `currency` 建てのロイヤリティ額。 */
  royalty: number;
  /** ロイヤリティの種別 (有料販売 or KENP)。未指定は 'paid' 扱い。 */
  royalty_kind?: 'paid' | 'kenp';
}

/** 「概要」シート由来の月次サマリ (KENP ロイヤリティ按分の原資)。 */
export interface KdpMonthlySummary {
  month: string;
  kenp_read: number;
  /** その月の総ロイヤリティ (JPY 建て・KENP 分を含む)。 */
  royalty_jpy: number;
}

/** ASIN 単位に集約・円換算した結果。 */
export interface NormalizedSalesRow {
  asin: string;
  title: string | null;
  royalty_jpy: number;
  units_sold: number;
  kenp_read: number;
}

export interface NormalizeResult {
  rows: NormalizedSalesRow[];
  /** 集約前の総行数 (対象月フィルタ後) */
  inputRowCount: number;
  /** 円換算できず royalty を合計から除外した行の通貨→件数 */
  unconvertedCurrencies: Record<string, number>;
  totals: { royalty_jpy: number; units_sold: number; kenp_read: number };
  /** KENP ロイヤリティを概要合計から按分計上した場合の按分総額 (JPY)。0 なら按分なし。 */
  allocatedKenpRoyaltyJpy: number;
}

export interface NormalizeOptions {
  /** 通貨コード(大文字) → JPY 換算レート。JPY は 1 固定で不要。例: { USD: 152.3 } */
  fxToJpy?: Record<string, number>;
  /** 対象月 (YYYY-MM)。指定時はこの月の行のみ集約する。 */
  targetMonth?: string;
  /** Estimator の KENP ロイヤリティ按分に使う月次サマリ。 */
  monthlySummaries?: KdpMonthlySummary[];
}

/** 通貨表記を正規化 (¥ / 円 / 空 → JPY、記号を ISO 風コードへ)。 */
export function normalizeCurrency(raw: string | null | undefined): string {
  const s = (raw ?? '').trim().toUpperCase();
  if (s === '' || s === 'JPY' || s === '¥' || s === '円' || s === 'YEN') return 'JPY';
  if (s === 'USD' || s === '$' || s === 'US$') return 'USD';
  if (s === 'EUR' || s === '€') return 'EUR';
  if (s === 'GBP' || s === '£') return 'GBP';
  return s;
}

interface Acc extends NormalizedSalesRow {
  /** 有料販売ロイヤリティ (JPY) */
  paid_jpy: number;
  /** ASIN 別に明細金額のある KENP ロイヤリティ (JPY) */
  kenp_jpy: number;
  /** KENP ロイヤリティ金額が明細に存在したか (按分要否の判定用) */
  kenp_royalty_present: boolean;
}

/**
 * KDP 生行 → 対象月・ASIN 別・円換算・合算。
 * - units_sold / kenp_read は通貨に依らず常に合算 (件数のため)。
 * - royalty は JPY はそのまま、換算レートがある通貨は換算、無い通貨は合計から除外し
 *   `unconvertedCurrencies` に計上 (units/kenp は残す)。
 * - KENP ロイヤリティ金額が明細に無い(Estimator)場合、`monthlySummaries` の月次合計から
 *   各書籍の KENP ページ数で按分して計上する。
 */
export function normalizeKdpRows(
  rows: KdpReportRow[],
  options: NormalizeOptions = {},
): NormalizeResult {
  const fx = options.fxToJpy ?? {};
  const target = options.targetMonth;
  const src = target ? rows.filter((r) => (r.month ?? target) === target) : rows;
  const byAsin = new Map<string, Acc>();
  const unconverted: Record<string, number> = {};

  for (const row of src) {
    const asin = row.asin.trim();
    if (!asin) continue;

    let acc = byAsin.get(asin);
    if (!acc) {
      acc = {
        asin,
        title: row.title?.trim() || null,
        royalty_jpy: 0,
        units_sold: 0,
        kenp_read: 0,
        paid_jpy: 0,
        kenp_jpy: 0,
        kenp_royalty_present: false,
      };
      byAsin.set(asin, acc);
    }
    if (!acc.title && row.title?.trim()) acc.title = row.title.trim();

    acc.units_sold += toSafeInt(row.units_sold);
    acc.kenp_read += toSafeInt(row.kenp_read);

    const royalty = Number.isFinite(row.royalty) ? row.royalty : 0;
    if (royalty !== 0) {
      const cur = normalizeCurrency(row.currency);
      let jpy: number | null = null;
      if (cur === 'JPY') jpy = royalty;
      else if (fx[cur] && fx[cur] > 0) jpy = royalty * fx[cur];

      if (jpy === null) {
        unconverted[cur] = (unconverted[cur] ?? 0) + 1;
      } else if (row.royalty_kind === 'kenp') {
        acc.kenp_jpy += jpy;
        acc.kenp_royalty_present = true;
      } else {
        acc.paid_jpy += jpy;
      }
    }
  }

  const accs = Array.from(byAsin.values());

  // KENP ロイヤリティ按分 (Estimator 対応):
  // 明細に KENP ロイヤリティ金額が一切無く、対象月の概要サマリがある場合、
  // 概要合計 − 有料販売合計 = KENP 原資 を、各書籍の KENP ページ数で按分する。
  let allocatedKenpRoyaltyJpy = 0;
  const anyKenpRoyaltyPresent = accs.some((a) => a.kenp_royalty_present);
  if (!anyKenpRoyaltyPresent && target && options.monthlySummaries) {
    const summary = options.monthlySummaries.find((s) => s.month === target);
    if (summary) {
      const paidTotal = accs.reduce((t, a) => t + a.paid_jpy, 0);
      const pool = Math.max(0, Math.round(summary.royalty_jpy) - Math.round(paidTotal));
      const totalPages = accs.reduce((t, a) => t + a.kenp_read, 0);
      if (pool > 0 && totalPages > 0) {
        // 最大剰余法で pool を整数配分 (合計ズレを出さない)
        const shares = accs
          .filter((a) => a.kenp_read > 0)
          .map((a) => {
            const exact = (pool * a.kenp_read) / totalPages;
            const floor = Math.floor(exact);
            return { acc: a, floor, rem: exact - floor };
          });
        let assigned = shares.reduce((t, s) => t + s.floor, 0);
        let leftover = pool - assigned;
        shares.sort((x, y) => y.rem - x.rem);
        for (const s of shares) {
          const add = s.floor + (leftover > 0 ? 1 : 0);
          if (leftover > 0) leftover--;
          s.acc.kenp_jpy += add;
          allocatedKenpRoyaltyJpy += add;
        }
      }
    }
  }

  const outRows: NormalizedSalesRow[] = accs
    .map((a) => ({
      asin: a.asin,
      title: a.title,
      royalty_jpy: Math.round(a.paid_jpy + a.kenp_jpy),
      units_sold: a.units_sold,
      kenp_read: a.kenp_read,
    }))
    .sort((a, b) => b.royalty_jpy - a.royalty_jpy);

  const totals = outRows.reduce(
    (t, r) => ({
      royalty_jpy: t.royalty_jpy + r.royalty_jpy,
      units_sold: t.units_sold + r.units_sold,
      kenp_read: t.kenp_read + r.kenp_read,
    }),
    { royalty_jpy: 0, units_sold: 0, kenp_read: 0 },
  );

  return {
    rows: outRows,
    inputRowCount: src.length,
    unconvertedCurrencies: unconverted,
    totals,
    allocatedKenpRoyaltyJpy,
  };
}

function toSafeInt(n: number): number {
  return Number.isFinite(n) ? Math.round(n) : 0;
}
