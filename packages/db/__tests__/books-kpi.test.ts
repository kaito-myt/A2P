import { describe, it, expect, vi } from 'vitest';
import { getMonthlyGenreSales } from '../src/books-kpi.js';
import type { PrismaClient } from '../generated/index.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type MockPrisma = {
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
};

function createMockPrisma(): MockPrisma {
  return {
    $queryRawUnsafe: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// getMonthlyGenreSales
// ---------------------------------------------------------------------------

describe('getMonthlyGenreSales', () => {
  it('returns per-(genre, ym) rows from the query result', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      { ym: '2026-01', genre: 'practical', royalty_jpy: 10000 },
      { ym: '2026-01', genre: 'business', royalty_jpy: 5000 },
      { ym: '2026-02', genre: 'self_help', royalty_jpy: 3000 },
    ]);

    const result = await getMonthlyGenreSales(mock as unknown as PrismaClient, {});

    expect(result).toHaveLength(3);
    const jan_practical = result.find((r) => r.ym === '2026-01' && r.genre === 'practical');
    const jan_business = result.find((r) => r.ym === '2026-01' && r.genre === 'business');
    const feb_self_help = result.find((r) => r.ym === '2026-02' && r.genre === 'self_help');

    expect(jan_practical?.royalty_jpy).toBe(10000);
    expect(jan_business?.royalty_jpy).toBe(5000);
    expect(feb_self_help?.royalty_jpy).toBe(3000);
  });

  it('sales land in their actual months, not collapsed to a single month', async () => {
    const mock = createMockPrisma();
    // Three months of data: each month has distinct values — no cross-month bleed
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      { ym: '2026-01', genre: 'practical', royalty_jpy: 1000 },
      { ym: '2026-02', genre: 'practical', royalty_jpy: 2000 },
      { ym: '2026-03', genre: 'practical', royalty_jpy: 3000 },
    ]);

    const result = await getMonthlyGenreSales(mock as unknown as PrismaClient, {
      periodFrom: '2026-01',
      periodTo: '2026-03',
    });

    expect(result).toHaveLength(3);
    expect(result.find((r) => r.ym === '2026-01')?.royalty_jpy).toBe(1000);
    expect(result.find((r) => r.ym === '2026-02')?.royalty_jpy).toBe(2000);
    expect(result.find((r) => r.ym === '2026-03')?.royalty_jpy).toBe(3000);

    // Values are NOT all collapsed to one month (the old buildHeatmapMatrix / buildTrendChartData bug)
    const total = result.reduce((acc, r) => acc + r.royalty_jpy, 0);
    expect(total).toBe(6000);
    expect(result.every((r) => r.royalty_jpy < total)).toBe(true);
  });

  it('returns empty array for no sales data', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);

    const result = await getMonthlyGenreSales(mock as unknown as PrismaClient, {});
    expect(result).toHaveLength(0);
  });

  it('passes accountId and genre filters as parameters', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);

    await getMonthlyGenreSales(mock as unknown as PrismaClient, {
      accountId: 'acc-1',
      genre: 'business',
      periodFrom: '2026-01',
      periodTo: '2026-06',
    });

    // Verify the SQL was called with all 4 params (accountId, genre, periodFrom, periodTo)
    const callArgs = mock.$queryRawUnsafe.mock.calls[0] as unknown[];
    expect(callArgs).toHaveLength(5); // sql + 4 params
    expect(callArgs[1]).toBe('acc-1');
    expect(callArgs[2]).toBe('business');
    expect(callArgs[3]).toBe('2026-01');
    expect(callArgs[4]).toBe('2026-06');
  });

  it('passes only period params when no accountId/genre filter', async () => {
    const mock = createMockPrisma();
    mock.$queryRawUnsafe.mockResolvedValueOnce([]);

    await getMonthlyGenreSales(mock as unknown as PrismaClient, {
      periodFrom: '2026-03',
      periodTo: '2026-05',
    });

    const callArgs = mock.$queryRawUnsafe.mock.calls[0] as unknown[];
    expect(callArgs).toHaveLength(3); // sql + 2 params (periodFrom, periodTo)
    expect(callArgs[1]).toBe('2026-03');
    expect(callArgs[2]).toBe('2026-05');
  });

  it('handles Prisma BigInt/Decimal values via toNumber conversion', async () => {
    const mock = createMockPrisma();
    // Simulate BigInt as returned by PostgreSQL
    mock.$queryRawUnsafe.mockResolvedValueOnce([
      { ym: '2026-01', genre: 'practical', royalty_jpy: BigInt(12345) },
    ]);

    const result = await getMonthlyGenreSales(mock as unknown as PrismaClient, {});
    expect(result[0]?.royalty_jpy).toBe(12345);
    expect(typeof result[0]?.royalty_jpy).toBe('number');
  });
});
