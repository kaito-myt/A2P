/**
 * plans-core.ts ユニットテスト (T-08-02, F-002).
 *
 * 検証:
 *  1. 正常系: regeneratePlan が PublishingPlan を persist + audit_log を記録
 *  2. months ∉ {3,6,12} で validation error
 *  3. account 未存在で not_found error
 *  4. エージェント失敗で unknown error
 */
import { describe, expect, it, vi } from 'vitest';
import { isFail, isOk } from '@a2p/contracts';

import {
  regeneratePlanCore,
  type PlansDeps,
  type AccountRepo,
  type BookRepo,
  type SalesRecordRepo,
  type PublishingPlanRepo,
  type AuditLogRepo,
  type GeneratePlanFn,
} from '../../lib/plans-core';

const FROZEN_NOW = new Date('2026-06-05T10:00:00.000Z');
const FAKE_PLAN_OUTPUT = {
  months: [
    {
      ym: '2026-06',
      planned_count: 3,
      theme_categories: ['副業', 'AI 活用'],
      series_candidates: ['副業の応用 Vol.2'],
    },
    {
      ym: '2026-07',
      planned_count: 3,
      theme_categories: ['時間術'],
      series_candidates: [],
    },
    {
      ym: '2026-08',
      planned_count: 3,
      theme_categories: ['ビジネス書'],
      series_candidates: [],
    },
  ],
};

function makeDeps(opts: {
  accountExists?: boolean;
  generatePlanImpl?: GeneratePlanFn;
  planCreateImpl?: (args: { data: unknown }) => Promise<{ id: string }>;
} = {}): {
  deps: PlansDeps;
  spies: {
    accountFindUnique: ReturnType<typeof vi.fn>;
    bookFindMany: ReturnType<typeof vi.fn>;
    salesGroupBy: ReturnType<typeof vi.fn>;
    planCreate: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    generatePlan: ReturnType<typeof vi.fn>;
  };
} {
  const accountFindUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    if (opts.accountExists === false) return null;
    return { id: where.id, status: 'active', pen_name: 'テスト太郎' };
  });

  const bookFindMany = vi.fn(async () => [
    {
      title: '副業で月 5 万円',
      theme: { genre: 'practical' },
      salesRecords: [
        { year_month: '2026-05', royalty_jpy: 15000, review_count: 12, avg_stars: 4.2 },
      ],
    },
  ]);

  const salesGroupBy = vi.fn(async () => [
    { year_month: '2026-05', _sum: { royalty_jpy: 15000 } },
    { year_month: '2026-04', _sum: { royalty_jpy: 12000 } },
  ]);

  let planCounter = 0;
  const planCreate = vi.fn(
    opts.planCreateImpl ?? (async () => {
      planCounter += 1;
      return { id: `plan_${planCounter}` };
    }),
  );

  const auditCreate = vi.fn(async () => ({}));

  const generatePlanFn = vi.fn(
    opts.generatePlanImpl ?? (async () => FAKE_PLAN_OUTPUT),
  );

  return {
    deps: {
      accountRepo: {
        findUnique: accountFindUnique,
      } as unknown as AccountRepo,
      bookRepo: {
        findMany: bookFindMany,
      } as unknown as BookRepo,
      salesRecordRepo: {
        groupBy: salesGroupBy,
      } as unknown as SalesRecordRepo,
      publishingPlanRepo: {
        create: planCreate,
      } as unknown as PublishingPlanRepo,
      auditLogRepo: {
        create: auditCreate,
      } as unknown as AuditLogRepo,
      generatePlan: generatePlanFn as GeneratePlanFn,
      session: { user: { id: 'u_1', username: 'operator' } },
      now: () => FROZEN_NOW,
    },
    spies: {
      accountFindUnique,
      bookFindMany,
      salesGroupBy,
      planCreate,
      auditCreate,
      generatePlan: generatePlanFn,
    },
  };
}

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------

describe('regeneratePlanCore — 正常系', () => {
  it('3 ヶ月: PublishingPlan が create され plan_id が返る', async () => {
    const { deps, spies } = makeDeps();
    const result = await regeneratePlanCore(
      { account_id: 'acc_1', months: 3 },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.plan_id).toBe('plan_1');
    }

    // publishingPlanRepo.create が呼ばれていること
    expect(spies.planCreate).toHaveBeenCalledOnce();
    const createArg = spies.planCreate.mock.calls[0]![0]!;
    expect(createArg.data.account_id).toBe('acc_1');
    expect(createArg.data.plan_json).toBeDefined();
  });

  it('audit_log に plan.regenerate が記録される', async () => {
    const { deps, spies } = makeDeps();
    const result = await regeneratePlanCore(
      { account_id: 'acc_1', months: 6 },
      deps,
    );

    expect(isOk(result)).toBe(true);
    expect(spies.auditCreate).toHaveBeenCalledOnce();
    const auditArg = spies.auditCreate.mock.calls[0]![0]!;
    expect(auditArg.data.action).toBe('plan.regenerate');
    expect(auditArg.data.target_kind).toBe('publishing_plan');
  });

  it('target_count を指定した場合はエージェントに渡される', async () => {
    const { deps, spies } = makeDeps();
    await regeneratePlanCore(
      { account_id: 'acc_1', months: 12, target_count: 50 },
      deps,
    );

    expect(spies.generatePlan).toHaveBeenCalledOnce();
    const agentArg = spies.generatePlan.mock.calls[0]![0]!;
    expect(agentArg.target_count).toBe(50);
    expect(agentArg.months).toBe(12);
  });

  it('target_count 省略時はデフォルト (months × 3) が使われる', async () => {
    const { deps, spies } = makeDeps();
    await regeneratePlanCore(
      { account_id: 'acc_1', months: 6 },
      deps,
    );

    const agentArg = spies.generatePlan.mock.calls[0]![0]!;
    expect(agentArg.target_count).toBe(18); // 6 × 3
  });
});

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------

describe('regeneratePlanCore — input validation', () => {
  it.each([
    ['months=1 (不可)', { account_id: 'acc_1', months: 1 }],
    ['months=7 (不可)', { account_id: 'acc_1', months: 7 }],
    ['months=0 (不可)', { account_id: 'acc_1', months: 0 }],
    ['account_id 欠落', { months: 6 }],
    ['months 欠落', { account_id: 'acc_1' }],
  ])('%s で validation error', async (_label, input) => {
    const { deps } = makeDeps();
    const result = await regeneratePlanCore(input, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('months=3 は valid', async () => {
    const { deps } = makeDeps();
    const result = await regeneratePlanCore({ account_id: 'acc_1', months: 3 }, deps);
    expect(isOk(result)).toBe(true);
  });

  it('months=6 は valid', async () => {
    const { deps } = makeDeps();
    const result = await regeneratePlanCore({ account_id: 'acc_1', months: 6 }, deps);
    expect(isOk(result)).toBe(true);
  });

  it('months=12 は valid', async () => {
    const { deps } = makeDeps();
    const result = await regeneratePlanCore({ account_id: 'acc_1', months: 12 }, deps);
    expect(isOk(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// エラーケース
// ---------------------------------------------------------------------------

describe('regeneratePlanCore — エラーケース', () => {
  it('account 未存在で not_found', async () => {
    const { deps } = makeDeps({ accountExists: false });
    const result = await regeneratePlanCore(
      { account_id: 'acc_nonexistent', months: 3 },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('not_found');
  });

  it('generatePlan が例外を投げたとき unknown error を返す', async () => {
    const { deps } = makeDeps({
      generatePlanImpl: async () => { throw new Error('LLM unavailable'); },
    });
    const result = await regeneratePlanCore(
      { account_id: 'acc_1', months: 3 },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('unknown');
  });

  it('publishingPlan.create が失敗したとき unknown error を返す', async () => {
    const { deps } = makeDeps({
      planCreateImpl: async () => { throw new Error('DB error'); },
    });
    const result = await regeneratePlanCore(
      { account_id: 'acc_1', months: 3 },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('unknown');
  });
});
