import { describe, expect, it, vi } from 'vitest';

import {
  runOrgFinanceTick,
  type OrgFinanceTickPrisma,
  type OrgFinanceTickDeps,
} from '../src/tasks/org-finance-tick.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as OrgFinanceTickDeps['logger'];

const NOW = new Date('2026-07-11T00:00:00Z');

interface HarnessOpts {
  /** token_usage 行（org_task_id で本部に紐付く）。 */
  usage: Array<{ org_task_id: string | null; book_id: string | null; cost_jpy: number }>;
  /** org_task_id → division の対応。 */
  taskDivision: Record<string, string>;
  budget_jpy: number | null;
  allocation: Record<string, number> | null;
  monthly_red: number;
  existingEnforce?: boolean;
}

function makeHarness(o: HarnessOpts) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    tokenUsage: {
      findMany: vi.fn(async () => o.usage),
    },
    orgTask: {
      findMany: vi.fn(async (args: { where: { id?: { in: string[] }; kind?: string } }) => {
        if (args.where.kind === 'enforce_limit') return o.existingEnforce ? [{ id: 'e1' }] : [];
        // division 解決
        const ids = args.where.id?.in ?? [];
        return ids.map((id) => ({ id, division: o.taskDivision[id] ?? 'production' }));
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: `t-${created.length}` };
      }),
    },
    book: {
      findMany: vi.fn(async () => [{ id: 'b1', title: '実用書A', theme: { genre: 'practical' } }]),
    },
    salesRecord: {
      findMany: vi.fn(async () => [{ book_id: 'b1', royalty_jpy: 200 }]),
    },
    orgObjective: {
      findFirst: vi.fn(async () => ({ budget_jpy: o.budget_jpy, budget_allocation_json: o.allocation })),
    },
    appSettings: {
      findUnique: vi.fn(async () => ({ monthly_cost_red_jpy: o.monthly_red })),
    },
    job: { update: vi.fn(async () => ({})) },
  } as unknown as OrgFinanceTickPrisma;
  return { prisma, created };
}

const deps = (prisma: OrgFinanceTickPrisma): OrgFinanceTickDeps => ({ prisma, logger: silentLogger, now: () => NOW });

describe('runOrgFinanceTick', () => {
  it('本部予算を超過したら enforce_limit(needs_human) を起票する', async () => {
    // production に 100 使い、配分は 50 → 超過
    const { prisma, created } = makeHarness({
      usage: [{ org_task_id: 'tp', book_id: 'b1', cost_jpy: 100 }],
      taskDivision: { tp: 'production' },
      budget_jpy: 10000,
      allocation: { production: 50 },
      monthly_red: 50000,
    });
    const res = await runOrgFinanceTick({}, deps(prisma));
    expect(res.breaches).toBeGreaterThanOrEqual(1);
    expect(res.enforce_created).toBe(true);
    expect(created[0]!.kind).toBe('enforce_limit');
    expect(created[0]!.status).toBe('needs_human');
    expect(created[0]!.priority).toBe('must');
    expect(created[0]!.division).toBe('finance');
  });

  it('予算内なら何も起票しない', async () => {
    const { prisma, created } = makeHarness({
      usage: [{ org_task_id: 'tp', book_id: 'b1', cost_jpy: 10 }],
      taskDivision: { tp: 'production' },
      budget_jpy: 10000,
      allocation: { production: 5000 },
      monthly_red: 50000,
    });
    const res = await runOrgFinanceTick({}, deps(prisma));
    expect(res.breaches).toBe(0);
    expect(res.enforce_created).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('月次上限(monthly_cost_red)を超えたら全社breachとして起票する', async () => {
    const { prisma, created } = makeHarness({
      usage: [{ org_task_id: 'tp', book_id: 'b1', cost_jpy: 60000 }],
      taskDivision: { tp: 'production' },
      budget_jpy: null,
      allocation: null,
      monthly_red: 50000,
    });
    const res = await runOrgFinanceTick({}, deps(prisma));
    expect(res.enforce_created).toBe(true);
    expect(created[0]!.kind).toBe('enforce_limit');
  });

  it('既に開いている enforce_limit があれば重複起票しない', async () => {
    const { prisma, created } = makeHarness({
      usage: [{ org_task_id: 'tp', book_id: 'b1', cost_jpy: 100 }],
      taskDivision: { tp: 'production' },
      budget_jpy: 10000,
      allocation: { production: 50 },
      monthly_red: 50000,
      existingEnforce: true,
    });
    const res = await runOrgFinanceTick({}, deps(prisma));
    expect(res.skipped_existing).toBe(true);
    expect(res.enforce_created).toBe(false);
    expect(created).toHaveLength(0);
  });
});
