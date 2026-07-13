import { describe, expect, it, vi } from 'vitest';

import type { CeoPlanOutput, ManagerPlanOutput } from '@a2p/contracts/org';

import {
  buildCompanySnapshot,
  runOrgPlan,
  type OrgPlanDeps,
  type OrgPlanPrisma,
} from '../src/tasks/org-plan.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as OrgPlanDeps['logger'];

function makePrisma(overrides: Partial<Record<string, unknown>> = {}) {
  const created = { objectives: [] as unknown[], tasks: [] as Record<string, unknown>[] };
  const closedActive = { count: 0 };
  const playbookUpserts: unknown[] = [];

  const prisma = {
    book: {
      findMany: vi.fn(async () => [
        { id: 'book1', title: '実用書A', status: 'done', publish_status: 'published', theme: { genre: 'practical' } },
        { id: 'book2', title: '自己啓発B', status: 'needs_human_review', publish_status: 'unlisted', theme: { genre: 'self_help' } },
      ]),
    },
    salesRecord: {
      findMany: vi.fn(async () => [
        { book_id: 'book1', year_month: '2026-06', royalty_jpy: 300, book: { title: '実用書A' } },
        { book_id: 'book1', year_month: '2026-07', royalty_jpy: 500, book: { title: '実用書A' } },
      ]),
    },
    tokenUsage: {
      aggregate: vi.fn(async () => ({ _sum: { cost_jpy: 1234.5 } })),
    },
    appSettings: {
      findUnique: vi.fn(async () => ({ monthly_cost_red_jpy: 50000 })),
    },
    promotionChannelSetting: {
      findMany: vi.fn(async () => [
        { channel: 'x', auto_enabled: true, handle: '@a2p', token_mask: 'tok…1234' },
        { channel: 'note', auto_enabled: false, handle: null, token_mask: null },
      ]),
    },
    orgTask: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.tasks.push(data);
        return { id: `task-${created.tasks.length}` };
      }),
    },
    orgObjective: {
      updateMany: vi.fn(async () => {
        closedActive.count += 1;
        return { count: 1 };
      }),
      create: vi.fn(async ({ data }: { data: unknown }) => {
        created.objectives.push(data);
        return { id: 'obj1' };
      }),
    },
    orgPlaybook: {
      upsert: vi.fn(async ({ create }: { create: { patterns_json: unknown } }) => {
        playbookUpserts.push(create.patterns_json);
        return {};
      }),
    },
    ...overrides,
  } as unknown as OrgPlanPrisma;

  return { prisma, created, closedActive, playbookUpserts };
}

const ceoOutput: CeoPlanOutput = {
  title: '7月方針',
  period_label: '2026-07',
  body: { focus_books: [], goals: ['在庫を増やす'], kpi: ['公開点数+2'], notes: 'コスト規律' },
  budget_jpy: 30000,
  budget_allocation: { production: 20000, promotion: 5000 },
  division_briefs: {
    production: '実用書を1冊執筆',
    promotion: 'book1 を X で告知、新規アカウントも検討',
    // analytics/publishing/sysops/finance は今サイクル動かさない
  },
};

function managerFor(division: string): ManagerPlanOutput {
  if (division === 'production') {
    return { tasks: [{ kind: 'write', title: '第1章執筆', instruction: '…', priority: 'must', book_id: 'book2', assignee_role: 'writer' }] };
  }
  if (division === 'promotion') {
    return {
      tasks: [
        { kind: 'create_content', title: 'X告知文', instruction: '…', priority: 'should', book_id: 'book1', channel: 'x', assignee_role: 'content_creator' },
        { kind: 'create_account', title: 'TikTok開設', instruction: '…', priority: 'may', channel: 'tiktok', assignee_role: 'content_creator' },
        // 存在しない book_id は null に落とされる
        { kind: 'publish_post', title: 'ゴミ', instruction: '…', priority: 'may', book_id: 'ghost', channel: 'x', assignee_role: 'publisher_worker' },
      ],
    };
  }
  return { tasks: [] };
}

describe('buildCompanySnapshot', () => {
  it('全社状況を集約する', async () => {
    const { prisma } = makePrisma();
    const now = new Date('2026-07-09T00:00:00Z');
    const { snapshot, candidateBooks, channels } = await buildCompanySnapshot(prisma, now);

    expect(snapshot.period_label).toBe('2026-07');
    expect(snapshot.books.total).toBe(2);
    expect(snapshot.books.published).toBe(1);
    expect(snapshot.books.needs_human_review).toBe(1);
    expect(snapshot.sales.total_royalty_jpy).toBe(800);
    expect(snapshot.sales.last_month_royalty_jpy).toBe(500); // 最新月 2026-07
    expect(snapshot.sales.top_books[0]).toEqual({ title: '実用書A', royalty_jpy: 800 });
    expect(snapshot.cost.month_jpy).toBe(1235); // rounded
    expect(snapshot.cost.monthly_budget_jpy).toBe(50000);
    expect(snapshot.channels.connected).toEqual(['x']); // note は未接続
    expect(snapshot.channels.auto_enabled).toEqual(['x']);
    // 勝ちパターン: practical が稼ぐジャンル、self_help は在庫あるが売上0
    expect(snapshot.winning_patterns?.top_genres[0]?.genre).toBe('practical');
    expect(snapshot.winning_patterns?.insights.length ?? 0).toBeGreaterThan(0);
    expect(candidateBooks).toHaveLength(2);
    expect(channels).toHaveLength(2);
  });
});

describe('runOrgPlan', () => {
  it('方針を作成し前アクティブを閉じ、本部長のタスクを起票する', async () => {
    const { prisma, created, closedActive, playbookUpserts } = makePrisma();
    const planObjective = vi.fn(async () => ceoOutput);
    const planDivisionTasks = vi.fn(async ({ division }: { division: string }) => managerFor(division));

    const res = await runOrgPlan(
      { trigger: 'manual' },
      { prisma, logger: silentLogger, planObjective, planDivisionTasks, now: () => new Date('2026-07-09T00:00:00Z') },
    );

    // 前アクティブを閉じてから作成
    expect(closedActive.count).toBe(1);
    expect(created.objectives).toHaveLength(1);

    // 勝ちパターン台帳を蓄積
    expect(playbookUpserts).toHaveLength(1);
    expect((playbookUpserts[0] as { top_genres: unknown[] }).top_genres.length).toBeGreaterThan(0);

    // ブリーフのある本部のみ起動（production + promotion）
    expect(planDivisionTasks).toHaveBeenCalledTimes(2);

    // production:1 + promotion:3 = 4 起票
    expect(res.tasks_created).toBe(4);
    expect(res.by_division.production).toBe(1);
    expect(res.by_division.promotion).toBe(3);

    // write は approved（自動承認）
    const write = created.tasks.find((t) => t.kind === 'write')!;
    expect(write.status).toBe('approved');
    expect(write.book_id).toBe('book2');
    expect(write.assignee_role).toBe('writer');

    // create_account は needs_human ＋ assignee=human
    const acct = created.tasks.find((t) => t.kind === 'create_account')!;
    expect(acct.status).toBe('needs_human');
    expect(acct.assignee_role).toBe('human');

    // 存在しない book_id は null に落とす
    const ghost = created.tasks.find((t) => t.title === 'ゴミ')!;
    expect(ghost.book_id).toBeNull();
  });

  it('本部長が失敗しても他本部は継続する', async () => {
    const { prisma, created } = makePrisma();
    const planObjective = vi.fn(async () => ceoOutput);
    const planDivisionTasks = vi.fn(async ({ division }: { division: string }) => {
      if (division === 'production') throw new Error('LLM down');
      return managerFor(division);
    });

    const res = await runOrgPlan(
      {},
      { prisma, logger: silentLogger, planObjective, planDivisionTasks, now: () => new Date('2026-07-09T00:00:00Z') },
    );

    // production は落ちるが promotion の3件は起票される
    expect(res.by_division.production).toBeUndefined();
    expect(res.by_division.promotion).toBe(3);
    expect(created.tasks).toHaveLength(3);
  });
});
