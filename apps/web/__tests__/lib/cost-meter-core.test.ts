/**
 * cost-meter-core.ts のユニットテスト (T-07-06).
 *
 * 検証:
 *  - getCostLevel: ratio -> level マッピング (境界値テスト)
 *  - getCostMeterData: Prisma DI mock で正しい形状を返す
 */
import { describe, expect, it, vi } from 'vitest';

import {
  getCostLevel,
  getCostMeterData,
  type CostMeterPrisma,
} from '@/lib/cost-meter-core';

// ---------------------------------------------------------------------------
// getCostLevel
// ---------------------------------------------------------------------------

describe('getCostLevel', () => {
  it.each([
    [0, 'green'],
    [50, 'green'],
    [79.9, 'green'],
    [80, 'yellow'],
    [90, 'yellow'],
    [94.9, 'yellow'],
    [95, 'orange'],
    [99.9, 'orange'],
    [100, 'red'],
    [150, 'red'],
  ] as const)('ratio %f -> level %s', (ratio, expected) => {
    expect(getCostLevel(ratio)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// getCostMeterData
// ---------------------------------------------------------------------------

function makePrisma(opts: {
  costJpy?: number;
  warnCount?: number;
  pausedCount?: number;
  budgetJpy?: number;
}): CostMeterPrisma {
  return {
    tokenUsage: {
      aggregate: vi.fn(async () => ({
        _sum: { cost_jpy: opts.costJpy ?? 0 },
      })),
    },
    book: {
      count: vi.fn(async (args: { where: { cost_status: string } }) => {
        if (args.where.cost_status === 'warn') return opts.warnCount ?? 0;
        if (args.where.cost_status === 'paused') return opts.pausedCount ?? 0;
        return 0;
      }),
    },
    appSettings: {
      findUnique: vi.fn(async () =>
        opts.budgetJpy !== undefined
          ? { monthly_cost_red_jpy: opts.budgetJpy }
          : null,
      ),
    },
  };
}

describe('getCostMeterData', () => {
  it('returns correct shape with zero cost', async () => {
    const prisma = makePrisma({});
    const result = await getCostMeterData(prisma, new Date(2026, 4, 15));

    expect(result).toEqual({
      monthly_cost_jpy: 0,
      budget_jpy: 50_000,
      ratio: 0,
      level: 'green',
      remaining: 50_000,
      warn_count: 0,
      paused_count: 0,
    });
  });

  it('computes ratio and level correctly at 80%', async () => {
    const prisma = makePrisma({ costJpy: 40_000, budgetJpy: 50_000 });
    const result = await getCostMeterData(prisma, new Date(2026, 4, 15));

    expect(result.monthly_cost_jpy).toBe(40_000);
    expect(result.ratio).toBe(80);
    expect(result.level).toBe('yellow');
    expect(result.remaining).toBe(10_000);
  });

  it('computes ratio and level correctly at 95%', async () => {
    const prisma = makePrisma({ costJpy: 47_500, budgetJpy: 50_000 });
    const result = await getCostMeterData(prisma, new Date(2026, 4, 15));

    expect(result.ratio).toBe(95);
    expect(result.level).toBe('orange');
    expect(result.remaining).toBe(2_500);
  });

  it('computes ratio and level correctly at 100%+', async () => {
    const prisma = makePrisma({ costJpy: 55_000, budgetJpy: 50_000 });
    const result = await getCostMeterData(prisma, new Date(2026, 4, 15));

    expect(result.ratio).toBe(110);
    expect(result.level).toBe('red');
    expect(result.remaining).toBe(0);
  });

  it('includes warn and paused counts', async () => {
    const prisma = makePrisma({ costJpy: 25_000, warnCount: 3, pausedCount: 1, budgetJpy: 50_000 });
    const result = await getCostMeterData(prisma, new Date(2026, 4, 15));

    expect(result.warn_count).toBe(3);
    expect(result.paused_count).toBe(1);
  });

  it('uses default budget when settings not found', async () => {
    const prisma = makePrisma({ costJpy: 10_000 });
    const result = await getCostMeterData(prisma, new Date(2026, 4, 15));

    expect(result.budget_jpy).toBe(50_000);
    expect(result.ratio).toBe(20);
    expect(result.level).toBe('green');
  });

  it('uses custom budget from settings', async () => {
    const prisma = makePrisma({ costJpy: 10_000, budgetJpy: 20_000 });
    const result = await getCostMeterData(prisma, new Date(2026, 4, 15));

    expect(result.budget_jpy).toBe(20_000);
    expect(result.ratio).toBe(50);
    expect(result.level).toBe('green');
  });

  it('handles null cost_jpy from aggregate', async () => {
    const prisma: CostMeterPrisma = {
      tokenUsage: {
        aggregate: vi.fn(async () => ({ _sum: { cost_jpy: null } })),
      },
      book: {
        count: vi.fn(async () => 0),
      },
      appSettings: {
        findUnique: vi.fn(async () => ({ monthly_cost_red_jpy: 50_000 })),
      },
    };

    const result = await getCostMeterData(prisma, new Date(2026, 4, 15));
    expect(result.monthly_cost_jpy).toBe(0);
    expect(result.ratio).toBe(0);
    expect(result.level).toBe('green');
  });

  it('passes correct date range to aggregate', async () => {
    const aggFn = vi.fn(async () => ({ _sum: { cost_jpy: 0 } }));
    const prisma: CostMeterPrisma = {
      tokenUsage: { aggregate: aggFn },
      book: { count: vi.fn(async () => 0) },
      appSettings: {
        findUnique: vi.fn(async () => null),
      },
    };

    await getCostMeterData(prisma, new Date(2026, 4, 15));

    expect(aggFn).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = aggFn.mock.calls as any[][];
    const callArgs = calls[0]?.[0] as
      | { where: { created_at: { gte: Date; lt: Date } } }
      | undefined;
    expect(callArgs).toBeDefined();
    expect(callArgs!.where.created_at.gte).toEqual(new Date(Date.UTC(2026, 4, 1)));
    expect(callArgs!.where.created_at.lt).toEqual(new Date(Date.UTC(2026, 5, 1)));
  });
});
