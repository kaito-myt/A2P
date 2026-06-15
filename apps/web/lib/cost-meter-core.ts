/**
 * CostMeter のコアロジック (T-07-06 / docs/04 §3.2 / docs/05 §4.2).
 *
 * Route Handler `/api/cost/current` から呼ばれる。
 * テスト容易性のため Prisma を DI で受け取る。
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CostLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface CostMeterData {
  monthly_cost_jpy: number;
  budget_jpy: number;
  ratio: number;
  level: CostLevel;
  remaining: number;
  warn_count: number;
  paused_count: number;
}

export interface CostMeterPrisma {
  tokenUsage: {
    aggregate: (args: {
      where: { created_at: { gte: Date; lt: Date } };
      _sum: { cost_jpy: true };
    }) => Promise<{ _sum: { cost_jpy: unknown } }>;
  };
  book: {
    count: (args: { where: { cost_status: string } }) => Promise<number>;
  };
  appSettings: {
    findUnique: (args: {
      where: { id: string };
      select: { monthly_cost_red_jpy: true };
    }) => Promise<{ monthly_cost_red_jpy: number } | null>;
  };
}

// ---------------------------------------------------------------------------
// Level calculation (docs/04 §3.2: 0-80% green, 80-95% yellow, 95-100% orange, 100%+ red)
// ---------------------------------------------------------------------------

export function getCostLevel(ratioPct: number): CostLevel {
  if (ratioPct >= 100) return 'red';
  if (ratioPct >= 95) return 'orange';
  if (ratioPct >= 80) return 'yellow';
  return 'green';
}

// ---------------------------------------------------------------------------
// Data fetcher
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_JPY = 50_000;

function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getCostMeterData(
  prisma: CostMeterPrisma,
  now?: Date,
): Promise<CostMeterData> {
  const current = now ?? new Date();
  const year = current.getFullYear();
  const month = current.getMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));

  const [costResult, warnCount, pausedCount, settings] = await Promise.all([
    prisma.tokenUsage.aggregate({
      where: { created_at: { gte: start, lt: end } },
      _sum: { cost_jpy: true },
    }),
    prisma.book.count({ where: { cost_status: 'warn' } }),
    prisma.book.count({ where: { cost_status: 'paused' } }),
    prisma.appSettings.findUnique({
      where: { id: 'singleton' },
      select: { monthly_cost_red_jpy: true },
    }),
  ]);

  const monthlyCostJpy = toNumber(costResult._sum.cost_jpy);
  const budgetJpy = settings?.monthly_cost_red_jpy ?? DEFAULT_BUDGET_JPY;
  const ratioPct = budgetJpy > 0 ? (monthlyCostJpy / budgetJpy) * 100 : 0;
  const remaining = Math.max(budgetJpy - monthlyCostJpy, 0);

  return {
    monthly_cost_jpy: Math.round(monthlyCostJpy),
    budget_jpy: budgetJpy,
    ratio: Math.round(ratioPct * 10) / 10,
    level: getCostLevel(ratioPct),
    remaining: Math.round(remaining),
    warn_count: warnCount,
    paused_count: pausedCount,
  };
}
