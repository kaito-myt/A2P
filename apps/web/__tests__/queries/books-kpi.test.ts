/**
 * T-08-08 — getBooksKpiList / getSalesKpiSummary unit tests.
 *
 * Strategy: mock PrismaClient.$queryRawUnsafe (the only Prisma call used by
 * getBooksKpiList) so no database is needed.  Tests follow the same pattern as
 * packages/db/__tests__/cost-aggregation.test.ts.
 *
 * Performance bench: builds 100-book mock rows and asserts the
 * JavaScript-side mapping completes well within 2 seconds.
 */

import { describe, it, expect, vi } from 'vitest';

// The function lives in packages/db but apps/web depends on @a2p/db so we can
// import from the workspace package path (resolved via tsconfig paths / pnpm).
import {
  getBooksKpiList,
  getSalesKpiSummary,
  type BooksKpiRow,
  type BooksKpiFilter,
} from '@a2p/db/books-kpi';

import type { PrismaClient } from '@a2p/db';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

type MockPrisma = {
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
};

function createMockPrisma(): MockPrisma {
  return {
    $queryRawUnsafe: vi.fn(),
  };
}

// Build a raw DB row that mimics what PostgreSQL returns (all numeric fields
// come back as strings or BigInt in pg driver; we keep them as numbers here
// since the toNumber helpers accept both).
function makeRawRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    book_id: 'book-1',
    title: 'テスト書籍',
    subtitle: null,
    thumbnail_r2_key: null,
    published_at: null,
    asin: null,
    monthly_royalty_jpy: 3000,
    cumulative_royalty_jpy: 15000,
    latest_bsr: 4500,
    wavg_stars: 4.2,
    quality_score: 85,
    cost_jpy: 300,
    roi: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getBooksKpiList — correctness
// ---------------------------------------------------------------------------

describe('getBooksKpiList — correctness', () => {
  it('maps a single raw row to BooksKpiRow correctly', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      makeRawRow({
        book_id: 'b-1',
        title: '失敗しない副業術',
        subtitle: 'サブタイトル',
        thumbnail_r2_key: 'covers/b-1/cover.png',
        published_at: new Date('2026-03-01'),
        asin: 'B0ABCDEF',
        monthly_royalty_jpy: 5000,
        cumulative_royalty_jpy: 20000,
        latest_bsr: 1500,
        wavg_stars: 4.5,
        quality_score: 90,
        cost_jpy: 250,
        roi: 80,
      }),
    ]);

    const rows = await getBooksKpiList(mock as unknown as PrismaClient, { accountId: 'acc-1' });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.book_id).toBe('b-1');
    expect(row.title).toBe('失敗しない副業術');
    expect(row.subtitle).toBe('サブタイトル');
    expect(row.thumbnail_r2_key).toBe('covers/b-1/cover.png');
    expect(row.published_at).toBeInstanceOf(Date);
    expect(row.asin).toBe('B0ABCDEF');
    expect(row.monthly_royalty_jpy).toBe(5000);
    expect(row.cumulative_royalty_jpy).toBe(20000);
    expect(row.latest_bsr).toBe(1500);
    expect(row.avg_stars).toBeCloseTo(4.5);
    expect(row.quality_score).toBe(90);
    expect(row.cost_jpy).toBeCloseTo(250);
    expect(row.roi).toBeCloseTo(80);
  });

  it('returns empty array when no books match', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);

    const rows = await getBooksKpiList(mock as unknown as PrismaClient);

    expect(rows).toHaveLength(0);
  });

  it('sets roi to null when cost_jpy is 0', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      makeRawRow({ cost_jpy: 0, roi: null }),
    ]);

    const rows = await getBooksKpiList(mock as unknown as PrismaClient);

    expect(rows[0]!.roi).toBeNull();
    expect(rows[0]!.cost_jpy).toBe(0);
  });

  it('handles null optional fields gracefully', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      makeRawRow({
        subtitle: null,
        thumbnail_r2_key: null,
        published_at: null,
        asin: null,
        latest_bsr: null,
        wavg_stars: null,
        quality_score: null,
        cost_jpy: 0,
        roi: null,
      }),
    ]);

    const rows = await getBooksKpiList(mock as unknown as PrismaClient);
    const row = rows[0]!;

    expect(row.subtitle).toBeNull();
    expect(row.thumbnail_r2_key).toBeNull();
    expect(row.published_at).toBeNull();
    expect(row.asin).toBeNull();
    expect(row.latest_bsr).toBeNull();
    expect(row.avg_stars).toBeNull();
    expect(row.quality_score).toBeNull();
    expect(row.roi).toBeNull();
  });

  it('handles Decimal-like objects (toString) from pg driver for cost_jpy', async () => {
    const mock = createMockPrisma();
    const decimalLike = { toString: () => '123.4567', valueOf: () => 123.4567 };
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      makeRawRow({ cost_jpy: decimalLike }),
    ]);

    const rows = await getBooksKpiList(mock as unknown as PrismaClient);
    expect(rows[0]!.cost_jpy).toBeCloseTo(123.4567);
  });

  it('handles BigInt values from pg driver for royalty fields', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      makeRawRow({
        monthly_royalty_jpy: BigInt(8000),
        cumulative_royalty_jpy: BigInt(30000),
      }),
    ]);

    const rows = await getBooksKpiList(mock as unknown as PrismaClient);
    expect(rows[0]!.monthly_royalty_jpy).toBe(8000);
    expect(rows[0]!.cumulative_royalty_jpy).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// getBooksKpiList — filter → SQL parameterization (argument inspection)
// ---------------------------------------------------------------------------

describe('getBooksKpiList — filter parameterization', () => {
  it('passes accountId as the first parameter after SQL string', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);

    await getBooksKpiList(mock as unknown as PrismaClient, { accountId: 'acc-42' });

    expect(mock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...args] = mock.$queryRawUnsafe.mock.calls[0]!;
    expect(typeof sql).toBe('string');
    expect(args).toContain('acc-42');
  });

  it('passes periodFrom and periodTo as parameters', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);

    await getBooksKpiList(mock as unknown as PrismaClient, {
      periodFrom: '2026-01',
      periodTo: '2026-06',
    });

    const [, ...args] = mock.$queryRawUnsafe.mock.calls[0]!;
    expect(args).toContain('2026-01');
    expect(args).toContain('2026-06');
  });

  it('passes genre as parameter and includes JOIN clause in SQL', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);

    await getBooksKpiList(mock as unknown as PrismaClient, { genre: 'business' });

    const [sql, ...args] = mock.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('theme_candidates');
    expect(args).toContain('business');
  });

  it('no filter generates SQL with no extra params', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);

    await getBooksKpiList(mock as unknown as PrismaClient, {});

    const [, ...args] = mock.$queryRawUnsafe.mock.calls[0]!;
    expect(args).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getSalesKpiSummary — correctness
// ---------------------------------------------------------------------------

describe('getSalesKpiSummary — correctness', () => {
  it('computes correct summary from known rows', async () => {
    const mock = createMockPrisma();
    // Two books: 15000 + 20000 royalty, 300 + 250 cost, stars 4.0 + 4.5
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      makeRawRow({
        cumulative_royalty_jpy: 15000,
        cost_jpy: 300,
        wavg_stars: 4.0,
      }),
      makeRawRow({
        book_id: 'b-2',
        cumulative_royalty_jpy: 20000,
        cost_jpy: 250,
        wavg_stars: 4.5,
      }),
    ]);

    const summary = await getSalesKpiSummary(mock as unknown as PrismaClient);

    expect(summary.total_royalty_jpy).toBe(35000);
    expect(summary.total_books).toBe(2);
    expect(summary.avg_royalty_per_book_jpy).toBeCloseTo(17500);
    expect(summary.avg_stars).toBeCloseTo(4.25);
    expect(summary.total_cost_jpy).toBeCloseTo(550);
    // ROI = 35000 / 550 ≈ 63.6
    expect(summary.cost_sales_ratio).toBeCloseTo(35000 / 550);
  });

  it('returns zeroed summary when no books', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);

    const summary = await getSalesKpiSummary(mock as unknown as PrismaClient);

    expect(summary.total_royalty_jpy).toBe(0);
    expect(summary.total_books).toBe(0);
    expect(summary.avg_royalty_per_book_jpy).toBe(0);
    expect(summary.avg_stars).toBeNull();
    expect(summary.total_cost_jpy).toBe(0);
    expect(summary.cost_sales_ratio).toBeNull();
  });

  it('sets cost_sales_ratio to null when total cost is 0', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      makeRawRow({ cumulative_royalty_jpy: 5000, cost_jpy: 0, roi: null }),
    ]);

    const summary = await getSalesKpiSummary(mock as unknown as PrismaClient);

    expect(summary.cost_sales_ratio).toBeNull();
  });

  it('handles books with null avg_stars (excluded from average)', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      makeRawRow({ wavg_stars: 4.0 }),
      makeRawRow({ book_id: 'b-2', wavg_stars: null }),
    ]);

    const summary = await getSalesKpiSummary(mock as unknown as PrismaClient);

    // Only one book has stars, so avg = 4.0
    expect(summary.avg_stars).toBeCloseTo(4.0);
  });
});

// ---------------------------------------------------------------------------
// ROI calculation correctness (isolated)
// ---------------------------------------------------------------------------

describe('getBooksKpiList — ROI semantics', () => {
  it('returns roi = cumulative_royalty / cost_jpy from DB row', async () => {
    const mock = createMockPrisma();
    // DB computes ROI: 12000 / 400 = 30
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      makeRawRow({ cumulative_royalty_jpy: 12000, cost_jpy: 400, roi: 30 }),
    ]);

    const rows = await getBooksKpiList(mock as unknown as PrismaClient);
    expect(rows[0]!.roi).toBeCloseTo(30);
  });
});

// ---------------------------------------------------------------------------
// Performance benchmark: 100 books × 12 months (F-039 受け入れ基準 ≤ 2s)
// ---------------------------------------------------------------------------

describe('performance benchmark', () => {
  /**
   * Simulates the JS-side mapping for 100 books.
   * The SQL is sent as a single call to the DB; we mock the returned rows.
   * This validates that the mapping/post-processing overhead is negligible and
   * that the overall integration (single $queryRawUnsafe call + mapping) returns
   * within 2s for 100 books with 12 months of data each.
   *
   * Note: real DB latency is excluded from this unit bench because it depends
   * on the environment; the SQL design is intentionally single-pass to minimise
   * round-trips.
   */
  it('maps 100-book result set (1 $queryRawUnsafe call) within 2 seconds', async () => {
    const BOOK_COUNT = 100;

    const rawRows: Record<string, unknown>[] = Array.from({ length: BOOK_COUNT }, (_, i) => ({
      book_id: `book-${i}`,
      title: `書籍タイトル ${i}`,
      subtitle: i % 3 === 0 ? `サブタイトル ${i}` : null,
      thumbnail_r2_key: `covers/book-${i}/cover.png`,
      published_at: new Date(2025, i % 12, 1),
      asin: i % 5 === 0 ? `B${String(i).padStart(9, '0')}` : null,
      monthly_royalty_jpy: 1000 + i * 100,
      cumulative_royalty_jpy: 12000 + i * 1000,
      latest_bsr: 1000 + i * 50,
      wavg_stars: 3.5 + (i % 20) * 0.05,
      quality_score: 70 + (i % 30),
      cost_jpy: 200 + i * 3,
      roi: (12000 + i * 1000) / (200 + i * 3),
    }));

    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce(rawRows);

    const start = performance.now();
    const rows = await getBooksKpiList(mock as unknown as PrismaClient, { accountId: 'acc-1' });
    const elapsed = performance.now() - start;

    expect(rows).toHaveLength(BOOK_COUNT);
    // F-039: 100 冊で 2 秒以内
    expect(elapsed).toBeLessThan(2000);
  });

  it('getSalesKpiSummary aggregates 100 rows within 2 seconds', async () => {
    const BOOK_COUNT = 100;
    const rawRows = Array.from({ length: BOOK_COUNT }, (_, i) => ({
      book_id: `book-${i}`,
      title: `書籍 ${i}`,
      subtitle: null,
      thumbnail_r2_key: null,
      published_at: null,
      asin: null,
      monthly_royalty_jpy: 1000 + i * 50,
      cumulative_royalty_jpy: 10000 + i * 500,
      latest_bsr: 2000 + i,
      wavg_stars: 4.0 + (i % 10) * 0.05,
      quality_score: 80,
      cost_jpy: 300 + i,
      roi: (10000 + i * 500) / (300 + i),
    }));

    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce(rawRows);

    const start = performance.now();
    const summary = await getSalesKpiSummary(mock as unknown as PrismaClient);
    const elapsed = performance.now() - start;

    expect(summary.total_books).toBe(BOOK_COUNT);
    expect(summary.total_royalty_jpy).toBeGreaterThan(0);
    // F-039: well within 2s (summary iterates the already-mapped rows)
    expect(elapsed).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// Index verification (mirrors cost-aggregation.test.ts approach)
// ---------------------------------------------------------------------------

describe('index verification', () => {
  it('sales_records_book_id_idx is defined in schema for GROUP BY book_id', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(here, '..', '..', '..', '..', 'packages', 'db', 'schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');

    expect(schema).toContain('sales_records_book_id_idx');
  });

  it('sales_records_month_idx is defined for year_month period filter', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(here, '..', '..', '..', '..', 'packages', 'db', 'schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');

    expect(schema).toContain('sales_records_month_idx');
  });

  it('token_usage_book_time_idx is defined for cost GROUP BY', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(here, '..', '..', '..', '..', 'packages', 'db', 'schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');

    expect(schema).toContain('token_usage_book_time_idx');
  });

  it('eval_results_book_time_idx is defined for DISTINCT ON latest score', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(here, '..', '..', '..', '..', 'packages', 'db', 'schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');

    expect(schema).toContain('eval_results_book_time_idx');
  });
});
