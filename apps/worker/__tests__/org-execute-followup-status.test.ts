import { describe, expect, it, vi } from 'vitest';

// 人手前提 kind (HUMAN_KINDS) の連鎖起票が needs_human のままになることを検証するため、
// finance 本部の既定 follow-up kind を一時的に人手 kind (enforce_limit) に差し替える。
// 他の実挙動 (isHumanKind, DIVISION_KINDS 等) は importOriginal でそのまま使う。
vi.mock('@a2p/contracts/org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@a2p/contracts/org')>();
  return {
    ...actual,
    DIVISION_DEFAULT_KIND: { ...actual.DIVISION_DEFAULT_KIND, finance: 'enforce_limit' },
  };
});

import type { CostReportOutput } from '@a2p/contracts/org';

import {
  runOrgExecute,
  type DispatchTaskRow,
  type OrgExecuteDeps,
  type OrgExecutePrisma,
} from '../src/tasks/org-execute.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as OrgExecuteDeps['logger'];

function task(over: Partial<DispatchTaskRow>): DispatchTaskRow {
  return {
    id: 't1',
    objective_id: 'obj1',
    division: 'finance',
    kind: 'cost_report',
    book_id: null,
    instruction: 'コストを集計',
    title: 'タスク',
    priority: 'should',
    depends_on: [],
    theme_id: null,
    account_id: null,
    scheduled_for: null,
    created_at: new Date('2026-07-10T00:00:00Z'),
    ...over,
  };
}

function makeHarness(candidates: DispatchTaskRow[]) {
  const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
  const created: Array<Record<string, unknown>> = [];
  const claims = new Set<string>();

  const prisma = {
    orgTask: {
      findMany: vi.fn(async (args: { where: { status?: string } }) => {
        if (args.where?.status === 'approved') return candidates;
        return [];
      }),
      updateMany: vi.fn(async (args: { where: { id: string }; data: unknown }) => {
        if (claims.has(args.where.id)) return { count: 0 };
        claims.add(args.where.id);
        return { count: 1 };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updated.push({ id: args.where.id, data: args.data });
        return {};
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: `new-${created.length}` };
      }),
    },
    book: { findMany: vi.fn(async () => []) },
    salesRecord: { findMany: vi.fn(async () => []) },
    tokenUsage: {
      aggregate: vi.fn(async () => ({ _sum: { cost_jpy: 1 } })),
      findMany: vi.fn(async () => []),
    },
    orgObjective: { findFirst: vi.fn(async () => null) },
    appSettings: { findUnique: vi.fn(async () => ({ monthly_cost_red_jpy: 50000 })) },
    job: { update: vi.fn(async () => ({})) },
  } as unknown as OrgExecutePrisma;

  return { prisma, updated, created };
}

const costOut: CostReportOutput = {
  summary: '予算超過の疑い',
  findings: ['finance 消化率高'],
  loss_making: [],
  suggestions: [{ division: 'finance', action: '予算配分を見直す', rationale: '超過リスク' }],
};

describe('runOrgExecute — 連鎖起票の status 分岐', () => {
  it('人手前提 kind (isHumanKind) の follow-up は needs_human のまま起票される', async () => {
    const { prisma, created } = makeHarness([task({ id: 'f1' })]);
    const reviewCosts = vi.fn(async () => costOut);
    const res = await runOrgExecute(
      {},
      {
        logger: silentLogger,
        now: () => new Date('2026-07-10T00:00:00Z'),
        genId: () => 'gen-id',
        analyzeSales: vi.fn(),
        researchMarket: vi.fn(),
        draftMetadata: vi.fn(),
        analyzePromotion: vi.fn(),
        reviewCosts,
        planAccountStrategy: vi.fn(),
        enqueueJob: vi.fn(async () => 'gj'),
        prisma,
      },
    );

    expect(res.done).toBe(1);
    expect(res.follow_ups_created).toBe(1);
    const fu = created.find((c) => c.kind === 'enforce_limit')!;
    expect(fu).toBeTruthy();
    expect(fu.status).toBe('needs_human');
    expect(fu.assignee_role).toBe('human');
  });
});
