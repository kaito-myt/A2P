import { describe, expect, it, vi } from 'vitest';

import type {
  MetadataDraftOutput,
  SalesAnalysisOutput,
  MarketResearchOutput,
  PromoAnalysisOutput,
  CostReportOutput,
  AccountStrategyOutput,
} from '@a2p/contracts/org';

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
  /** promotion_accounts 台帳の既存行（plan_accounts の重複判定用）。 */
  ledger?: Array<{ channel: string; niche: string; handle: string | null; status: string }>;
}

function makeHarness(opts: HarnessOpts) {
  const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
  const created: Array<Record<string, unknown>> = [];
  const accountsCreated: Array<Record<string, unknown>> = [];
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
      // finance-lib (cost_report) 用
      findMany: vi.fn(async () => [
        { org_task_id: 'tprod', book_id: 'b1', cost_jpy: 100 },
        { org_task_id: 'tpromo', book_id: 'b1', cost_jpy: 50 },
      ]),
    },
    orgObjective: {
      findFirst: vi.fn(async () => ({ budget_jpy: 1000, budget_allocation_json: { production: 80, promotion: 40 } })),
    },
    appSettings: {
      findUnique: vi.fn(async () => ({ monthly_cost_red_jpy: 50000 })),
    },
    promotionPost: {
      findMany: vi.fn(async () => [
        { book_id: 'b1', channel: 'x', status: 'posted', book: { title: '実用書A', theme: { genre: 'practical' } } },
        { book_id: 'b1', channel: 'x', status: 'failed', book: { title: '実用書A', theme: { genre: 'practical' } } },
        { book_id: 'b1', channel: 'note', status: 'scheduled', book: { title: '実用書A', theme: { genre: 'practical' } } },
      ]),
    },
    promotionChannelSetting: {
      findMany: vi.fn(async () => [
        { channel: 'x', auto_enabled: true, handle: '@main', token_mask: null },
        { channel: 'note', auto_enabled: false, handle: null, token_mask: null },
      ]),
    },
    promotionAccount: {
      findMany: vi.fn(async () => opts.ledger ?? []),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        accountsCreated.push(args.data);
        return { id: `acct-${accountsCreated.length}` };
      }),
    },
    job: {
      create: vi.fn(async () => ({ id: 'job-new' })),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => [
        { id: 'jf1', kind: 'pipeline.book.editor', status: 'failed', retries: 1, payload_json: { book_id: 'b1', job_id: 'old' } },
        { id: 'jf2', kind: 'pipeline.book.marketer', status: 'failed', retries: 0, payload_json: { book_id: 'b1' } },
      ]),
    },
  } as unknown as OrgExecutePrisma;

  return { prisma, updated, created, accountsCreated };
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

const promoOut: PromoAnalysisOutput = {
  summary: 'Xが効いている',
  highlights: ['X投稿→初速'],
  underperformers: ['noteは反応薄'],
  suggestions: [{ division: 'promotion', action: 'X頻度を上げる', rationale: 'CVR高' }],
};

const costOut: CostReportOutput = {
  summary: '制作コスト過多',
  findings: ['制作80%消化'],
  loss_making: ['実用書A'],
  suggestions: [{ division: 'finance', action: '制作を絞る', rationale: '低ROI' }],
};

const accountOut: AccountStrategyOutput = {
  summary: '朝活ニッチに専用アカウントが無い',
  recommended_accounts: [
    {
      channel: 'x',
      niche: '朝活・習慣化',
      target_reader: '20-30代の会社員',
      handle_suggestion: 'asakatsu_lab',
      bio: '朝活と習慣化の実用書を紹介',
      posting_policy: '毎朝6時に1投稿',
      rationale: '在庫に朝活本が複数あるが専用露出が無い',
    },
    {
      channel: 'note',
      niche: '副業・お金',
      target_reader: '副業志望',
      handle_suggestion: 'fukugyo_note',
      bio: '副業ノウハウ',
      posting_policy: '週2記事',
      rationale: '需要増',
    },
  ],
  routing: [{ target: '@main (x)', use_for: '全書籍の告知' }],
  suggestions: [{ division: 'promotion', action: 'X頻度を上げる', rationale: 'CVR高' }],
};

function baseDeps(over: Partial<OrgExecuteDeps> = {}): OrgExecuteDeps {
  return {
    logger: silentLogger,
    now: () => new Date('2026-07-10T00:00:00Z'),
    genId: () => 'gen-id',
    analyzeSales: vi.fn(async () => salesOut),
    researchMarket: vi.fn(async () => marketOut),
    draftMetadata: vi.fn(async () => metaOut),
    analyzePromotion: vi.fn(async () => promoOut),
    reviewCosts: vi.fn(async () => costOut),
    planAccountStrategy: vi.fn(async () => accountOut),
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

describe('runOrgExecute — P3 promotion', () => {
  it('create_content は販促プラン生成ジョブを enqueue する', async () => {
    const { prisma, updated } = makeHarness({
      candidates: [task({ id: 'p1', division: 'promotion', kind: 'create_content', book_id: 'b1' })],
    });
    const enqueueJob = vi.fn(async () => 'gj');
    const res = await runOrgExecute({}, { ...baseDeps({ enqueueJob }), prisma });
    expect(res.done).toBe(1);
    expect(enqueueJob).toHaveBeenCalledWith(
      'pipeline.book.promotion.generate',
      expect.objectContaining({ book_id: 'b1', job_id: 'job-new' }),
    );
    const done = updated.find((u) => u.id === 'p1')!;
    expect((done.data.result_json as { action: string }).action).toBe('promotion_generate_enqueued');
  });

  it('publish_post は promotion.dispatch を enqueue する', async () => {
    const { prisma } = makeHarness({
      candidates: [task({ id: 'p2', division: 'promotion', kind: 'publish_post' })],
    });
    const enqueueJob = vi.fn(async () => 'gj');
    const res = await runOrgExecute({}, { ...baseDeps({ enqueueJob }), prisma });
    expect(res.done).toBe(1);
    expect(enqueueJob).toHaveBeenCalledWith('promotion.dispatch', {});
  });

  it('analyze_promo は効果検証し改善ToDoを連鎖起票する', async () => {
    const { prisma, updated, created } = makeHarness({
      candidates: [task({ id: 'p3', division: 'promotion', kind: 'analyze_promo' })],
    });
    const res = await runOrgExecute({}, { ...baseDeps(), prisma });
    expect(res.done).toBe(1);
    const done = updated.find((u) => u.id === 'p3')!;
    expect((done.data.result_json as PromoAnalysisOutput).summary).toBe('Xが効いている');
    expect(created.filter((c) => c.status === 'proposed')).toHaveLength(1);
  });
});

describe('runOrgExecute — P4 promotion plan_accounts', () => {
  it('推奨アカウントを台帳(pending)登録＋作成仕様付き create_account(needs_human) を起票', async () => {
    const { prisma, created, accountsCreated } = makeHarness({
      candidates: [task({ id: 'a1', division: 'promotion', kind: 'plan_accounts' })],
    });
    const res = await runOrgExecute({}, { ...baseDeps(), prisma });
    expect(res.done).toBe(1);
    // 2件の推奨 → 台帳2件 + create_account 2件
    expect(accountsCreated).toHaveLength(2);
    expect(accountsCreated[0]!.status).toBe('pending');
    const createAccts = created.filter((c) => c.kind === 'create_account');
    expect(createAccts).toHaveLength(2);
    expect(createAccts[0]!.status).toBe('needs_human');
    expect(createAccts[0]!.assignee_role).toBe('human');
    // 作成仕様(handle案/bio)が instruction に埋まっている
    expect(String(createAccts[0]!.instruction)).toContain('asakatsu_lab');
  });

  it('既に台帳にあるニッチは重複起票しない', async () => {
    const { prisma, created, accountsCreated } = makeHarness({
      candidates: [task({ id: 'a2', division: 'promotion', kind: 'plan_accounts' })],
      ledger: [{ channel: 'x', niche: '朝活・習慣化', handle: null, status: 'pending' }],
    });
    await runOrgExecute({}, { ...baseDeps(), prisma });
    // 朝活はスキップ → note の1件のみ
    expect(accountsCreated).toHaveLength(1);
    expect(created.filter((c) => c.kind === 'create_account')).toHaveLength(1);
  });
});

describe('runOrgExecute — P3 sysops recover_job', () => {
  it('最進捗の失敗パイプラインステップを再投入する', async () => {
    const { prisma, updated } = makeHarness({
      candidates: [task({ id: 'r1', division: 'sysops', kind: 'recover_job', book_id: 'b1' })],
    });
    const enqueueJob = vi.fn(async () => 'gj');
    const res = await runOrgExecute({}, { ...baseDeps({ enqueueJob }), prisma });
    expect(res.done).toBe(1);
    // editor (index 5) が marketer (index 1) より進んでいる → editor を再投入
    expect(enqueueJob).toHaveBeenCalledWith(
      'pipeline.book.editor',
      expect.objectContaining({ book_id: 'b1', job_id: 'job-new' }),
    );
    const done = updated.find((u) => u.id === 'r1')!;
    expect((done.data.result_json as { recovered_step: string }).recovered_step).toBe('pipeline.book.editor');
  });

  it('book_id が無いと blocked', async () => {
    const { prisma, updated } = makeHarness({
      candidates: [task({ id: 'r2', division: 'sysops', kind: 'recover_job', book_id: null })],
    });
    const res = await runOrgExecute({}, { ...baseDeps(), prisma });
    expect(res.blocked).toBe(1);
    expect(String(updated.find((u) => u.id === 'r2')!.data.error)).toContain('book_id');
  });
});

describe('runOrgExecute — P3 finance cost_report', () => {
  it('本部別/書籍別コストを集計し講評＋改善ToDoを起票する', async () => {
    const { prisma, updated, created } = makeHarness({
      candidates: [task({ id: 'f1', division: 'finance', kind: 'cost_report' })],
    });
    const reviewCosts = vi.fn(async () => costOut);
    const res = await runOrgExecute({}, { ...baseDeps({ reviewCosts }), prisma });
    expect(res.done).toBe(1);
    // snapshot に本部別/書籍別が入っている
    const calls = (reviewCosts as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const arg = calls[0]![0] as { snapshot: { by_division: unknown[]; per_book: unknown[] } };
    expect(arg.snapshot.by_division.length).toBeGreaterThan(0);
    expect(arg.snapshot.per_book.length).toBeGreaterThan(0);
    const done = updated.find((u) => u.id === 'f1')!;
    expect((done.data.result_json as { report: CostReportOutput }).report.summary).toBe('制作コスト過多');
    expect(created.filter((c) => c.status === 'proposed')).toHaveLength(1);
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
