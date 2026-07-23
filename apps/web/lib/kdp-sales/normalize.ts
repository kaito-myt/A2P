/**
 * KDP レポート行の正規化コア (docs/09 §2, T-KS-03)。
 *
 * パース済みの生行 (KdpReportRow[]) を、(ASIN, year_month) 単位に集約し、
 * ロイヤリティを円換算して合算する **純関数**。ブラウザ/ワーカー双方から使える
 * よう外部依存を持たない (xlsx も prisma も触らない)。ASIN→book_id の解決は
 * 呼び出し側 (アクション) が行う。
 */

/** パーサが 1 行から抽出する生データ (1 マーケットプレイス×1 タイトル分)。 */
export interface KdpReportRow {
  asin: string;
  title?: string | null;
  marketplace?: string | null;
  /** ロイヤリティの通貨コード ("JPY" / "USD" 等)。空/未検出は JPY 扱い。 */
  currency?: string | null;
  units_sold: number;
  kenp_read: number;
  /** `currency` 建てのロイヤリティ額。 */
  royalty: number;
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
  /** 集約前の総行数 */
  inputRowCount: number;
  /** 円換算できず royalty を合計から除外した行の通貨→件数 */
  unconvertedCurrencies: Record<string, number>;
  totals: { royalty_jpy: number; units_sold: number; kenp_read: number };
}

export interface NormalizeOptions {
  /** 通貨コード(大文字) → JPY 換算レート。JPY は 1 固定で不要。例: { USD: 152.3 } */
  fxToJpy?: Record<string, number>;
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

/**
 * KDP 生行 → ASIN 別・円換算・合算。
 * - units_sold / kenp_read は通貨に依らず常に合算 (件数のため)。
 * - royalty は JPY はそのまま、換算レートがある通貨は換算、無い通貨は合計から除外し
 *   `unconvertedCurrencies` に計上 (units/kenp は残す)。
 */
export function normalizeKdpRows(
  rows: KdpReportRow[],
  options: NormalizeOptions = {},
): NormalizeResult {
  const fx = options.fxToJpy ?? {};
  const byAsin = new Map<string, NormalizedSalesRow>();
  const unconverted: Record<string, number> = {};

  for (const row of rows) {
    const asin = row.asin.trim();
    if (!asin) continue;

    let acc = byAsin.get(asin);
    if (!acc) {
      acc = { asin, title: row.title?.trim() || null, royalty_jpy: 0, units_sold: 0, kenp_read: 0 };
      byAsin.set(asin, acc);
    }
    if (!acc.title && row.title?.trim()) acc.title = row.title.trim();

    acc.units_sold += toSafeInt(row.units_sold);
    acc.kenp_read += toSafeInt(row.kenp_read);

    const royalty = Number.isFinite(row.royalty) ? row.royalty : 0;
    if (royalty !== 0) {
      const cur = normalizeCurrency(row.currency);
      if (cur === 'JPY') {
        acc.royalty_jpy += royalty;
      } else if (fx[cur] && fx[cur] > 0) {
        acc.royalty_jpy += royalty * fx[cur];
      } else {
        unconverted[cur] = (unconverted[cur] ?? 0) + 1;
      }
    }
  }

  const outRows = Array.from(byAsin.values())
    .map((r) => ({ ...r, royalty_jpy: Math.round(r.royalty_jpy) }))
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
    inputRowCount: rows.length,
    unconvertedCurrencies: unconverted,
    totals,
  };
}

function toSafeInt(n: number): number {
  return Number.isFinite(n) ? Math.round(n) : 0;
}
