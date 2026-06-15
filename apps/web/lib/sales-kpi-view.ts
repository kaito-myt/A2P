/**
 * S-017 売上・KPI ダッシュボード (T-08-07, F-039) のビューヘルパ。
 *
 * RSC で getBooksKpiList / getSalesKpiSummary 結果を受け取り、
 * Client Component に渡すための pure 関数群。
 *
 * 仕様根拠:
 *  - docs/04 S-017
 *  - docs/05 §10 (売上 KPI 集計)
 *  - SP-08 T-08-07
 */

import type { BooksKpiRow, SalesKpiSummary } from '@a2p/db/books-kpi';

// ---------------------------------------------------------------------------
// Re-export from db package so consumers import from one place
// ---------------------------------------------------------------------------

export type { BooksKpiRow, SalesKpiSummary };

// ---------------------------------------------------------------------------
// Display types
// ---------------------------------------------------------------------------

export interface SalesKpiCardData {
  label: string;
  value: string;
  subValue?: string;
}

/** One serialised book row safe for client component serialisation */
export interface BookKpiRowSerialized {
  book_id: string;
  title: string;
  subtitle: string | null;
  thumbnail_r2_key: string | null;
  published_at: string | null; // ISO string
  asin: string | null;
  monthly_royalty_jpy: number;
  cumulative_royalty_jpy: number;
  latest_bsr: number | null;
  avg_stars: number | null;
  quality_score: number | null;
  cost_jpy: number;
  roi: number | null;
  /** Formatted ROI string, e.g. "+212%" or "—" */
  roi_display: string;
}

/** One month/genre cell for the trend chart */
export interface TrendChartMonth {
  ym: string; // "YYYY-MM"
  practical: number;
  business: number;
  self_help: number;
  total: number;
}

/** One cell in the genre×month heatmap */
export interface HeatmapCell {
  genre: string;
  ym: string;
  value: number;
  /** 0–1 intensity (for CSS opacity / shade) */
  intensity: number;
}

export interface HeatmapMatrix {
  genres: string[];
  months: string[];
  cells: HeatmapCell[];
  maxValue: number;
}

// ---------------------------------------------------------------------------
// Serialisers
// ---------------------------------------------------------------------------

export function serializeBookKpiRow(
  row: BooksKpiRow & { genre?: string },
): BookKpiRowSerialized {
  return {
    book_id: row.book_id,
    title: row.title,
    subtitle: row.subtitle,
    thumbnail_r2_key: row.thumbnail_r2_key,
    published_at: row.published_at ? row.published_at.toISOString() : null,
    asin: row.asin,
    monthly_royalty_jpy: row.monthly_royalty_jpy,
    cumulative_royalty_jpy: row.cumulative_royalty_jpy,
    latest_bsr: row.latest_bsr,
    avg_stars: row.avg_stars,
    quality_score: row.quality_score,
    cost_jpy: row.cost_jpy,
    roi: row.roi,
    roi_display: formatRoi(row.roi),
  };
}

// ---------------------------------------------------------------------------
// KPI formatting
// ---------------------------------------------------------------------------

export function formatJpy(value: number): string {
  return `¥${Math.round(value).toLocaleString('ja-JP')}`;
}

export function formatStars(value: number | null): string {
  if (value == null) return '—';
  return `${(Math.round(value * 10) / 10).toFixed(1)} ★`;
}

export function formatRoi(roi: number | null): string {
  if (roi == null) return '—';
  const pct = Math.round(roi * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

export function formatCostSalesRatio(ratio: number | null): string {
  if (ratio == null) return '—';
  // ratio = royalty / cost; display as percentage of cost vs sales
  // From the KPI definition: cost/sales = cost_jpy / royalty_jpy = 1/ratio
  const pct = ratio > 0 ? (1 / ratio) * 100 : 0;
  return `${Math.round(pct * 10) / 10}%`;
}

export function formatBsr(bsr: number | null): string {
  if (bsr == null) return '—';
  return bsr.toLocaleString('ja-JP');
}

export function formatQuality(score: number | null): string {
  if (score == null) return '—';
  return `${Math.round(score)}`;
}

// ---------------------------------------------------------------------------
// Trend chart builder
// ---------------------------------------------------------------------------

const GENRE_KEYS = ['practical', 'business', 'self_help'] as const;
type GenreKey = typeof GENRE_KEYS[number];

/**
 * Builds trend chart data from pre-computed genre-month aggregates
 * (output of getMonthlyGenreSales).
 */
export function buildTrendChartFromAggregates(
  aggregates: Array<{ ym: string; genre: string; royalty_jpy: number }>,
  months: string[],
): TrendChartMonth[] {
  const byMonth = new Map<string, Record<GenreKey, number>>();
  for (const ym of months) {
    byMonth.set(ym, { practical: 0, business: 0, self_help: 0 });
  }

  for (const agg of aggregates) {
    const bucket = byMonth.get(agg.ym);
    if (!bucket) continue;
    const genre = normalizeGenre(agg.genre);
    bucket[genre] += agg.royalty_jpy;
  }

  return months.map((ym) => {
    const b = byMonth.get(ym) ?? { practical: 0, business: 0, self_help: 0 };
    return {
      ym,
      practical: b.practical,
      business: b.business,
      self_help: b.self_help,
      total: b.practical + b.business + b.self_help,
    };
  });
}

// ---------------------------------------------------------------------------
// Heatmap builder
// ---------------------------------------------------------------------------

/**
 * Builds heatmap from pre-aggregated genre×month data
 * (output of getMonthlyGenreSales).
 */
export function buildHeatmapFromAggregates(
  aggregates: Array<{ ym: string; genre: string; royalty_jpy: number }>,
  months: string[],
  genres: string[] = ['practical', 'business', 'self_help'],
): HeatmapMatrix {
  const lookup = new Map<string, number>();
  for (const agg of aggregates) {
    const key = `${normalizeGenre(agg.genre)}:${agg.ym}`;
    lookup.set(key, (lookup.get(key) ?? 0) + agg.royalty_jpy);
  }

  const cells: HeatmapCell[] = [];
  let maxValue = 0;

  for (const genre of genres) {
    for (const ym of months) {
      const value = Math.round(lookup.get(`${genre}:${ym}`) ?? 0);
      if (value > maxValue) maxValue = value;
      cells.push({ genre, ym, value, intensity: 0 });
    }
  }

  for (const cell of cells) {
    cell.intensity = maxValue > 0 ? cell.value / maxValue : 0;
  }

  return { genres, months, cells, maxValue };
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

/**
 * Returns ["YYYY-MM", ...] for the last N months ending with current month.
 */
export function buildMonthRange(periodMonths: number): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = periodMonths - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    months.push(ym);
  }
  return months;
}

/** Returns YYYY-MM for the first and last of a month array */
export function monthRangeBounds(months: string[]): { from: string; to: string } | null {
  if (months.length === 0) return null;
  return { from: months[0]!, to: months[months.length - 1]! };
}

/** Parses "1" | "3" | "6" | "12" period param to number of months */
export function parsePeriodParam(raw: string | undefined): number {
  const n = Number(raw ?? '1');
  if ([1, 3, 6, 12].includes(n)) return n;
  return 1;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeGenre(genre: string | null | undefined): GenreKey {
  if (genre === 'business') return 'business';
  if (genre === 'self_help') return 'self_help';
  return 'practical';
}
