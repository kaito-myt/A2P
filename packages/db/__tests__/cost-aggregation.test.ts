import { describe, it, expect, vi } from 'vitest';
import {
  getBookCostBreakdown,
  getMonthlyTotalCost,
  getTopCostBooks,
} from '../src/cost-aggregation.js';
import type { PrismaClient } from '../generated/index.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type MockPrisma = {
  tokenUsage: {
    groupBy: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
};

function createMockPrisma(): MockPrisma {
  return {
    tokenUsage: {
      groupBy: vi.fn(),
      aggregate: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// getBookCostBreakdown
// ---------------------------------------------------------------------------

describe('getBookCostBreakdown', () => {
  it('groups by provider/model/role and returns sorted rows', async () => {
    const mock = createMockPrisma();
    mock.tokenUsage.groupBy.mockResolvedValueOnce([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        role: 'editor',
        _sum: { cost_jpy: 10.5, input_tokens: 1000, output_tokens: 500, cached_input_tokens: 200, image_count: 0 },
      },
      {
        provider: 'openai',
        model: 'gpt-image-1',
        role: 'thumbnail_image',
        _sum: { cost_jpy: 50.0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, image_count: 2 },
      },
      {
        provider: 'anthropic',
        model: 'claude-opus-4-20250514',
        role: 'writer',
        _sum: { cost_jpy: 120.3, input_tokens: 5000, output_tokens: 3000, cached_input_tokens: 1500, image_count: 0 },
      },
    ]);

    const result = await getBookCostBreakdown(mock as unknown as PrismaClient, 'book-1');

    expect(mock.tokenUsage.groupBy).toHaveBeenCalledWith({
      by: ['provider', 'model', 'role'],
      where: { book_id: 'book-1' },
      _sum: {
        cost_jpy: true,
        input_tokens: true,
        output_tokens: true,
        cached_input_tokens: true,
        image_count: true,
      },
    });

    expect(result.book_id).toBe('book-1');
    expect(result.rows).toHaveLength(3);

    // Sorted by cost_jpy descending
    expect(result.rows[0]!.role).toBe('writer');
    expect(result.rows[0]!.cost_jpy).toBe(120.3);
    expect(result.rows[0]!.cached_input_tokens).toBe(1500);
    expect(result.rows[1]!.role).toBe('thumbnail_image');
    expect(result.rows[1]!.cost_jpy).toBe(50.0);
    expect(result.rows[2]!.role).toBe('editor');
    expect(result.rows[2]!.cost_jpy).toBe(10.5);
    expect(result.rows[2]!.cached_input_tokens).toBe(200);

    expect(result.total_cost_jpy).toBeCloseTo(180.8);
    expect(result.total_input_tokens).toBe(6000);
    expect(result.total_output_tokens).toBe(3500);
    expect(result.total_cached_input_tokens).toBe(1700);
    expect(result.total_image_count).toBe(2);
  });

  it('returns empty breakdown for book with no token_usage', async () => {
    const mock = createMockPrisma();
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);

    const result = await getBookCostBreakdown(mock as unknown as PrismaClient, 'empty-book');

    expect(result.book_id).toBe('empty-book');
    expect(result.rows).toHaveLength(0);
    expect(result.total_cost_jpy).toBe(0);
    expect(result.total_input_tokens).toBe(0);
    expect(result.total_output_tokens).toBe(0);
    expect(result.total_cached_input_tokens).toBe(0);
    expect(result.total_image_count).toBe(0);
  });

  it('handles null _sum fields gracefully', async () => {
    const mock = createMockPrisma();
    mock.tokenUsage.groupBy.mockResolvedValueOnce([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        role: 'writer',
        _sum: {
          cost_jpy: null,
          input_tokens: null,
          output_tokens: null,
          cached_input_tokens: null,
          image_count: null,
        },
      },
    ]);

    const result = await getBookCostBreakdown(mock as unknown as PrismaClient, 'null-book');

    expect(result.rows[0]!.cost_jpy).toBe(0);
    expect(result.rows[0]!.input_tokens).toBe(0);
    expect(result.rows[0]!.output_tokens).toBe(0);
    expect(result.rows[0]!.cached_input_tokens).toBe(0);
    expect(result.rows[0]!.image_count).toBe(0);
    expect(result.total_cost_jpy).toBe(0);
  });

  it('handles Prisma Decimal objects via toNumber conversion', async () => {
    const mock = createMockPrisma();
    const decimalLike = { toString: () => '42.1234', valueOf: () => 42.1234 };
    mock.tokenUsage.groupBy.mockResolvedValueOnce([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        role: 'writer',
        _sum: { cost_jpy: decimalLike, input_tokens: 100, output_tokens: 50, cached_input_tokens: 30, image_count: 0 },
      },
    ]);

    const result = await getBookCostBreakdown(mock as unknown as PrismaClient, 'decimal-book');

    expect(result.rows[0]!.cost_jpy).toBeCloseTo(42.1234);
    expect(result.total_cost_jpy).toBeCloseTo(42.1234);
  });
});

// ---------------------------------------------------------------------------
// getMonthlyTotalCost
// ---------------------------------------------------------------------------

describe('getMonthlyTotalCost', () => {
  it('aggregates cost_jpy for the given year/month', async () => {
    const mock = createMockPrisma();
    mock.tokenUsage.aggregate.mockResolvedValueOnce({
      _sum: { cost_jpy: 32500.75 },
    });

    const result = await getMonthlyTotalCost(mock as unknown as PrismaClient, 2026, 5);

    expect(mock.tokenUsage.aggregate).toHaveBeenCalledWith({
      where: {
        created_at: {
          gte: new Date(Date.UTC(2026, 4, 1)),
          lt: new Date(Date.UTC(2026, 5, 1)),
        },
      },
      _sum: { cost_jpy: true },
    });

    expect(result.year).toBe(2026);
    expect(result.month).toBe(5);
    expect(result.total_cost_jpy).toBeCloseTo(32500.75);
  });

  it('returns zero for month with no usage', async () => {
    const mock = createMockPrisma();
    mock.tokenUsage.aggregate.mockResolvedValueOnce({
      _sum: { cost_jpy: null },
    });

    const result = await getMonthlyTotalCost(mock as unknown as PrismaClient, 2026, 1);

    expect(result.total_cost_jpy).toBe(0);
  });

  it('handles December -> January year boundary correctly', async () => {
    const mock = createMockPrisma();
    mock.tokenUsage.aggregate.mockResolvedValueOnce({
      _sum: { cost_jpy: 100 },
    });

    await getMonthlyTotalCost(mock as unknown as PrismaClient, 2026, 12);

    expect(mock.tokenUsage.aggregate).toHaveBeenCalledWith({
      where: {
        created_at: {
          gte: new Date(Date.UTC(2026, 11, 1)), // Dec 1
          lt: new Date(Date.UTC(2027, 0, 1)),   // Jan 1 next year
        },
      },
      _sum: { cost_jpy: true },
    });
  });
});

// ---------------------------------------------------------------------------
// getTopCostBooks
// ---------------------------------------------------------------------------

describe('getTopCostBooks', () => {
  it('returns top N books by cost descending', async () => {
    const mock = createMockPrisma();
    mock.tokenUsage.groupBy.mockResolvedValueOnce([
      {
        book_id: 'book-a',
        _sum: { cost_jpy: 500.0, input_tokens: 20000, output_tokens: 10000, image_count: 3 },
      },
      {
        book_id: 'book-b',
        _sum: { cost_jpy: 300.0, input_tokens: 15000, output_tokens: 8000, image_count: 1 },
      },
    ]);

    const result = await getTopCostBooks(mock as unknown as PrismaClient, 2);

    expect(mock.tokenUsage.groupBy).toHaveBeenCalledWith({
      by: ['book_id'],
      where: { book_id: { not: null } },
      _sum: {
        cost_jpy: true,
        input_tokens: true,
        output_tokens: true,
        image_count: true,
      },
      orderBy: { _sum: { cost_jpy: 'desc' } },
      take: 2,
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.book_id).toBe('book-a');
    expect(result[0]!.total_cost_jpy).toBe(500.0);
    expect(result[1]!.book_id).toBe('book-b');
    expect(result[1]!.total_cost_jpy).toBe(300.0);
  });

  it('returns empty array when no books have token_usage', async () => {
    const mock = createMockPrisma();
    mock.tokenUsage.groupBy.mockResolvedValueOnce([]);

    const result = await getTopCostBooks(mock as unknown as PrismaClient, 10);

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Performance benchmark: 100 books x 50 rows mock
// ---------------------------------------------------------------------------

describe('performance benchmark', () => {
  it('getBookCostBreakdown processes mock groupBy result within 1 second', async () => {
    const providers = ['anthropic', 'openai', 'google'];
    const models = [
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'gpt-image-1',
      'gemini-2.5-flash',
    ];
    const roles = [
      'marketer',
      'writer',
      'editor',
      'judge',
      'thumbnail_text',
      'thumbnail_image',
      'optimizer',
      'revision',
    ];

    // Generate realistic groupBy result: up to provider x model x role combinations
    const mockGroupByResult = [];
    for (const provider of providers) {
      for (const model of models) {
        for (const role of roles) {
          mockGroupByResult.push({
            provider,
            model,
            role,
            _sum: {
              cost_jpy: Math.random() * 100,
              input_tokens: Math.floor(Math.random() * 10000),
              output_tokens: Math.floor(Math.random() * 5000),
              cached_input_tokens: Math.floor(Math.random() * 3000),
              image_count: role === 'thumbnail_image' ? Math.floor(Math.random() * 5) : 0,
            },
          });
        }
      }
    }

    const mock = createMockPrisma();

    const start = performance.now();
    const iterations = 100; // 100 books

    for (let i = 0; i < iterations; i++) {
      mock.tokenUsage.groupBy.mockResolvedValueOnce(mockGroupByResult);
      await getBookCostBreakdown(mock as unknown as PrismaClient, `book-${i}`);
    }

    const elapsed = performance.now() - start;

    // F-033 acceptance: 1 second max for the client-side processing
    expect(elapsed).toBeLessThan(1000);
  });

  it('getMonthlyTotalCost processes 100 calls within 1 second', async () => {
    const mock = createMockPrisma();

    const start = performance.now();

    for (let i = 0; i < 100; i++) {
      mock.tokenUsage.aggregate.mockResolvedValueOnce({
        _sum: { cost_jpy: Math.random() * 50000 },
      });
      await getMonthlyTotalCost(mock as unknown as PrismaClient, 2026, (i % 12) + 1);
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  it('getTopCostBooks processes result with 100 books within 1 second', async () => {
    const mock = createMockPrisma();
    const bigResult = Array.from({ length: 100 }, (_, i) => ({
      book_id: `book-${i}`,
      _sum: {
        cost_jpy: (100 - i) * 50,
        input_tokens: (100 - i) * 1000,
        output_tokens: (100 - i) * 500,
        image_count: Math.floor(Math.random() * 5),
      },
    }));
    mock.tokenUsage.groupBy.mockResolvedValueOnce(bigResult);

    const start = performance.now();
    const result = await getTopCostBooks(mock as unknown as PrismaClient, 100);
    const elapsed = performance.now() - start;

    expect(result).toHaveLength(100);
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Index verification
// ---------------------------------------------------------------------------

describe('index verification', () => {
  it('token_usage_book_time_idx is defined in schema for book_id queries', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(here, '..', 'schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');

    expect(schema).toContain('token_usage_book_time_idx');
    expect(schema).toMatch(/@@index\(\[book_id,\s*created_at\]/);
  });

  it('token_usage_time_idx is defined for monthly aggregate queries', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(here, '..', 'schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');

    expect(schema).toContain('token_usage_time_idx');
  });
});
