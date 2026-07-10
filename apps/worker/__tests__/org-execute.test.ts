import { describe, expect, it, vi } from 'vitest';

import type { MetadataDraftOutput, SalesAnalysisOutput, MarketResearchOutput } from '@a2p/contracts/org';

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
    division: 'analytics',
    kind: 'analyze_sales',
    book_id: null,
    instruction: '売上を分析',
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

interface HarnessOpts {
  candidates: DispatchTaskRow[];
  doneIds?: string[];
}

function makeHarness(opts: HarnessOpts) {
  const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
  const created: Array<Record<string, unknown>> = [];
  const claims = new Set<string>(); // id が既に in_progress になったか

  const prisma = {
    orgTask: {
      findMany: vi.fn(async (args: { where: { status?: string; id?: { in: string[] } } }) => {
        if (args.where?.status === 'approved') return opts.candidates;
        if (args.where?.status === 'done' && args.where.id?.in) {
          return (opts.doneIds ?? []).filter((d) => args.where.id!.in.includes(d)).map((id) => ({ id }));
        }
        return [];
      }),
      updateMany: vi.fn(async (args: { where: { id: string; status: string }; data: unknown }) => {
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
    book: {
      findMany: vi.fn(async () => [
        { id: 'b1', title: '実用書A', status: 'done', publish_status: 'published', theme: { genre: 'practical' } },
      ]),
      findUnique: vi.fn(async () => ({
        id: 'b1',
        title: '実用書A',
        subtitle: null,
        theme: { genre: 'practical' },
        kdpMetadata: { description: '既存', keywords: ['k1'], price_jpy: 500 },
        outline: { chapters_json: [{ title: '第1章' }, { title: '第2章' }] },
      })),
    },
    salesRecord: {
      findMany: vi.fn(async () => [
        { book_id: 'b1', year_month: '2026-06', royalty_jpy: 300, book: { title: '実用書A', theme: { genre: 'practical' } } },
        { book_id: 'b1', year_month: '2026-07', royalty_jpy: 500, book: { title: '実用書A', theme: { genre: 'practical' } } },
      ]),
    },
    themeCandidate: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'theme-ok' ? { id: 'theme-ok', account_id: 'acc1', status: 'accepted' } : null,
      ),
    },
    account: {
      findFirst: vi.fn(async () => ({ id: 'acc1' })),
    },
    tokenUsage: {
      aggregate: vi.fn(async () => ({ _sum: { cost_jpy: 12.34 } })),
    },
    job: {
      create: vi.fn(async () => ({ id: 'job-new' })),
      update: vi.fn(async () => ({})),
    },
  } as unknown as OrgExecutePrisma;

  return { prisma, updated, created };
}

const salesOut: SalesAnalysisOutput = {
  summary: '先月比+66%',
  trends: ['増加'],
  top_books: ['実用書A'],
  underperformers: [],
  suggestions: [
    { division: 'production', action: '実用書を増やす', rationale: '需要増' },
    { division: 'promotion', action: 'Xで告知', rationale: '露出' },
  ],
};

const marketOut: MarketResearchOutput = {
  summary: '自己啓発が伸長',
  genre_opportunities: [{ genre: 'self_help', why: '需要増' }],
  theme_ideas: [{ title: '朝活の科学', angle: '習慣化' }],
  suggestions: [],
};

const metaOut: MetadataDraftOutput = {
  title: '実用書A',
  description: '紹介文',
  keywords: ['k1', 'k2'],
  categories: ['実用'],
  price_jpy: 600,
  rationale: '根拠',
};

function baseDeps(over: Partial<OrgExecuteDeps> = {}): OrgExecuteDeps {
  return {
    logger: silentLogger,
    now: () => new Date('2026-07-10T00:00:00Z'),
    genId: () => 'gen-id',
    analyzeSales: vi.fn(async () => salesOut),
    researchMarket: vi.fn(async () => marketOut),
    draftMetadata: vi.fn(async () => metaOut),
    enqueueJob: vi.fn(async () => 'gj-1'),
    ...over,
  };
}

describe('runOrgExecute — analyze_sales', () => {
  it('分析を実行し done ＋コスト確定＋改善ToDoを連鎖起票する', async () => {
    const { prisma, updated, created } = makeHarness({ candidates: [task({ id: 't1', kind: 'analyze_sales' })] });
    const res = await runOrgExecute({ trigger: 'manual' }, { ...baseDeps(), prisma });

    expect(res.dispatched).toBe(1);
    expect(res.done).toBe(1);
    expect(res.blocked).toBe(0);

    const doneUpdate = updated.find((u) => u.id === 't1' && u.data.status === 'done')!;
    expect(doneUpdate).toBeTruthy();
    expect(doneUpdate.data.cost_jpy).toBeCloseTo(12.34);
    expect((doneUpdate.data.result_json as SalesAnalysisOutput).summary).toBe('先月比+66%');

    // suggestions 2件 → proposed 改善ToDo 2件
    const followUps = created.filter((c) => c.status === 'proposed');
    expect(followUps).toHaveLength(2);
    expect(res.follow_ups_created).toBe(2);
    expect(followUps[0]!.kind).toBe('plan_book'); // production 既定
  });
});

describe('runOrgExecute — production/publishing', () => {
  it('plan_book はテーマ生成ジョブを enqueue する', async () => {
    const { prisma, updated } = makeHarness({
      candidates: [task({ id: 't2', division: 'production', kind: 'plan_book', instruction: '実用書を企画' })],
    });
    const enqueueJob = vi.fn(async () => 'gj');
    const res = await runOrgExecute({}, { ...baseDeps({ enqueueJob }), prisma });

    expect(res.done).toBe(1);
    expect(enqueueJob).toHaveBeenCalledWith('pipeline.theme.generate', expect.objectContaining({ job_id: 'job-new' }));
    const done = updated.find((u) => u.id === 't2' && u.data.status === 'done')!;
    expect((done.data.result_json as { action: string }).action).toBe('theme_generate_enqueued');
  });

  it('write は theme_id が無いと blocked になる', async () => {
    const { prisma, updated } = makeHarness({
      candidates: [task({ id: 't3', division: 'production', kind: 'write', theme_id: null })],
    });
    const res = await runOrgExecute({}, { ...baseDeps(), prisma });

    expect(res.done).toBe(0);
    expect(res.blocked).toBe(1);
    const blocked = updated.find((u) => u.id === 't3')!;
    expect(blocked.data.status).toBe('blocked');
    expect(String(blocked.data.error)).toContain('theme_id');
  });

  it('write は theme_id があれば kickoff を enqueue する', async () => {
    const { prisma } = makeHarness({
      candidates: [task({ id: 't4', division: 'production', kind: 'write', theme_id: 'theme-ok' })],
    });
    const enqueueJob = vi.fn(async () => 'gj');
    const res = await runOrgExecute({}, { ...baseDeps({ enqueueJob }), prisma });

    expect(res.done).toBe(1);
    expect(enqueueJob).toHaveBeenCalledWith('pipeline.book.kickoff', expect.objectContaining({ theme_id: 'theme-ok' }));
  });

  it('prepare_metadata は book_id 必須で草案を result に格納', async () => {
    const { prisma, updated } = makeHarness({
      candidates: [task({ id: 't5', division: 'publishing', kind: 'prepare_metadata', book_id: 'b1' })],
    });
    const res = await runOrgExecute({}, { ...baseDeps(), prisma });
    expect(res.done).toBe(1);
    const done = updated.find((u) => u.id === 't5')!;
    expect((done.data.result_json as { draft: MetadataDraftOutput }).draft.title).toBe('実用書A');
  });
});

describe('runOrgExecute — 依存/上限', () => {
  it('依存未達のタスクは着手しない', async () => {
    const { prisma } = makeHarness({
      candidates: [task({ id: 't6', kind: 'report', depends_on: ['dep-not-done'] })],
      doneIds: [],
    });
    const res = await runOrgExecute({}, { ...baseDeps(), prisma });
    expect(res.dispatched).toBe(0);
  });

  it('依存が done なら着手する', async () => {
    const { prisma } = makeHarness({
      candidates: [task({ id: 't7', kind: 'report', depends_on: ['dep1'] })],
      doneIds: ['dep1'],
    });
    const res = await runOrgExecute({}, { ...baseDeps(), prisma });
    expect(res.dispatched).toBe(1);
    expect(res.done).toBe(1);
  });

  it('limit で1回の着手数を絞る', async () => {
    const { prisma } = makeHarness({
      candidates: [
        task({ id: 'a', kind: 'analyze_sales', priority: 'must' }),
        task({ id: 'b', kind: 'analyze_sales', priority: 'should' }),
      ],
    });
    const res = await runOrgExecute({ limit: 1 }, { ...baseDeps(), prisma });
    expect(res.dispatched).toBe(1);
  });
});
