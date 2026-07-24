import type { PrismaClient } from '../generated/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BooksKpiFilter {
  accountId?: string;
  /** "YYYY-MM" range, inclusive on both ends */
  periodFrom?: string;
  periodTo?: string;
  genre?: string;
}

/**
 * One row per book in the KPI list.
 * Monetary values are in JPY.
 */
export interface BooksKpiRow {
  book_id: string;
  title: string;
  subtitle: string | null;
  thumbnail_r2_key: string | null;
  published_at: Date | null;
  asin: string | null;
  /** Sum of royalty_jpy within the filter period */
  monthly_royalty_jpy: number;
  /** Cumulative royalty across all time */
  cumulative_royalty_jpy: number;
  /** Sum of KENP (Kindle Unlimited) pages read within the filter period */
  monthly_kenp_read: number;
  /** Cumulative KENP pages read across all time */
  cumulative_kenp_read: number;
  /** Latest BSR within the filter period (null if no record) */
  latest_bsr: number | null;
  /** Weighted avg stars (sum(royalty*stars)/sum(royalty)), or simple avg if all royalty=0 */
  avg_stars: number | null;
  /** Latest Quality Judge score (most recent judged_at) */
  quality_score: number | null;
  /** Total cost_jpy from token_usage */
  cost_jpy: number;
  /**
   * ROI = cumulative_royalty_jpy / cost_jpy.
   * null when cost_jpy === 0 (avoid divide-by-zero).
   */
  roi: number | null;
}

export interface SalesKpiSummary {
  total_royalty_jpy: number;
  total_books: number;
  avg_royalty_per_book_jpy: number;
  avg_stars: number | null;
  total_cost_jpy: number;
  /** total_royalty / total_cost, null when cost=0 */
  cost_sales_ratio: number | null;
  /** Cumulative KENP pages read across all books in filter */
  total_kenp_read: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toDateOrNull(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toStringOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s === '' ? null : s;
}

// ---------------------------------------------------------------------------
// getBooksKpiList [F-039 / T-08-08]
// ---------------------------------------------------------------------------

/**
 * Returns one aggregated KPI row per book.
 *
 * Single-pass SQL: books LEFT JOIN the aggregated sales/cost/eval CTEs.
 * Index usage:
 *   - sales_records: books_account_status_idx (account_id), sales_records_month_idx (year_month)
 *   - token_usage: token_usage_book_time_idx (book_id)
 *   - eval_results: eval_results_book_time_idx (book_id)
 *   - covers: covers_book_status_idx (book_id, status)
 *
 * The filter period (periodFrom/periodTo) applies only to the monthly_royalty aggregation.
 * cumulative_royalty_jpy is always the all-time total (matching S-017 KPI stripe semantics).
 */
export async function getBooksKpiList(
  prisma: PrismaClient,
  filter: BooksKpiFilter = {},
): Promise<BooksKpiRow[]> {
  const { accountId, periodFrom, periodTo, genre } = filter;

  // Build dynamic conditions for the WHERE clause on `books`.
  // We use template literal with explicit casts — Prisma $queryRaw uses
  // pg's parameterized query protocol, so $N placeholders are safe.
  const conditions: string[] = ['b.status NOT IN (\'cancelled\')'];
  const params: unknown[] = [];

  let p = 1;

  if (accountId) {
    conditions.push(`b.account_id = $${p++}`);
    params.push(accountId);
  }

  // genre is stored in theme_candidates.genre; we reach it via the theme join.
  // If genre filter is present, books without a theme are excluded.
  let genreJoin = '';
  if (genre) {
    genreJoin = `JOIN theme_candidates tc ON tc.id = b.theme_id`;
    conditions.push(`tc.genre = $${p++}`);
    params.push(genre);
  }

  // Period filter for monthly aggregation in the sales CTE.
  let periodFromParam = '';
  let periodToParam = '';

  if (periodFrom) {
    periodFromParam = `$${p++}`;
    params.push(periodFrom);
  }
  if (periodTo) {
    periodToParam = `$${p++}`;
    params.push(periodTo);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // Build the sales period sub-condition for monthly_royalty.
  const periodCond: string[] = [];
  if (periodFrom) periodCond.push(`sr_p.year_month >= ${periodFromParam}`);
  if (periodTo) periodCond.push(`sr_p.year_month <= ${periodToParam}`);
  const periodCondStr = periodCond.length > 0 ? `AND ${periodCond.join(' AND ')}` : '';

  const sql = `
    WITH
    -- Cumulative sales (all-time) per book
    sales_cumulative AS (
      SELECT
        book_id,
        COALESCE(SUM(royalty_jpy), 0)::bigint       AS cum_royalty,
        COALESCE(SUM(kenp_read), 0)::bigint          AS cum_kenp,
        COALESCE(SUM(review_count), 0)::bigint       AS cum_reviews,
        COALESCE(
          CASE
            WHEN SUM(royalty_jpy) > 0
            THEN SUM(royalty_jpy::numeric * avg_stars::numeric) / NULLIF(SUM(royalty_jpy), 0)
            ELSE AVG(avg_stars)
          END,
          NULL
        )::numeric(5,2)                              AS wavg_stars,
        (ARRAY_AGG(bsr ORDER BY year_month DESC NULLS LAST)
          FILTER (WHERE bsr IS NOT NULL))[1]::int    AS latest_bsr
      FROM sales_records
      GROUP BY book_id
    ),
    -- Period sales (filtered by year_month range) per book
    sales_period AS (
      SELECT
        sr_p.book_id,
        COALESCE(SUM(sr_p.royalty_jpy), 0)::bigint  AS period_royalty,
        COALESCE(SUM(sr_p.kenp_read), 0)::bigint    AS period_kenp
      FROM sales_records sr_p
      WHERE 1=1 ${periodCondStr}
      GROUP BY sr_p.book_id
    ),
    -- Total cost per book (all-time)
    cost_agg AS (
      SELECT
        book_id,
        COALESCE(SUM(cost_jpy), 0)::numeric(14,4)   AS total_cost
      FROM token_usage
      WHERE book_id IS NOT NULL
      GROUP BY book_id
    ),
    -- Latest quality score per book
    eval_latest AS (
      SELECT DISTINCT ON (book_id)
        book_id,
        score_total
      FROM eval_results
      ORDER BY book_id, judged_at DESC
    ),
    -- Adopted cover thumbnail
    cover_adopted AS (
      SELECT DISTINCT ON (book_id)
        book_id,
        r2_key
      FROM covers
      WHERE status = 'adopted'
      ORDER BY book_id, created_at DESC
    )
    SELECT
      b.id                                                          AS book_id,
      b.title,
      b.subtitle,
      ca.r2_key                                                     AS thumbnail_r2_key,
      b.done_at                                                     AS published_at,
      b.asin,
      COALESCE(sp.period_royalty, 0)::bigint                        AS monthly_royalty_jpy,
      COALESCE(sc.cum_royalty,    0)::bigint                        AS cumulative_royalty_jpy,
      COALESCE(sp.period_kenp,    0)::bigint                        AS monthly_kenp_read,
      COALESCE(sc.cum_kenp,       0)::bigint                        AS cumulative_kenp_read,
      sc.latest_bsr,
      sc.wavg_stars,
      el.score_total                                                AS quality_score,
      COALESCE(co.total_cost, 0)::numeric(14,4)                    AS cost_jpy,
      CASE
        WHEN COALESCE(co.total_cost, 0) = 0 THEN NULL
        ELSE (COALESCE(sc.cum_royalty, 0)::numeric / co.total_cost)::numeric(14,4)
      END                                                           AS roi
    FROM books b
    ${genreJoin}
    LEFT JOIN sales_cumulative sc ON sc.book_id = b.id
    LEFT JOIN sales_period     sp ON sp.book_id = b.id
    LEFT JOIN cost_agg         co ON co.book_id = b.id
    LEFT JOIN eval_latest      el ON el.book_id = b.id
    LEFT JOIN cover_adopted    ca ON ca.book_id = b.id
    ${whereClause}
    ORDER BY b.created_at DESC
  `;

  // Prisma $queryRawUnsafe accepts (sql, ...params) directly.
  // We build the SQL with positional placeholders so it is fully parameterized.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (prisma.$queryRawUnsafe as any)(sql, ...params) as Record<string, unknown>[];

  return rows.map((r) => {
    const cost = toNumber(r['cost_jpy']);
    const cumRoyalty = toNumber(r['cumulative_royalty_jpy']);
    const roiRaw = toNumberOrNull(r['roi']);

    return {
      book_id: String(r['book_id']),
      title: String(r['title']),
      subtitle: toStringOrNull(r['subtitle']),
      thumbnail_r2_key: toStringOrNull(r['thumbnail_r2_key']),
      published_at: toDateOrNull(r['published_at']),
      asin: toStringOrNull(r['asin']),
      monthly_royalty_jpy: toNumber(r['monthly_royalty_jpy']),
      cumulative_royalty_jpy: cumRoyalty,
      monthly_kenp_read: toNumber(r['monthly_kenp_read']),
      cumulative_kenp_read: toNumber(r['cumulative_kenp_read']),
      latest_bsr: toNumberOrNull(r['latest_bsr']),
      avg_stars: toNumberOrNull(r['wavg_stars']),
      quality_score: toNumberOrNull(r['quality_score']),
      cost_jpy: cost,
      roi: roiRaw,
    };
  });
}

// ---------------------------------------------------------------------------
// getMonthlyGenreSales [F-039 / T-08-07]
// ---------------------------------------------------------------------------

/**
 * Per-(genre, year_month) royalty aggregation for the trend chart and heatmap.
 *
 * Returns one row per unique (genre, year_month) pair that has sales data
 * within the filter period.
 *
 * Index usage:
 *   - sales_records: sales_records_month_idx (year_month)
 *   - books: account_id FK
 *   - theme_candidates: books.theme_id FK
 */
export interface MonthlyGenreSalesRow {
  ym: string;
  genre: string;
  royalty_jpy: number;
}

export async function getMonthlyGenreSales(
  prisma: PrismaClient,
  filter: BooksKpiFilter = {},
): Promise<MonthlyGenreSalesRow[]> {
  const { accountId, periodFrom, periodTo, genre } = filter;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (accountId) {
    conditions.push(`b.account_id = $${p++}`);
    params.push(accountId);
  }
  if (genre) {
    conditions.push(`tc.genre = $${p++}`);
    params.push(genre);
  }
  if (periodFrom) {
    conditions.push(`sr.year_month >= $${p++}`);
    params.push(periodFrom);
  }
  if (periodTo) {
    conditions.push(`sr.year_month <= $${p++}`);
    params.push(periodTo);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      tc.genre,
      sr.year_month           AS ym,
      SUM(sr.royalty_jpy)::bigint AS royalty_jpy
    FROM sales_records sr
    JOIN books b           ON b.id = sr.book_id
    JOIN theme_candidates tc ON tc.id = b.theme_id
    ${whereClause}
    GROUP BY tc.genre, sr.year_month
    ORDER BY sr.year_month, tc.genre
  `;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (prisma.$queryRawUnsafe as any)(sql, ...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    ym: String(r['ym']),
    genre: String(r['genre']),
    royalty_jpy: toNumber(r['royalty_jpy']),
  }));
}

// ---------------------------------------------------------------------------
// getSalesKpiSummary [F-039 / T-08-08]
// ---------------------------------------------------------------------------

/**
 * Aggregated summary stripe for the S-017 KPI dashboard header.
 * Accepts the same filter and re-uses the same index paths.
 */
export async function getSalesKpiSummary(
  prisma: PrismaClient,
  filter: BooksKpiFilter = {},
): Promise<SalesKpiSummary> {
  const rows = await getBooksKpiList(prisma, filter);

  if (rows.length === 0) {
    return {
      total_royalty_jpy: 0,
      total_books: 0,
      avg_royalty_per_book_jpy: 0,
      avg_stars: null,
      total_cost_jpy: 0,
      cost_sales_ratio: null,
      total_kenp_read: 0,
    };
  }

  const totalRoyalty = rows.reduce((acc, r) => acc + r.cumulative_royalty_jpy, 0);
  const totalCost = rows.reduce((acc, r) => acc + r.cost_jpy, 0);
  const totalKenp = rows.reduce((acc, r) => acc + r.cumulative_kenp_read, 0);
  const starsRows = rows.filter((r) => r.avg_stars != null);
  const avgStars =
    starsRows.length > 0
      ? starsRows.reduce((acc, r) => acc + (r.avg_stars ?? 0), 0) / starsRows.length
      : null;

  return {
    total_royalty_jpy: totalRoyalty,
    total_books: rows.length,
    avg_royalty_per_book_jpy: rows.length > 0 ? totalRoyalty / rows.length : 0,
    avg_stars: avgStars != null ? Math.round(avgStars * 100) / 100 : null,
    total_cost_jpy: totalCost,
    cost_sales_ratio: totalCost > 0 ? totalRoyalty / totalCost : null,
    total_kenp_read: totalKenp,
  };
}
