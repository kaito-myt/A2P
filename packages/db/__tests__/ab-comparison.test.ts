import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAbComparisonStats } from '../src/ab-comparison.js';
import type { PrismaClient } from '../generated/index.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type MockPrisma = {
  book: {
    findMany: ReturnType<typeof vi.fn>;
  };
  tokenUsage: {
    groupBy: ReturnType<typeof vi.fn>;
  };
  salesRecord: {
    groupBy: ReturnType<typeof vi.fn>;
  };
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
};

function createMockPrisma(): MockPrisma {
  return {
    book: {
      findMany: vi.fn(),
    },
    tokenUsage: {
      groupBy: vi.fn(),
    },
    salesRecord: {
      groupBy: vi.fn(),
    },
    $queryRawUnsafe: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-06-01T00:00:00Z');
const ONE_HOUR_MS = 1000 * 60 * 60;

function makeBook(id: string, overrides: Partial<{ created_at: Date; done_at: Date | null; prompt_version_ids_json: unknown; model_assignment_snapshot: unknown }> = {}) {
  return {
    id,
    created_at: NOW,
    done_at: null,
    prompt_version_ids_json: null,
    model_assignment_snapshot: null,
    ...overrides,
  };
}

// Empty group mock helpers: no token usage, no eval, no sales
function mockEmptyGroup(mock: MockPrisma) {
  mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
  mock.$queryRawUnsafe.mockResolvedValueOnce([]); // eval
  mock.salesRecord.groupBy.mockResolvedValueOnce([]);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('getAbComparisonStats', () => {
  let mock: MockPrisma;

  beforeEach(() => {
    mock = createMockPrisma();
  });

  // -------------------------------------------------------------------------
  // Case 1: mode='period' — insufficient_data when book_count < minSample
  // -------------------------------------------------------------------------

  it('period: periodA(3 books) gets insufficient_data=true when minSample=5', async () => {
    const fromA = new Date('2026-01-01T00:00:00Z');
    const toA = new Date('2026-02-01T00:00:00Z');
    const fromB = new Date('2026-02-01T00:00:00Z');
    const toB = new Date('2026-03-01T00:00:00Z');

    const booksA = ['b1', 'b2', 'b3'];
    const booksB = ['b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10'];

    // $queryRawUnsafe: call 1 = getBookIdsForPeriod(A), call 2 = getBookIdsForPeriod(B)
    mock.$queryRawUnsafe
      .mockResolvedValueOnce(booksA.map((id) => ({ id })))
      .mockResolvedValueOnce(booksB.map((id) => ({ id })));

    // group_a: 3 books (insufficient) — still calls computeGroupStats
    mock.book.findMany.mockResolvedValueOnce(booksA.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]); // eval group_a
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    // group_b: 7 books
    mock.book.findMany.mockResolvedValueOnce(booksB.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]); // eval group_b
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, {
      mode: 'period',
      periodA: { from: fromA, to: toA },
      periodB: { from: fromB, to: toB },
      minSample: 5,
    });

    expect(result.group_a.book_count).toBe(3);
    expect(result.group_a.insufficient_data).toBe(true);

    expect(result.group_b.book_count).toBe(7);
    expect(result.group_b.insufficient_data).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Case 2: mode='period' — avg_quality_score and avg_cost_jpy correct
  // -------------------------------------------------------------------------

  it('period: avg_quality_score and avg_cost_jpy are correctly aggregated', async () => {
    const fromA = new Date('2026-01-01T00:00:00Z');
    const toA = new Date('2026-02-01T00:00:00Z');
    const fromB = new Date('2026-02-01T00:00:00Z');
    const toB = new Date('2026-03-01T00:00:00Z');

    const booksA = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const booksB = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];

    // Period book ID fetch
    mock.$queryRawUnsafe
      .mockResolvedValueOnce(booksA.map((id) => ({ id })))
      .mockResolvedValueOnce(booksB.map((id) => ({ id })));

    // group_a
    mock.book.findMany.mockResolvedValueOnce(
      booksA.map((id) =>
        makeBook(id, {
          created_at: new Date('2026-01-10T00:00:00Z'),
          done_at: new Date('2026-01-10T02:00:00Z'), // 2h lead time each
        }),
      ),
    );
    // token: each book costs 10 JPY, input=100, cached=0
    mock.tokenUsage.groupBy.mockResolvedValueOnce(
      booksA.map((id) => ({
        book_id: id,
        _sum: { cost_jpy: 10, input_tokens: 100, cached_input_tokens: 0 },
      })),
    );
    // eval: each book scored 80
    mock.$queryRawUnsafe.mockResolvedValueOnce(
      booksA.map((id) => ({ book_id: id, score_total: 80 })),
    );
    // sales: each book royalty=500
    mock.salesRecord.groupBy.mockResolvedValueOnce(
      booksA.map((id) => ({ book_id: id, _sum: { royalty_jpy: 500 } })),
    );

    // group_b: each book costs 20 JPY, quality 90
    mock.book.findMany.mockResolvedValueOnce(
      booksB.map((id) => makeBook(id, { done_at: null })),
    );
    mock.tokenUsage.groupBy.mockResolvedValueOnce(
      booksB.map((id) => ({
        book_id: id,
        _sum: { cost_jpy: 20, input_tokens: 200, cached_input_tokens: 0 },
      })),
    );
    mock.$queryRawUnsafe.mockResolvedValueOnce(
      booksB.map((id) => ({ book_id: id, score_total: 90 })),
    );
    mock.salesRecord.groupBy.mockResolvedValueOnce(
      booksB.map((id) => ({ book_id: id, _sum: { royalty_jpy: 1000 } })),
    );

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, {
      mode: 'period',
      periodA: { from: fromA, to: toA },
      periodB: { from: fromB, to: toB },
      minSample: 5,
    });

    expect(result.group_a.avg_quality_score).toBeCloseTo(80, 1);
    expect(result.group_a.avg_cost_jpy).toBeCloseTo(10, 1);
    expect(result.group_a.avg_lead_time_hours).toBeCloseTo(2, 1);
    expect(result.group_a.median_royalty_jpy).toBe(500);

    expect(result.group_b.avg_quality_score).toBeCloseTo(90, 1);
    expect(result.group_b.avg_cost_jpy).toBeCloseTo(20, 1);
    expect(result.group_b.avg_lead_time_hours).toBeNull(); // done_at null
    expect(result.group_b.median_royalty_jpy).toBe(1000);
  });

  // -------------------------------------------------------------------------
  // Case 3: mode='period' — no EvalResult → avg_quality_score: null
  // -------------------------------------------------------------------------

  it('period: no EvalResult rows → avg_quality_score is null', async () => {
    const fromA = new Date('2026-01-01T00:00:00Z');
    const toA = new Date('2026-02-01T00:00:00Z');
    const fromB = new Date('2026-02-01T00:00:00Z');
    const toB = new Date('2026-03-01T00:00:00Z');

    const booksA = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const booksB = ['b1', 'b2', 'b3', 'b4', 'b5'];

    mock.$queryRawUnsafe
      .mockResolvedValueOnce(booksA.map((id) => ({ id })))
      .mockResolvedValueOnce(booksB.map((id) => ({ id })));

    // group_a: no eval rows
    mock.book.findMany.mockResolvedValueOnce(booksA.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]); // no eval
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    // group_b: no eval rows
    mock.book.findMany.mockResolvedValueOnce(booksB.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]); // no eval
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, {
      mode: 'period',
      periodA: { from: fromA, to: toA },
      periodB: { from: fromB, to: toB },
    });

    expect(result.group_a.avg_quality_score).toBeNull();
    expect(result.group_b.avg_quality_score).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 4: mode='period' — no SalesRecord → median_royalty_jpy: null
  // -------------------------------------------------------------------------

  it('period: no SalesRecord rows → median_royalty_jpy is null', async () => {
    const fromA = new Date('2026-01-01T00:00:00Z');
    const toA = new Date('2026-02-01T00:00:00Z');
    const fromB = new Date('2026-02-01T00:00:00Z');
    const toB = new Date('2026-03-01T00:00:00Z');

    const booksA = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const booksB = ['b1', 'b2', 'b3', 'b4', 'b5'];

    mock.$queryRawUnsafe
      .mockResolvedValueOnce(booksA.map((id) => ({ id })))
      .mockResolvedValueOnce(booksB.map((id) => ({ id })));

    // group_a: no sales
    mock.book.findMany.mockResolvedValueOnce(booksA.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce([]); // no sales

    // group_b: no sales
    mock.book.findMany.mockResolvedValueOnce(booksB.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce([]); // no sales

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, {
      mode: 'period',
      periodA: { from: fromA, to: toA },
      periodB: { from: fromB, to: toB },
    });

    expect(result.group_a.median_royalty_jpy).toBeNull();
    expect(result.group_b.median_royalty_jpy).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 5: mode='prompt' — books are grouped by prompt_version_ids_json[role]
  // -------------------------------------------------------------------------

  it('prompt: books matching baselineId go to group_a, candidateId to group_b', async () => {
    const baselineId = 'pv-001';
    const candidateId = 'pv-002';

    // findMany returns all non-cancelled books
    const allBooks = [
      makeBook('b1', { prompt_version_ids_json: { writer: baselineId } }),
      makeBook('b2', { prompt_version_ids_json: { writer: baselineId } }),
      makeBook('b3', { prompt_version_ids_json: { writer: baselineId } }),
      makeBook('b4', { prompt_version_ids_json: { writer: baselineId } }),
      makeBook('b5', { prompt_version_ids_json: { writer: baselineId } }),
      makeBook('b6', { prompt_version_ids_json: { writer: candidateId } }),
      makeBook('b7', { prompt_version_ids_json: { writer: candidateId } }),
      makeBook('b8', { prompt_version_ids_json: { writer: candidateId } }),
      makeBook('b9', { prompt_version_ids_json: { writer: candidateId } }),
      makeBook('b10', { prompt_version_ids_json: { writer: candidateId } }),
      makeBook('b11', { prompt_version_ids_json: { writer: candidateId } }),
      makeBook('b12', { prompt_version_ids_json: { writer: 'other-pv' } }), // neither group
    ];

    mock.book.findMany
      // First call: fetch all books for grouping
      .mockResolvedValueOnce(allBooks)
      // group_a: 5 books (b1..b5)
      .mockResolvedValueOnce(
        allBooks.filter((b) => ['b1', 'b2', 'b3', 'b4', 'b5'].includes(b.id)),
      )
      // group_b: 6 books (b6..b11)
      .mockResolvedValueOnce(
        allBooks.filter((b) => ['b6', 'b7', 'b8', 'b9', 'b10', 'b11'].includes(b.id)),
      );

    // group_a token/eval/sales
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    // group_b token/eval/sales
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, {
      mode: 'prompt',
      role: 'writer',
      baselineId,
      candidateId,
      minSample: 5,
    });

    expect(result.group_a.book_count).toBe(5);
    expect(result.group_a.label).toContain('baseline');
    expect(result.group_a.label).toContain(baselineId);
    expect(result.group_a.book_ids).toEqual(expect.arrayContaining(['b1', 'b2', 'b3', 'b4', 'b5']));

    expect(result.group_b.book_count).toBe(6);
    expect(result.group_b.label).toContain('candidate');
    expect(result.group_b.label).toContain(candidateId);
    expect(result.group_b.book_ids).toEqual(
      expect.arrayContaining(['b6', 'b7', 'b8', 'b9', 'b10', 'b11']),
    );

    // b12 (other-pv) should be in neither group
    expect(result.group_a.book_ids).not.toContain('b12');
    expect(result.group_b.book_ids).not.toContain('b12');
  });

  // -------------------------------------------------------------------------
  // Case 6: mode='model' — books grouped by model_assignment_snapshot[role].model
  // -------------------------------------------------------------------------

  it('model: books matching candidateId model go to group_b', async () => {
    const baselineModel = 'claude-sonnet-4-20250514';
    const candidateModel = 'gemini-2.5-flash';

    const allBooks = [
      makeBook('b1', { model_assignment_snapshot: { writer: { model: baselineModel } } }),
      makeBook('b2', { model_assignment_snapshot: { writer: { model: baselineModel } } }),
      makeBook('b3', { model_assignment_snapshot: { writer: { model: baselineModel } } }),
      makeBook('b4', { model_assignment_snapshot: { writer: { model: baselineModel } } }),
      makeBook('b5', { model_assignment_snapshot: { writer: { model: baselineModel } } }),
      makeBook('b6', { model_assignment_snapshot: { writer: { model: candidateModel } } }),
      makeBook('b7', { model_assignment_snapshot: { writer: { model: candidateModel } } }),
      makeBook('b8', { model_assignment_snapshot: { writer: { model: candidateModel } } }),
      makeBook('b9', { model_assignment_snapshot: { writer: { model: candidateModel } } }),
      makeBook('b10', { model_assignment_snapshot: { writer: { model: candidateModel } } }),
    ];

    mock.book.findMany
      .mockResolvedValueOnce(allBooks) // all books for grouping
      .mockResolvedValueOnce(allBooks.slice(0, 5)) // group_a: b1..b5
      .mockResolvedValueOnce(allBooks.slice(5, 10)); // group_b: b6..b10

    // group_a stats
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    // group_b stats
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, {
      mode: 'model',
      role: 'writer',
      baselineId: baselineModel,
      candidateId: candidateModel,
      minSample: 5,
    });

    expect(result.group_a.book_count).toBe(5);
    expect(result.group_a.label).toContain('writer');
    expect(result.group_a.label).toContain(baselineModel);

    expect(result.group_b.book_count).toBe(5);
    expect(result.group_b.label).toContain('writer');
    expect(result.group_b.label).toContain(candidateModel);

    expect(result.group_a.insufficient_data).toBe(false);
    expect(result.group_b.insufficient_data).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Case 7: cache_hit_rate computed correctly when cached_input_tokens > 0
  // -------------------------------------------------------------------------

  it('cache_hit_rate is correctly computed when cached_input_tokens > 0', async () => {
    const fromA = new Date('2026-01-01T00:00:00Z');
    const toA = new Date('2026-02-01T00:00:00Z');
    const fromB = new Date('2026-02-01T00:00:00Z');
    const toB = new Date('2026-03-01T00:00:00Z');

    const booksA = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const booksB = ['b1', 'b2', 'b3', 'b4', 'b5'];

    mock.$queryRawUnsafe
      .mockResolvedValueOnce(booksA.map((id) => ({ id })))
      .mockResolvedValueOnce(booksB.map((id) => ({ id })));

    // group_a: total_input=600, total_cached=200 → rate = 200/(600+200) = 0.25
    mock.book.findMany.mockResolvedValueOnce(booksA.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([
      {
        book_id: 'a1',
        _sum: { cost_jpy: 10, input_tokens: 300, cached_input_tokens: 100 },
      },
      {
        book_id: 'a2',
        _sum: { cost_jpy: 10, input_tokens: 300, cached_input_tokens: 100 },
      },
    ]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    // group_b: no cached tokens → null
    mock.book.findMany.mockResolvedValueOnce(booksB.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([
      {
        book_id: 'b1',
        _sum: { cost_jpy: 5, input_tokens: 200, cached_input_tokens: 0 },
      },
    ]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, {
      mode: 'period',
      periodA: { from: fromA, to: toA },
      periodB: { from: fromB, to: toB },
    });

    expect(result.group_a.total_input_tokens).toBe(600);
    expect(result.group_a.total_cached_input_tokens).toBe(200);
    expect(result.group_a.cache_hit_rate).toBeCloseTo(200 / 800, 5); // 0.25

    expect(result.group_b.total_input_tokens).toBe(200);
    expect(result.group_b.total_cached_input_tokens).toBe(0);
    expect(result.group_b.cache_hit_rate).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 8: cache_hit_rate is null when cached_input_tokens === 0
  // -------------------------------------------------------------------------

  it('cache_hit_rate is null when cached_input_tokens is 0 for all books', async () => {
    const fromA = new Date('2026-04-01T00:00:00Z');
    const toA = new Date('2026-05-01T00:00:00Z');
    const fromB = new Date('2026-05-01T00:00:00Z');
    const toB = new Date('2026-06-01T00:00:00Z');

    const booksA = ['a1', 'a2', 'a3', 'a4', 'a5'];

    mock.$queryRawUnsafe
      .mockResolvedValueOnce(booksA.map((id) => ({ id })))
      .mockResolvedValueOnce([]); // group_b: 0 books

    // group_a
    mock.book.findMany.mockResolvedValueOnce(booksA.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([
      {
        book_id: 'a1',
        _sum: { cost_jpy: 50, input_tokens: 1000, cached_input_tokens: 0 },
      },
    ]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    // group_b: 0 books → early return (no further mock calls needed)

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, {
      mode: 'period',
      periodA: { from: fromA, to: toA },
      periodB: { from: fromB, to: toB },
    });

    expect(result.group_a.cache_hit_rate).toBeNull();
    expect(result.group_a.total_cached_input_tokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Case 9: empty group returns all null stats with insufficient_data=true
  // -------------------------------------------------------------------------

  it('empty group returns all null stats and insufficient_data=true', async () => {
    const fromA = new Date('2026-03-01T00:00:00Z');
    const toA = new Date('2026-04-01T00:00:00Z');
    const fromB = new Date('2026-04-01T00:00:00Z');
    const toB = new Date('2026-05-01T00:00:00Z');

    // Both groups: 0 books
    mock.$queryRawUnsafe
      .mockResolvedValueOnce([]) // group_a: empty
      .mockResolvedValueOnce([]); // group_b: empty

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, {
      mode: 'period',
      periodA: { from: fromA, to: toA },
      periodB: { from: fromB, to: toB },
    });

    expect(result.group_a.book_count).toBe(0);
    expect(result.group_a.avg_quality_score).toBeNull();
    expect(result.group_a.avg_cost_jpy).toBeNull();
    expect(result.group_a.avg_lead_time_hours).toBeNull();
    expect(result.group_a.median_royalty_jpy).toBeNull();
    expect(result.group_a.total_cached_input_tokens).toBe(0);
    expect(result.group_a.total_input_tokens).toBe(0);
    expect(result.group_a.cache_hit_rate).toBeNull();
    expect(result.group_a.insufficient_data).toBe(true);
    expect(result.group_a.book_ids).toEqual([]);

    expect(result.group_b.book_count).toBe(0);
    expect(result.group_b.insufficient_data).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 10: median_royalty_jpy with even number of books uses midpoint average
  // -------------------------------------------------------------------------

  it('median_royalty_jpy uses midpoint average for even-count sorted royalties', async () => {
    const fromA = new Date('2026-01-01T00:00:00Z');
    const toA = new Date('2026-02-01T00:00:00Z');
    const fromB = new Date('2026-02-01T00:00:00Z');
    const toB = new Date('2026-03-01T00:00:00Z');

    const booksA = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const booksB = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];

    mock.$queryRawUnsafe
      .mockResolvedValueOnce(booksA.map((id) => ({ id })))
      .mockResolvedValueOnce(booksB.map((id) => ({ id })));

    // group_a: 6 books with royalties [100, 200, 300, 400, 500, 600] → median = (300+400)/2 = 350
    mock.book.findMany.mockResolvedValueOnce(booksA.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce(
      booksA.map((id, i) => ({
        book_id: id,
        _sum: { royalty_jpy: (i + 1) * 100 },
      })),
    );

    // group_b: standard
    mock.book.findMany.mockResolvedValueOnce(booksB.map((id) => makeBook(id)));
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);
    mock.salesRecord.groupBy.mockResolvedValueOnce([]);

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, {
      mode: 'period',
      periodA: { from: fromA, to: toA },
      periodB: { from: fromB, to: toB },
    });

    // [100,200,300,400,500,600] sorted: mid=(300+400)/2=350
    expect(result.group_a.median_royalty_jpy).toBeCloseTo(350, 1);
    // group_b: no sales
    expect(result.group_b.median_royalty_jpy).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 11: filter is reflected in result
  // -------------------------------------------------------------------------

  it('result.filter reflects the original input filter', async () => {
    const fromA = new Date('2026-01-01T00:00:00Z');
    const toA = new Date('2026-02-01T00:00:00Z');
    const fromB = new Date('2026-02-01T00:00:00Z');
    const toB = new Date('2026-03-01T00:00:00Z');
    const filter = { mode: 'period' as const, periodA: { from: fromA, to: toA }, periodB: { from: fromB, to: toB }, minSample: 3 };

    mock.$queryRawUnsafe
      .mockResolvedValueOnce([]) // group_a: 0 books
      .mockResolvedValueOnce([]); // group_b: 0 books

    const result = await getAbComparisonStats(mock as unknown as PrismaClient, filter);

    expect(result.filter).toBe(filter);
  });
});
