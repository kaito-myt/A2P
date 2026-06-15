import type { PrismaClient } from '../generated/index.js';

// ---------------------------------------------------------------------------
// Public types [F-026 / T-13-01]
// ---------------------------------------------------------------------------

export type AbGroupKey = 'period_a' | 'period_b' | string;

/**
 * Query input for A/B comparison stats.
 *
 * mode='period'  — split by books.created_at ranges (periodA vs periodB)
 * mode='prompt'  — split by books.prompt_version_ids_json[role] matching baseline/candidate
 * mode='model'   — split by books.model_assignment_snapshot[role].model matching baseline/candidate
 */
export interface AbComparisonFilter {
  mode: 'period' | 'prompt' | 'model';

  // mode='period'
  periodA?: { from: Date; to: Date };
  periodB?: { from: Date; to: Date };

  // mode='prompt' or mode='model'
  role?: string;
  baselineId?: string;
  candidateId?: string;

  /** Groups with fewer books than this threshold get insufficient_data=true. Default: 5 */
  minSample?: number;
}

export interface AbGroupStats {
  group_key: AbGroupKey;
  label: string;
  book_count: number;
  avg_quality_score: number | null;
  avg_cost_jpy: number | null;
  avg_lead_time_hours: number | null;
  median_royalty_jpy: number | null;
  total_cached_input_tokens: number;
  total_input_tokens: number;
  cache_hit_rate: number | null; // cached / (input + cached)
  insufficient_data: boolean;
  book_ids: string[];
}

export interface AbComparisonResult {
  filter: AbComparisonFilter;
  group_a: AbGroupStats;
  group_b: AbGroupStats;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TokenAgg {
  total_cost_jpy: number;
  total_input_tokens: number;
  total_cached_input_tokens: number;
}

interface EvalRow {
  book_id: string;
  score_total: number;
}

interface SalesAgg {
  book_id: string;
  total_royalty_jpy: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Compute median from a sorted array of numbers. Returns null for empty arrays. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

// ---------------------------------------------------------------------------
// Per-group stats computation
// ---------------------------------------------------------------------------

async function computeGroupStats(
  prisma: PrismaClient,
  bookIds: string[],
  groupKey: AbGroupKey,
  label: string,
  minSample: number,
): Promise<AbGroupStats> {
  const book_count = bookIds.length;
  const insufficient_data = book_count < minSample;

  if (book_count === 0) {
    return {
      group_key: groupKey,
      label,
      book_count: 0,
      avg_quality_score: null,
      avg_cost_jpy: null,
      avg_lead_time_hours: null,
      median_royalty_jpy: null,
      total_cached_input_tokens: 0,
      total_input_tokens: 0,
      cache_hit_rate: null,
      insufficient_data: true,
      book_ids: [],
    };
  }

  // Fetch books for lead-time calculation (done_at - created_at)
  const books = await prisma.book.findMany({
    where: { id: { in: bookIds } },
    select: { id: true, created_at: true, done_at: true },
  });

  // TokenUsage: aggregate per book, then average
  const tokenGrouped = await prisma.tokenUsage.groupBy({
    by: ['book_id'],
    where: { book_id: { in: bookIds } },
    _sum: {
      cost_jpy: true,
      input_tokens: true,
      cached_input_tokens: true,
    },
  });

  const tokenByBook = new Map<string, TokenAgg>();
  let totalCachedInputTokens = 0;
  let totalInputTokens = 0;

  for (const row of tokenGrouped) {
    const bid = row.book_id!;
    const costJpy = toNumber(row._sum.cost_jpy);
    const inputTok = row._sum.input_tokens ?? 0;
    const cachedTok = row._sum.cached_input_tokens ?? 0;
    tokenByBook.set(bid, {
      total_cost_jpy: costJpy,
      total_input_tokens: inputTok,
      total_cached_input_tokens: cachedTok,
    });
    totalInputTokens += inputTok;
    totalCachedInputTokens += cachedTok;
  }

  // avg_cost_jpy: average of per-book total cost
  const booksWithCost = bookIds.filter((id) => tokenByBook.has(id));
  const avgCostJpy =
    booksWithCost.length > 0
      ? booksWithCost.reduce((acc, id) => acc + tokenByBook.get(id)!.total_cost_jpy, 0) /
        booksWithCost.length
      : null;

  // EvalResult: latest score per book (most recent judged_at)
  const evalRows = await (prisma.$queryRawUnsafe as (...args: unknown[]) => Promise<EvalRow[]>)(
    `
    SELECT DISTINCT ON (book_id)
      book_id,
      score_total
    FROM eval_results
    WHERE book_id = ANY($1)
    ORDER BY book_id, judged_at DESC
    `,
    bookIds,
  );

  const evalByBook = new Map<string, number>();
  for (const r of evalRows) {
    evalByBook.set(r.book_id, r.score_total);
  }

  const booksWithEval = bookIds.filter((id) => evalByBook.has(id));
  const avgQualityScore =
    booksWithEval.length > 0
      ? booksWithEval.reduce((acc, id) => acc + evalByBook.get(id)!, 0) / booksWithEval.length
      : null;

  // avg_lead_time_hours: (done_at - created_at) in hours, only for done books
  const leadTimes: number[] = [];
  for (const b of books) {
    if (b.done_at) {
      const hours = (b.done_at.getTime() - b.created_at.getTime()) / (1000 * 60 * 60);
      leadTimes.push(hours);
    }
  }
  const avgLeadTimeHours =
    leadTimes.length > 0 ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null;

  // median_royalty_jpy: SalesRecord.royalty_jpy cumulative total per book, then median
  const salesGrouped = await prisma.salesRecord.groupBy({
    by: ['book_id'],
    where: { book_id: { in: bookIds } },
    _sum: { royalty_jpy: true },
  });

  const salesAggs: SalesAgg[] = salesGrouped.map((r) => ({
    book_id: r.book_id,
    total_royalty_jpy: r._sum.royalty_jpy ?? 0,
  }));

  const sortedRoyalties = salesAggs
    .map((s) => s.total_royalty_jpy)
    .sort((a, b) => a - b);

  const medianRoyaltyJpy = median(sortedRoyalties);

  // cache_hit_rate
  const totalDenominator = totalInputTokens + totalCachedInputTokens;
  const cacheHitRate =
    totalCachedInputTokens > 0 && totalDenominator > 0
      ? totalCachedInputTokens / totalDenominator
      : null;

  return {
    group_key: groupKey,
    label,
    book_count,
    avg_quality_score: avgQualityScore != null ? Math.round(avgQualityScore * 100) / 100 : null,
    avg_cost_jpy: avgCostJpy != null ? Math.round(avgCostJpy * 100) / 100 : null,
    avg_lead_time_hours:
      avgLeadTimeHours != null ? Math.round(avgLeadTimeHours * 100) / 100 : null,
    median_royalty_jpy: medianRoyaltyJpy,
    total_cached_input_tokens: totalCachedInputTokens,
    total_input_tokens: totalInputTokens,
    cache_hit_rate: cacheHitRate,
    insufficient_data,
    book_ids: bookIds,
  };
}

// ---------------------------------------------------------------------------
// Period-mode book ID resolution
// ---------------------------------------------------------------------------

interface PeriodBookRow {
  id: string;
}

async function getBookIdsForPeriod(
  prisma: PrismaClient,
  from: Date,
  to: Date,
): Promise<string[]> {
  const rows = await (
    prisma.$queryRawUnsafe as (...args: unknown[]) => Promise<PeriodBookRow[]>
  )(
    `SELECT id FROM books WHERE created_at >= $1 AND created_at < $2 AND status != 'cancelled'`,
    from,
    to,
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Label builders
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function periodLabel(from: Date, to: Date): string {
  return `${formatDate(from)} 〜 ${formatDate(new Date(to.getTime() - 1))}`;
}

// ---------------------------------------------------------------------------
// Main export [F-026 / T-13-01]
// ---------------------------------------------------------------------------

/**
 * Returns A/B comparison stats for two groups of books.
 *
 * - mode='period': books split by created_at range (periodA vs periodB)
 * - mode='prompt': books split by prompt_version_ids_json[role] value
 * - mode='model':  books split by model_assignment_snapshot[role].model value
 *
 * Groups with fewer than minSample books (default: 5) get insufficient_data=true.
 * Hard Rule 5: cached_input_tokens is included in all aggregations.
 */
export async function getAbComparisonStats(
  prisma: PrismaClient,
  filter: AbComparisonFilter,
): Promise<AbComparisonResult> {
  const minSample = filter.minSample ?? 5;

  let bookIdsA: string[];
  let bookIdsB: string[];
  let labelA: string;
  let labelB: string;

  if (filter.mode === 'period') {
    const fromA = filter.periodA?.from ?? new Date(0);
    const toA = filter.periodA?.to ?? new Date();
    const fromB = filter.periodB?.from ?? new Date(0);
    const toB = filter.periodB?.to ?? new Date();

    [bookIdsA, bookIdsB] = await Promise.all([
      getBookIdsForPeriod(prisma, fromA, toA),
      getBookIdsForPeriod(prisma, fromB, toB),
    ]);

    labelA = `期間A (${periodLabel(fromA, toA)})`;
    labelB = `期間B (${periodLabel(fromB, toB)})`;
  } else {
    // Both 'prompt' and 'model' modes: fetch all non-cancelled books, filter in app layer
    const role = filter.role ?? 'writer';
    const baselineId = filter.baselineId ?? '';
    const candidateId = filter.candidateId ?? '';

    const allBooks = await prisma.book.findMany({
      where: { status: { not: 'cancelled' } },
      select: {
        id: true,
        created_at: true,
        done_at: true,
        prompt_version_ids_json: true,
        model_assignment_snapshot: true,
      },
    });

    if (filter.mode === 'prompt') {
      bookIdsA = allBooks
        .filter((b) => {
          const pvIds = b.prompt_version_ids_json as Record<string, string> | null;
          return pvIds != null && pvIds[role] === baselineId;
        })
        .map((b) => b.id);

      bookIdsB = allBooks
        .filter((b) => {
          const pvIds = b.prompt_version_ids_json as Record<string, string> | null;
          return pvIds != null && pvIds[role] === candidateId;
        })
        .map((b) => b.id);

      labelA = `baseline:${baselineId}`;
      labelB = `candidate:${candidateId}`;
    } else {
      // mode='model'
      bookIdsA = allBooks
        .filter((b) => {
          const snap = b.model_assignment_snapshot as Record<
            string,
            { model: string } | undefined
          > | null;
          return snap != null && snap[role]?.model === baselineId;
        })
        .map((b) => b.id);

      bookIdsB = allBooks
        .filter((b) => {
          const snap = b.model_assignment_snapshot as Record<
            string,
            { model: string } | undefined
          > | null;
          return snap != null && snap[role]?.model === candidateId;
        })
        .map((b) => b.id);

      labelA = `${role}:${baselineId}`;
      labelB = `${role}:${candidateId}`;
    }
  }

  const [group_a, group_b] = await Promise.all([
    computeGroupStats(prisma, bookIdsA, 'period_a', labelA, minSample),
    computeGroupStats(prisma, bookIdsB, 'period_b', labelB, minSample),
  ]);

  return { filter, group_a, group_b };
}
