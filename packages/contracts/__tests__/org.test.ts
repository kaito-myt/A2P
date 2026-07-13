import { describe, expect, it } from 'vitest';

import {
  CeoPlanOutputSchema,
  DIVISIONS,
  DIVISION_KINDS,
  DIVISION_MANAGER_ROLE,
  DIVISION_DEFAULT_KIND,
  DISPATCHABLE_KINDS,
  ManagerPlanOutputSchema,
  MetadataDraftOutputSchema,
  SalesAnalysisOutputSchema,
  MarketResearchOutputSchema,
  PromoAnalysisOutputSchema,
  CostReportOutputSchema,
  AccountStrategyOutputSchema,
  buildBudgetLines,
  detectBudgetBreaches,
  evaluateKdpPublishReadiness,
  computeWinningPatterns,
  computeBakeoffRecommendation,
  isOrgBakeoffRole,
  orgBakeoffSampleInput,
  depsSatisfied,
  groupByDivision,
  groupByStatus,
  isDispatchableKind,
  isHumanKind,
  kindLabel,
  needsAttention,
  priorityRank,
} from '../src/org/index.js';

describe('org constants', () => {
  it('全本部にマネージャーロールと kind 定義がある', () => {
    for (const d of DIVISIONS) {
      expect(DIVISION_MANAGER_ROLE[d]).toBeTruthy();
      expect(DIVISION_KINDS[d].length).toBeGreaterThan(0);
    }
  });

  it('人手前提の kind を判定する', () => {
    expect(isHumanKind('create_account')).toBe(true);
    expect(isHumanKind('connect_account')).toBe(true);
    expect(isHumanKind('publish_kdp')).toBe(true);
    // P3: 予算凍結/原因調査は人手判断
    expect(isHumanKind('enforce_limit')).toBe(true);
    expect(isHumanKind('triage_error')).toBe(true);
    expect(isHumanKind('write')).toBe(false);
  });

  it('P3 の販促/運用/経営 kind が dispatch 可能（人手 kind は除く）', () => {
    for (const k of ['create_content', 'publish_post', 'analyze_promo', 'recover_job', 'cost_report', 'budget_review']) {
      expect(isDispatchableKind(k)).toBe(true);
    }
    // P4: アカウント戦略立案は dispatch 可能（作成そのものは create_account=human）
    expect(isDispatchableKind('plan_accounts')).toBe(true);
    expect(isHumanKind('plan_accounts')).toBe(false);
    expect(DIVISION_KINDS.promotion).toContain('plan_accounts');
    // 人手 kind は dispatch しない
    expect(isDispatchableKind('enforce_limit')).toBe(false);
    expect(isDispatchableKind('triage_error')).toBe(false);
    expect(isDispatchableKind('publish_kdp')).toBe(false);
  });

  it('kindLabel は未知の kind をそのまま返す', () => {
    expect(kindLabel('write')).toBe('執筆');
    expect(kindLabel('unknown_kind')).toBe('unknown_kind');
  });

  it('needsAttention は提案/要人手/ブロックで true', () => {
    expect(needsAttention('needs_human')).toBe(true);
    expect(needsAttention('proposed')).toBe(true);
    expect(needsAttention('blocked')).toBe(true);
    expect(needsAttention('approved')).toBe(false);
    expect(needsAttention('done')).toBe(false);
  });
});

describe('CeoPlanOutputSchema', () => {
  it('最小の有効な CEO 出力をパースし既定値を埋める', () => {
    const parsed = CeoPlanOutputSchema.parse({
      title: '7月方針',
      period_label: '2026-07',
      body: { goals: ['在庫を3冊増やす'] },
      division_briefs: { production: '実用書を2冊企画' },
    });
    expect(parsed.body.focus_books).toEqual([]);
    expect(parsed.body.kpi).toEqual([]);
    expect(parsed.division_briefs.production).toContain('企画');
  });

  it('goals が空だと reject', () => {
    const r = CeoPlanOutputSchema.safeParse({
      title: 'x',
      period_label: '2026-07',
      body: { goals: [] },
      division_briefs: {},
    });
    expect(r.success).toBe(false);
  });
});

describe('ManagerPlanOutputSchema', () => {
  it('タスクドラフトの priority を既定 should にする', () => {
    const parsed = ManagerPlanOutputSchema.parse({
      tasks: [{ kind: 'write', title: '第1章執筆', instruction: '…', assignee_role: 'writer' }],
    });
    expect(parsed.tasks[0]!.priority).toBe('should');
  });

  it('tasks 省略で空配列', () => {
    const parsed = ManagerPlanOutputSchema.parse({});
    expect(parsed.tasks).toEqual([]);
  });
});

describe('view helpers', () => {
  const tasks = [
    { status: 'approved', division: 'production' },
    { status: 'needs_human', division: 'promotion' },
    { status: 'done', division: 'production' },
    { status: 'weird', division: 'unknown' },
  ];

  it('groupByStatus は未知 status を proposed に寄せる', () => {
    const g = groupByStatus(tasks);
    expect(g.approved).toHaveLength(1);
    expect(g.needs_human).toHaveLength(1);
    expect(g.done).toHaveLength(1);
    expect(g.proposed).toHaveLength(1); // weird
  });

  it('groupByDivision は既知本部だけ集める', () => {
    const g = groupByDivision(tasks);
    expect(g.production).toHaveLength(2);
    expect(g.promotion).toHaveLength(1);
    expect(g.analytics).toHaveLength(0);
  });

  it('buildBudgetLines は配分と実績から消化率を出す', () => {
    const lines = buildBudgetLines(
      { production: 1000, promotion: 0 },
      { production: 250, promotion: 100 },
    );
    const prod = lines.find((l) => l.division === 'production')!;
    expect(prod.allocated).toBe(1000);
    expect(prod.spent).toBe(250);
    expect(prod.ratio).toBeCloseTo(0.25);
    // 配分 0 は ratio null（ゼロ割回避）
    const promo = lines.find((l) => l.division === 'promotion')!;
    expect(promo.ratio).toBeNull();
    // 未配分本部は allocated null
    const fin = lines.find((l) => l.division === 'finance')!;
    expect(fin.allocated).toBeNull();
    expect(fin.spent).toBe(0);
  });
});

describe('P2 dispatch helpers', () => {
  it('dispatchable kind と人手 kind は排他', () => {
    expect(isDispatchableKind('analyze_sales')).toBe(true);
    expect(isDispatchableKind('plan_book')).toBe(true);
    expect(isDispatchableKind('publish_kdp')).toBe(false);
    expect(isDispatchableKind('create_account')).toBe(false);
    // publish_kdp / create_account / connect_account は dispatch されない
    for (const k of ['publish_kdp', 'create_account', 'connect_account']) {
      expect(DISPATCHABLE_KINDS.has(k)).toBe(false);
    }
  });

  it('本部の既定 kind は各本部の kind 集合に含まれる', () => {
    for (const d of DIVISIONS) {
      expect(DIVISION_KINDS[d]).toContain(DIVISION_DEFAULT_KIND[d]);
    }
  });

  it('priorityRank は must<should<may', () => {
    expect(priorityRank('must')).toBeLessThan(priorityRank('should'));
    expect(priorityRank('should')).toBeLessThan(priorityRank('may'));
    expect(priorityRank('unknown')).toBeGreaterThanOrEqual(priorityRank('may'));
  });

  it('depsSatisfied は全依存が done のときだけ true', () => {
    const done = new Set(['a', 'b']);
    expect(depsSatisfied({ depends_on: [] }, done)).toBe(true);
    expect(depsSatisfied({ depends_on: ['a'] }, done)).toBe(true);
    expect(depsSatisfied({ depends_on: ['a', 'b'] }, done)).toBe(true);
    expect(depsSatisfied({ depends_on: ['a', 'c'] }, done)).toBe(false);
    expect(depsSatisfied({}, done)).toBe(true);
  });
});

describe('P2 worker output schemas', () => {
  it('SalesAnalysisOutputSchema は suggestions を検証する', () => {
    const out = SalesAnalysisOutputSchema.parse({
      summary: '売上は先月比+20%',
      suggestions: [{ division: 'production', action: 'Xジャンルを3冊', rationale: '需要増' }],
    });
    expect(out.suggestions[0]!.division).toBe('production');
    expect(out.trends).toEqual([]); // default
  });

  it('MarketResearchOutputSchema は theme_ideas を許容', () => {
    const out = MarketResearchOutputSchema.parse({
      summary: '自己啓発が伸長',
      theme_ideas: [{ title: '朝活の科学', angle: '習慣化' }],
    });
    expect(out.theme_ideas[0]!.title).toBe('朝活の科学');
  });

  it('MetadataDraftOutputSchema は keywords 7枠まで', () => {
    const out = MetadataDraftOutputSchema.parse({
      title: 'すごい本',
      description: '読者ベネフィット',
      keywords: ['a', 'b', 'c'],
      price_jpy: 500,
    });
    expect(out.keywords).toHaveLength(3);
    expect(out.price_jpy).toBe(500);
  });
});

describe('P3 worker output schemas', () => {
  it('PromoAnalysisOutputSchema は suggestions を検証する', () => {
    const out = PromoAnalysisOutputSchema.parse({
      summary: 'Xが効いている',
      highlights: ['初速◎'],
      suggestions: [{ division: 'promotion', action: '頻度up', rationale: 'CVR高' }],
    });
    expect(out.suggestions[0]!.division).toBe('promotion');
    expect(out.underperformers).toEqual([]);
  });

  it('CostReportOutputSchema は loss_making と suggestions を許容', () => {
    const out = CostReportOutputSchema.parse({
      summary: '制作過多',
      loss_making: ['実用書A'],
      suggestions: [{ division: 'finance', action: '再配分' }],
    });
    expect(out.loss_making).toEqual(['実用書A']);
    expect(out.suggestions[0]!.rationale).toBe(''); // default
  });

  it('AccountStrategyOutputSchema は推奨アカウントを検証する', () => {
    const out = AccountStrategyOutputSchema.parse({
      summary: '朝活ニッチ',
      recommended_accounts: [{ channel: 'x', niche: '朝活', handle_suggestion: 'asakatsu' }],
    });
    expect(out.recommended_accounts[0]!.channel).toBe('x');
    expect(out.recommended_accounts[0]!.bio).toBe(''); // default
    expect(out.routing).toEqual([]);
  });
});

describe('P3 detectBudgetBreaches', () => {
  it('全社/本部の消化超過を検出する', () => {
    const breaches = detectBudgetBreaches(
      1000,
      1200, // 全社超過
      { production: 500, promotion: 100 },
      { production: 600, promotion: 50 }, // production だけ超過
    );
    const scopes = breaches.map((b) => b.scope);
    expect(scopes).toContain('total');
    expect(scopes).toContain('production');
    expect(scopes).not.toContain('promotion');
  });

  it('予算未設定/消化内なら空', () => {
    expect(detectBudgetBreaches(null, 999, null, {})).toEqual([]);
    expect(detectBudgetBreaches(1000, 500, { production: 500 }, { production: 100 })).toEqual([]);
  });

  it('threshold で早期検知できる', () => {
    const breaches = detectBudgetBreaches(1000, 900, null, {}, 0.9);
    expect(breaches.some((b) => b.scope === 'total')).toBe(true);
  });
});

describe('P4 evaluateKdpPublishReadiness', () => {
  const th = { min_quality: 70, min_price_jpy: 250, max_price_jpy: 1250 };
  const ok = {
    book_status: 'done',
    publish_status: 'unlisted',
    has_blocking_comments: false,
    quality_score: 82,
    metadata: { price_jpy: 500, description_len: 120, keywords_count: 7 },
  };

  it('全条件を満たせば eligible', () => {
    const r = evaluateKdpPublishReadiness(ok, th);
    expect(r.eligible).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('品質未達/未採点は不可', () => {
    expect(evaluateKdpPublishReadiness({ ...ok, quality_score: 60 }, th).eligible).toBe(false);
    expect(evaluateKdpPublishReadiness({ ...ok, quality_score: null }, th).eligible).toBe(false);
  });

  it('公開済み/未完了/mustコメントは不可', () => {
    expect(evaluateKdpPublishReadiness({ ...ok, publish_status: 'published' }, th).eligible).toBe(false);
    expect(evaluateKdpPublishReadiness({ ...ok, book_status: 'editing' }, th).eligible).toBe(false);
    expect(evaluateKdpPublishReadiness({ ...ok, has_blocking_comments: true }, th).eligible).toBe(false);
  });

  it('価格帯外/メタ不備は理由付きで不可', () => {
    expect(evaluateKdpPublishReadiness({ ...ok, metadata: { ...ok.metadata, price_jpy: 3000 } }, th).eligible).toBe(false);
    expect(evaluateKdpPublishReadiness({ ...ok, metadata: null }, th).reasons.length).toBeGreaterThan(0);
    const noKw = evaluateKdpPublishReadiness({ ...ok, metadata: { ...ok.metadata, keywords_count: 0 } }, th);
    expect(noKw.eligible).toBe(false);
  });
});

describe('P4 computeWinningPatterns', () => {
  it('稼ぐジャンルを royalty 降順で並べる', () => {
    const wp = computeWinningPatterns([
      { genre: 'self_help', royalty_jpy: 1000, published: true },
      { genre: 'business', royalty_jpy: 300, published: true },
      { genre: 'self_help', royalty_jpy: 500, published: true },
    ]);
    expect(wp.top_genres[0]!.genre).toBe('self_help');
    expect(wp.top_genres[0]!.royalty_jpy).toBe(1500);
    expect(wp.top_genres[0]!.book_count).toBe(2);
    expect(wp.insights.length).toBeGreaterThan(0);
  });

  it('在庫はあるが売上0のジャンルを underexposed に', () => {
    const wp = computeWinningPatterns([
      { genre: 'practical', royalty_jpy: 0, published: false },
      { genre: 'practical', royalty_jpy: 0, published: false },
      { genre: 'business', royalty_jpy: 200, published: true },
    ]);
    expect(wp.underexposed_genres.some((u) => u.genre === 'practical' && u.book_count === 2)).toBe(true);
    expect(wp.insights.some((s) => s.includes('practical'))).toBe(true);
  });

  it('売上が全く無ければ「まず在庫と露出」を示唆', () => {
    const wp = computeWinningPatterns([{ genre: 'business', royalty_jpy: 0, published: false }]);
    expect(wp.top_genres).toEqual([]);
    expect(wp.insights.some((s) => s.includes('在庫'))).toBe(true);
  });

  it('空入力でも落ちない', () => {
    const wp = computeWinningPatterns([]);
    expect(wp.top_genres).toEqual([]);
    expect(wp.underexposed_genres).toEqual([]);
  });
});

describe('P4 computeBakeoffRecommendation', () => {
  it('品質優先で最良を選び、現行と異なれば is_change', () => {
    const rec = computeBakeoffRecommendation(
      [
        { provider: 'anthropic', model: 'opus', quality_score: 80, cost_jpy: 10 },
        { provider: 'anthropic', model: 'sonnet', quality_score: 90, cost_jpy: 3 },
      ],
      { provider: 'anthropic', model: 'opus' },
    )!;
    expect(rec.best.model).toBe('sonnet');
    expect(rec.is_change).toBe(true);
  });

  it('品質同点はコストで tiebreak', () => {
    const rec = computeBakeoffRecommendation([
      { provider: 'a', model: 'x', quality_score: 88, cost_jpy: 9 },
      { provider: 'a', model: 'y', quality_score: 88, cost_jpy: 4 },
    ])!;
    expect(rec.best.model).toBe('y');
  });

  it('現行が最良なら is_change=false', () => {
    const rec = computeBakeoffRecommendation(
      [
        { provider: 'a', model: 'x', quality_score: 95, cost_jpy: 5 },
        { provider: 'a', model: 'y', quality_score: 70, cost_jpy: 2 },
      ],
      { provider: 'a', model: 'x' },
    )!;
    expect(rec.is_change).toBe(false);
  });

  it('エラー候補は除外、全滅なら null', () => {
    expect(computeBakeoffRecommendation([{ provider: 'a', model: 'x', quality_score: null, cost_jpy: null, error: 'boom' }])).toBeNull();
  });

  it('org ロール判定とサンプル入力', () => {
    expect(isOrgBakeoffRole('ceo')).toBe(true);
    expect(isOrgBakeoffRole('writer')).toBe(false);
    expect(orgBakeoffSampleInput('ceo').length).toBeGreaterThan(0);
    expect(orgBakeoffSampleInput('unknown_role').length).toBeGreaterThan(0); // 汎用フォールバック
  });
});
