import type { PrismaClient } from '../generated/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostAggregationRow {
  provider: string;
  model: string;
  role: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  image_count: number;
  cost_jpy: number;
}

export interface BookCostBreakdown {
  book_id: string;
  rows: CostAggregationRow[];
  total_cost_jpy: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_input_tokens: number;
  total_image_count: number;
}

export interface MonthlyCostResult {
  year: number;
  month: number;
  total_cost_jpy: number;
}

export interface TopCostBook {
  book_id: string;
  total_cost_jpy: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_image_count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// getBookCostBreakdown [F-033 / T-07-01]
// ---------------------------------------------------------------------------

/**
 * provider x model x role granularity cost breakdown for a single book.
 * Uses token_usage_book_time_idx for efficient filtering by book_id.
 */
export async function getBookCostBreakdown(
  prisma: PrismaClient,
  bookId: string,
): Promise<BookCostBreakdown> {
  const grouped = await prisma.tokenUsage.groupBy({
    by: ['provider', 'model', 'role'],
    where: { book_id: bookId },
    _sum: {
      cost_jpy: true,
      input_tokens: true,
      output_tokens: true,
      cached_input_tokens: true,
      image_count: true,
    },
  });

  const rows: CostAggregationRow[] = grouped.map((g) => ({
    provider: g.provider,
    model: g.model,
    role: g.role,
    input_tokens: g._sum.input_tokens ?? 0,
    output_tokens: g._sum.output_tokens ?? 0,
    cached_input_tokens: g._sum.cached_input_tokens ?? 0,
    image_count: g._sum.image_count ?? 0,
    cost_jpy: toNumber(g._sum.cost_jpy),
  }));

  rows.sort((a, b) => b.cost_jpy - a.cost_jpy);

  return {
    book_id: bookId,
    rows,
    total_cost_jpy: rows.reduce((acc, r) => acc + r.cost_jpy, 0),
    total_input_tokens: rows.reduce((acc, r) => acc + r.input_tokens, 0),
    total_output_tokens: rows.reduce((acc, r) => acc + r.output_tokens, 0),
    total_cached_input_tokens: rows.reduce((acc, r) => acc + r.cached_input_tokens, 0),
    total_image_count: rows.reduce((acc, r) => acc + r.image_count, 0),
  };
}

// ---------------------------------------------------------------------------
// getMonthlyTotalCost [T-07-03]
// ---------------------------------------------------------------------------

/**
 * Total cost_jpy for a given year/month.
 * Uses token_usage_time_idx (created_at DESC) for range scan.
 */
export async function getMonthlyTotalCost(
  prisma: PrismaClient,
  year: number,
  month: number,
): Promise<MonthlyCostResult> {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  const result = await prisma.tokenUsage.aggregate({
    where: {
      created_at: { gte: start, lt: end },
    },
    _sum: { cost_jpy: true },
  });

  return {
    year,
    month,
    total_cost_jpy: toNumber(result._sum.cost_jpy),
  };
}

// ---------------------------------------------------------------------------
// getTopCostBooks [T-07-05]
// ---------------------------------------------------------------------------

/**
 * Top N books by total cost_jpy (descending).
 * Uses token_usage_book_time_idx for the GROUP BY on book_id.
 */
export async function getTopCostBooks(
  prisma: PrismaClient,
  limit: number,
): Promise<TopCostBook[]> {
  const grouped = await prisma.tokenUsage.groupBy({
    by: ['book_id'],
    where: { book_id: { not: null } },
    _sum: {
      cost_jpy: true,
      input_tokens: true,
      output_tokens: true,
      image_count: true,
    },
    orderBy: { _sum: { cost_jpy: 'desc' } },
    take: limit,
  });

  return grouped.map((g) => ({
    book_id: g.book_id!,
    total_cost_jpy: toNumber(g._sum.cost_jpy),
    total_input_tokens: g._sum.input_tokens ?? 0,
    total_output_tokens: g._sum.output_tokens ?? 0,
    total_image_count: g._sum.image_count ?? 0,
  }));
}
