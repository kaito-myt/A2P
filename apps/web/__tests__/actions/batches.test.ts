/**
 * batches-core.ts のユニットテスト (T-03-09, F-010 / F-021).
 *
 * 検証:
 *  - forecastBookCostJpy: 役割欠落の missingRoles / 通常計算 / 画像コスト
 *  - createBatchPlanCore: zod / theme 不在 / accepted 以外 / BatchPlan INSERT /
 *    item INSERT / audit_log / 戻り値 (predicted_cost / item_count)
 *  - kickBatchNowCore: zod / BatchPlan 不在 / status 不一致 / 各 Job INSERT +
 *    enqueueJob + BatchPlanItem.kicked + BatchPlan.running + audit_log
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  BatchPlan,
  BatchPlanItem,
  ModelAssignment,
  ModelCatalog,
  ThemeCandidate,
} from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  createBatchPlanCore,
  forecastBookCostJpy,
  kickBatchNowCore,
  projectExceedsRedThreshold,
  PER_BOOK_TOKEN_ESTIMATE,
  PIPELINE_BOOK_KICKOFF_TASK_NAME,
  SNAPSHOT_ROLES,
  type AppSettingsMonthlyRepo,
  type BatchesDeps,
  type BatchPlanItemRepo,
  type BatchPlanRepo,
  type CreateBatchPlanTxFn,
  type ForecastCatalogRow,
  type GetMonthlyTotalCostFn,
  type JobRepo,
  type KickBatchNowTxFn,
  type ModelAssignmentReadRepo,
  type ModelCatalogReadRepo,
  type ThemeCandidateRepo,
} from '../../lib/batches-core';

/** ModelCatalog Prisma 行を ForecastCatalogRow に正規化するテストヘルパ。 */
function toForecastRows(rows: ModelCatalog[]): ForecastCatalogRow[] {
  return rows.map((c) => ({
    provider: c.provider,
    model: c.model,
    inputPricePerMtokUsd: Number(c.input_price_per_mtok_usd),
    outputPricePerMtokUsd: Number(c.output_price_per_mtok_usd),
    imagePricePerImageUsd:
      c.image_price_per_image_usd === null
        ? null
        : Number(c.image_price_per_image_usd),
    fxRateUsdJpy: Number(c.fx_rate_usd_jpy),
  }));
}

const FROZEN_NOW = new Date('2026-05-24T12:00:00.000Z');

// ---------------------------------------------------------------------------
// stub builders
// ---------------------------------------------------------------------------

type ThemeRow = Pick<
  ThemeCandidate,
  'id' | 'account_id' | 'status' | 'title' | 'genre'
>;

function themeStub(
  id: string,
  status: 'pending' | 'accepted' | 'rejected' = 'accepted',
  overrides: Partial<ThemeRow> = {},
): ThemeRow {
  return {
    id,
    account_id: 'acc_1',
    status,
    title: `Title ${id}`,
    genre: 'business',
    ...overrides,
  };
}

function assignmentStub(
  role: string,
  provider = 'anthropic',
  model = 'claude-opus-4-7',
): Pick<ModelAssignment, 'role' | 'genre' | 'provider' | 'model'> {
  return { role, genre: null, provider, model };
}

function catalogStub(
  provider: string,
  model: string,
  overrides: Partial<ModelCatalog> = {},
): ModelCatalog {
  return {
    id: `mc_${provider}_${model}`,
    provider,
    model,
    input_price_per_mtok_usd:
      '3.000000' as unknown as ModelCatalog['input_price_per_mtok_usd'],
    output_price_per_mtok_usd:
      '15.000000' as unknown as ModelCatalog['output_price_per_mtok_usd'],
    image_price_per_image_usd: null,
    fx_rate_usd_jpy: '150.0000' as unknown as ModelCatalog['fx_rate_usd_jpy'],
    fetched_at: new Date('2026-05-20T00:00:00.000Z'),
    source: 'anthropic_pricing_page_v1',
    raw_json: {} as unknown as ModelCatalog['raw_json'],
    is_current: true,
    ...overrides,
  } as ModelCatalog;
}

// ---------------------------------------------------------------------------
// forecastBookCostJpy
// ---------------------------------------------------------------------------

describe('forecastBookCostJpy', () => {
  it('全 7 役の assignment + catalog が揃えば missingRoles 空 + コスト>0', () => {
    const assignments = SNAPSHOT_ROLES.map((r) => assignmentStub(r));
    const catalog = toForecastRows([catalogStub('anthropic', 'claude-opus-4-7')]);
    const result = forecastBookCostJpy({
      themeCount: 3,
      assignments,
      catalog,
    });
    expect(result.missingRoles).toEqual([]);
    expect(result.themeCount).toBe(3);
    expect(result.perBookJpy).toBeGreaterThan(0);
    expect(result.totalJpy).toBe(result.perBookJpy * 3);
  });

  it('catalog 行が無ければ全 role が missingRoles + perBook=0', () => {
    const assignments = SNAPSHOT_ROLES.map((r) => assignmentStub(r));
    const result = forecastBookCostJpy({
      themeCount: 5,
      assignments,
      catalog: [],
    });
    expect(result.missingRoles.length).toBe(SNAPSHOT_ROLES.length);
    expect(result.perBookJpy).toBe(0);
    expect(result.totalJpy).toBe(0);
  });

  it('一部 role の assignment 欠落で missingRoles に含まれる / 他 role は加算', () => {
    // writer のみ欠落
    const assignments = SNAPSHOT_ROLES.filter((r) => r !== 'writer').map((r) =>
      assignmentStub(r),
    );
    const catalog = toForecastRows([catalogStub('anthropic', 'claude-opus-4-7')]);
    const result = forecastBookCostJpy({
      themeCount: 1,
      assignments,
      catalog,
    });
    expect(result.missingRoles).toContain('writer');
    expect(result.missingRoles).not.toContain('marketer');
    expect(result.perBookJpy).toBeGreaterThan(0);
  });

  it('画像 model に image_price があれば画像コストが加算される', () => {
    const assignments = SNAPSHOT_ROLES.map((r) =>
      r === 'thumbnail_image'
        ? assignmentStub(r, 'openai', 'gpt-image-1')
        : assignmentStub(r),
    );
    const catalog = toForecastRows([
      catalogStub('anthropic', 'claude-opus-4-7'),
      catalogStub('openai', 'gpt-image-1', {
        image_price_per_image_usd:
          '0.040000' as unknown as ModelCatalog['image_price_per_image_usd'],
      }),
    ]);
    const result = forecastBookCostJpy({
      themeCount: 1,
      assignments,
      catalog,
    });
    expect(result.missingRoles).toEqual([]);
    // PER_BOOK_TOKEN_ESTIMATE.thumbnail_image.imageCount = 3
    // 画像コスト = 3 * 0.04 USD * 150 = 18 JPY 以上が加算される
    expect(result.perBookJpy).toBeGreaterThan(18);
    expect(PER_BOOK_TOKEN_ESTIMATE.thumbnail_image.imageCount).toBe(3);
  });

  it('overrides で thumbnail_image を openai/gpt-image-1 にしても catalog があれば反映される', () => {
    const assignments = SNAPSHOT_ROLES.filter((r) => r !== 'thumbnail_image').map(
      (r) => assignmentStub(r),
    );
    const catalog = toForecastRows([
      catalogStub('anthropic', 'claude-opus-4-7'),
      catalogStub('openai', 'gpt-image-1', {
        image_price_per_image_usd:
          '0.040000' as unknown as ModelCatalog['image_price_per_image_usd'],
      }),
    ]);
    const result = forecastBookCostJpy({
      themeCount: 1,
      assignments,
      catalog,
      overrides: {
        thumbnail_image: { provider: 'openai', model: 'gpt-image-1' },
      },
    });
    expect(result.missingRoles).not.toContain('thumbnail_image');
  });
});

// ---------------------------------------------------------------------------
// createBatchPlanCore — deps factory
// ---------------------------------------------------------------------------

interface CreateDepsBag {
  deps: BatchesDeps;
  spies: {
    themeFindMany: ReturnType<typeof vi.fn>;
    assignmentFindMany: ReturnType<typeof vi.fn>;
    catalogFindMany: ReturnType<typeof vi.fn>;
    batchPlanCreate: ReturnType<typeof vi.fn>;
    batchPlanItemCreate: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };
  store: {
    plans: BatchPlan[];
    items: BatchPlanItem[];
  };
}

function makeCreateDeps(opts: {
  themes: ThemeRow[];
  assignments?: Array<Pick<ModelAssignment, 'role' | 'genre' | 'provider' | 'model'>>;
  catalog?: ModelCatalog[];
} = { themes: [] }): CreateDepsBag {
  const plans: BatchPlan[] = [];
  const items: BatchPlanItem[] = [];
  let planCounter = 0;
  let itemCounter = 0;

  const themeFindMany = vi.fn(
    async (args: { where: { id: { in: string[] } } }) => {
      const ids = new Set(args.where.id.in);
      return opts.themes.filter((t) => ids.has(t.id)).map((t) => ({ ...t }));
    },
  );

  const assignmentFindMany = vi.fn(
    async (_args: { where: { status: string } }) => {
      return (opts.assignments ?? []).map((a) => ({ ...a }));
    },
  );

  const catalogFindMany = vi.fn(
    async (_args: { where: { is_current: boolean } }) => {
      return (opts.catalog ?? []).map((c) => ({ ...c }));
    },
  );

  const batchPlanRepo: BatchPlanRepo = {
    create: vi.fn(async ({ data }) => {
      planCounter += 1;
      const plan: BatchPlan = {
        id: `bp_${planCounter}`,
        planned_at: data.planned_at as Date,
        concurrency: (data.concurrency as number) ?? 5,
        deadline: (data.deadline as Date | null) ?? null,
        predicted_cost_jpy: (data.predicted_cost_jpy as number) ?? 0,
        status: (data.status as string) ?? 'scheduled',
        kicked_at: null,
        created_at: FROZEN_NOW,
      } as BatchPlan;
      plans.push(plan);
      return { id: plan.id, planned_at: plan.planned_at };
    }),
    findUnique: vi.fn(async () => null),
    update: vi.fn(async () => ({})),
  };

  const batchPlanItemRepo: BatchPlanItemRepo = {
    create: vi.fn(async ({ data }) => {
      itemCounter += 1;
      const item: BatchPlanItem = {
        id: `bpi_${itemCounter}`,
        batch_id: data.batch_id as string,
        theme_id: (data.theme_id as string | null) ?? null,
        book_id: null,
        override_model_assignments_json: (data.override_model_assignments_json as
          | object
          | null) ?? null,
        status: (data.status as string) ?? 'pending',
      } as BatchPlanItem;
      items.push(item);
      return { id: item.id, theme_id: item.theme_id };
    }),
    update: vi.fn(async () => ({})),
  };

  const auditCreate = vi.fn(async () => ({}));
  const enqueue = vi.fn(async () => 'graphile_job_42');

  const runCreateTransaction: CreateBatchPlanTxFn = async (fn) =>
    fn({
      batchPlanRepo,
      batchPlanItemRepo,
      auditLogRepo: { create: auditCreate },
    });

  const runKickTransaction: KickBatchNowTxFn = async (fn) =>
    fn({
      batchPlanRepo,
      batchPlanItemRepo,
      jobRepo: { create: vi.fn() } as unknown as JobRepo,
      auditLogRepo: { create: auditCreate },
    });

  const deps: BatchesDeps = {
    themeCandidateRepo: { findMany: themeFindMany } as unknown as ThemeCandidateRepo,
    batchPlanRepo,
    batchPlanItemRepo,
    jobRepo: { create: vi.fn() } as unknown as JobRepo,
    modelAssignmentRepo: {
      findMany: assignmentFindMany,
    } as unknown as ModelAssignmentReadRepo,
    modelCatalogRepo: {
      findMany: catalogFindMany,
    } as unknown as ModelCatalogReadRepo,
    auditLogRepo: { create: auditCreate },
    session: { user: { id: 'u_1', username: 'operator' } },
    runCreateTransaction,
    runKickTransaction,
    enqueueJob: enqueue,
    now: () => FROZEN_NOW,
  };

  return {
    deps,
    spies: {
      themeFindMany,
      assignmentFindMany,
      catalogFindMany,
      batchPlanCreate: batchPlanRepo.create as ReturnType<typeof vi.fn>,
      batchPlanItemCreate: batchPlanItemRepo.create as ReturnType<typeof vi.fn>,
      auditCreate,
      enqueue,
    },
    store: { plans, items },
  };
}

// ---------------------------------------------------------------------------
// createBatchPlanCore — input validation
// ---------------------------------------------------------------------------

describe('createBatchPlanCore — input validation', () => {
  it('themeIds 空配列で validation', async () => {
    const { deps } = makeCreateDeps({ themes: [] });
    const r = await createBatchPlanCore({ themeIds: [] }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('themeIds 101 件で validation', async () => {
    const { deps } = makeCreateDeps({ themes: [] });
    const ids = Array.from({ length: 101 }, (_, i) => `t_${i}`);
    const r = await createBatchPlanCore({ themeIds: ids }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('concurrency 0 で validation', async () => {
    const { deps } = makeCreateDeps({ themes: [] });
    const r = await createBatchPlanCore(
      { themeIds: ['t_1'], concurrency: 0 },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('plannedAt が ISO datetime でなければ validation', async () => {
    const { deps } = makeCreateDeps({ themes: [] });
    const r = await createBatchPlanCore(
      { themeIds: ['t_1'], plannedAt: '2026/05/25' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// createBatchPlanCore — theme status guards
// ---------------------------------------------------------------------------

describe('createBatchPlanCore — theme guards', () => {
  it('theme が 1 件でも DB に存在しなければ not_found / DB INSERT は走らない', async () => {
    const { deps, spies } = makeCreateDeps({
      themes: [themeStub('t_1', 'accepted')],
    });
    const r = await createBatchPlanCore(
      { themeIds: ['t_1', 't_missing'] },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
    expect(spies.batchPlanCreate).not.toHaveBeenCalled();
    expect(spies.batchPlanItemCreate).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('accepted 以外 (pending/rejected) が混在で validation', async () => {
    const { deps, spies } = makeCreateDeps({
      themes: [themeStub('t_1', 'accepted'), themeStub('t_2', 'pending')],
    });
    const r = await createBatchPlanCore(
      { themeIds: ['t_1', 't_2'] },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.batchPlanCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createBatchPlanCore — happy path
// ---------------------------------------------------------------------------

describe('createBatchPlanCore — happy path', () => {
  it('3 件 accepted → BatchPlan + 3 BatchPlanItem + audit_log 1 件', async () => {
    const themes = [
      themeStub('t_1', 'accepted'),
      themeStub('t_2', 'accepted'),
      themeStub('t_3', 'accepted'),
    ];
    const assignments = SNAPSHOT_ROLES.map((r) => assignmentStub(r));
    const catalog = [catalogStub('anthropic', 'claude-opus-4-7')];
    const { deps, spies, store } = makeCreateDeps({ themes, assignments, catalog });

    const r = await createBatchPlanCore(
      {
        themeIds: ['t_1', 't_2', 't_3'],
        plannedAt: '2026-05-25T14:00:00.000Z',
        concurrency: 4,
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.item_count).toBe(3);
      expect(r.data.predicted_cost_jpy).toBeGreaterThan(0);
      expect(r.data.would_exceed_monthly).toBe(false);
      expect(r.data.scheduled_at).toBe('2026-05-25T14:00:00.000Z');
      expect(r.data.batch_id).toMatch(/^bp_/);
    }

    expect(spies.batchPlanCreate).toHaveBeenCalledTimes(1);
    const planArg = spies.batchPlanCreate.mock.calls[0]?.[0];
    expect(planArg.data.status).toBe('scheduled');
    expect(planArg.data.concurrency).toBe(4);
    expect(planArg.data.predicted_cost_jpy).toBeGreaterThan(0);
    expect(planArg.data.planned_at).toEqual(new Date('2026-05-25T14:00:00.000Z'));

    expect(spies.batchPlanItemCreate).toHaveBeenCalledTimes(3);
    for (const call of spies.batchPlanItemCreate.mock.calls) {
      expect(call[0].data.batch_id).toBe(store.plans[0]!.id);
      expect(call[0].data.status).toBe('pending');
    }

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    expect(auditArg.data.action).toBe('batch_plan.create');
    expect(auditArg.data.target_kind).toBe('batch_plan');
    expect(auditArg.data.actor_id).toBe('u_1');
    const after = auditArg.data.after_json as Record<string, unknown>;
    expect(after.batch_id).toMatch(/^bp_/);
    expect(after.theme_ids).toEqual(['t_1', 't_2', 't_3']);
  });

  it('plannedAt 省略時は今日 (FROZEN_NOW=2026-05-24 12:00 UTC) の 14:00 UTC が既定 (23:00 JST)', async () => {
    const themes = [themeStub('t_1', 'accepted')];
    const assignments = SNAPSHOT_ROLES.map((r) => assignmentStub(r));
    const catalog = [catalogStub('anthropic', 'claude-opus-4-7')];
    const { deps, spies } = makeCreateDeps({ themes, assignments, catalog });

    const r = await createBatchPlanCore({ themeIds: ['t_1'] }, deps);
    expect(isOk(r)).toBe(true);
    const planArg = spies.batchPlanCreate.mock.calls[0]?.[0];
    const plannedAt = planArg.data.planned_at as Date;
    // FROZEN_NOW=12:00 UTC < 14:00 UTC → 当日 14:00 UTC
    expect(plannedAt.toISOString()).toBe('2026-05-24T14:00:00.000Z');
  });

  it('predicted_cost_jpy は forecastBookCostJpy × themeCount に一致する', async () => {
    const themes = [themeStub('t_1', 'accepted'), themeStub('t_2', 'accepted')];
    const assignments = SNAPSHOT_ROLES.map((r) => assignmentStub(r));
    const catalog = [catalogStub('anthropic', 'claude-opus-4-7')];
    const { deps } = makeCreateDeps({ themes, assignments, catalog });

    const expected = forecastBookCostJpy({
      themeCount: 2,
      assignments,
      catalog: toForecastRows(catalog),
    });

    const r = await createBatchPlanCore(
      { themeIds: ['t_1', 't_2'], plannedAt: '2026-05-25T14:00:00.000Z' },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.predicted_cost_jpy).toBe(expected.totalJpy);
  });

  it('overrideModelAssignments を渡すと BatchPlanItem.override_model_assignments_json に乗る', async () => {
    const themes = [themeStub('t_1', 'accepted')];
    const assignments = SNAPSHOT_ROLES.map((r) => assignmentStub(r));
    const catalog = [catalogStub('anthropic', 'claude-opus-4-7')];
    const { deps, spies } = makeCreateDeps({ themes, assignments, catalog });

    const r = await createBatchPlanCore(
      {
        themeIds: ['t_1'],
        plannedAt: '2026-05-25T14:00:00.000Z',
        overrideModelAssignments: {
          marketer: { provider: 'openai', model: 'gpt-5' },
        },
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    const itemArg = spies.batchPlanItemCreate.mock.calls[0]?.[0];
    expect(itemArg.data.override_model_assignments_json).toEqual({
      marketer: { provider: 'openai', model: 'gpt-5' },
    });
  });
});

// ---------------------------------------------------------------------------
// kickBatchNowCore — deps factory
// ---------------------------------------------------------------------------

interface KickDepsBag {
  deps: BatchesDeps;
  spies: {
    jobCreate: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
    batchPlanUpdate: ReturnType<typeof vi.fn>;
    batchPlanItemUpdate: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
  };
  store: {
    items: BatchPlanItem[];
  };
}

function makeKickDeps(opts: {
  plan?: BatchPlan | null;
  items?: BatchPlanItem[];
  themes?: ThemeRow[];
  enqueueThrows?: Error;
}): KickDepsBag {
  const plan: BatchPlan | null = opts.plan === undefined
    ? ({
        id: 'bp_1',
        planned_at: new Date('2026-05-25T14:00:00.000Z'),
        concurrency: 5,
        deadline: null,
        predicted_cost_jpy: 1000,
        status: 'scheduled',
        kicked_at: null,
        created_at: new Date('2026-05-24T10:00:00.000Z'),
      } as BatchPlan)
    : opts.plan;
  const items: BatchPlanItem[] = (opts.items ?? []).map((i) => ({ ...i }));
  const themes: ThemeRow[] = opts.themes ?? [];

  let jobCounter = 0;
  const jobRepo: JobRepo = {
    create: vi.fn(async ({ data }) => {
      jobCounter += 1;
      return { id: `job_${jobCounter}` };
    }),
  };

  const batchPlanRepo: BatchPlanRepo = {
    create: vi.fn(),
    findUnique: vi.fn(async (_args) => {
      if (!plan) return null;
      return { ...plan, items } as BatchPlan & { items: BatchPlanItem[] };
    }),
    update: vi.fn(async () => ({})),
  };

  const batchPlanItemRepo: BatchPlanItemRepo = {
    create: vi.fn(),
    update: vi.fn(async ({ where, data }) => {
      const target = items.find((i) => i.id === where.id);
      if (target && typeof data.status === 'string') {
        target.status = data.status;
      }
      return {};
    }),
  };

  const themeFindMany = vi.fn(
    async (args: { where: { id: { in: string[] } } }) => {
      const ids = new Set(args.where.id.in);
      return themes.filter((t) => ids.has(t.id)).map((t) => ({ ...t }));
    },
  );

  const auditCreate = vi.fn(async () => ({}));
  const enqueue = vi.fn(async () => {
    if (opts.enqueueThrows) throw opts.enqueueThrows;
    return 'graphile_job_42';
  });

  const runCreateTransaction: CreateBatchPlanTxFn = async (fn) =>
    fn({
      batchPlanRepo,
      batchPlanItemRepo,
      auditLogRepo: { create: auditCreate },
    });

  const runKickTransaction: KickBatchNowTxFn = async (fn) =>
    fn({
      batchPlanRepo,
      batchPlanItemRepo,
      jobRepo,
      auditLogRepo: { create: auditCreate },
    });

  const deps: BatchesDeps = {
    themeCandidateRepo: { findMany: themeFindMany } as unknown as ThemeCandidateRepo,
    batchPlanRepo,
    batchPlanItemRepo,
    jobRepo,
    modelAssignmentRepo: {
      findMany: vi.fn(async () => []),
    } as unknown as ModelAssignmentReadRepo,
    modelCatalogRepo: {
      findMany: vi.fn(async () => []),
    } as unknown as ModelCatalogReadRepo,
    auditLogRepo: { create: auditCreate },
    session: { user: { id: 'u_1', username: 'operator' } },
    runCreateTransaction,
    runKickTransaction,
    enqueueJob: enqueue,
    now: () => FROZEN_NOW,
  };

  return {
    deps,
    spies: {
      jobCreate: jobRepo.create as ReturnType<typeof vi.fn>,
      enqueue,
      batchPlanUpdate: batchPlanRepo.update as ReturnType<typeof vi.fn>,
      batchPlanItemUpdate: batchPlanItemRepo.update as ReturnType<typeof vi.fn>,
      auditCreate,
    },
    store: { items },
  };
}

function itemStub(
  id: string,
  themeId: string,
  status: string = 'pending',
  override: object | null = null,
): BatchPlanItem {
  return {
    id,
    batch_id: 'bp_1',
    theme_id: themeId,
    book_id: null,
    override_model_assignments_json: override,
    status,
  } as BatchPlanItem;
}

// ---------------------------------------------------------------------------
// kickBatchNowCore — input + status guards
// ---------------------------------------------------------------------------

describe('kickBatchNowCore — input + status guards', () => {
  it('batchPlanId 欠落で validation', async () => {
    const { deps, spies } = makeKickDeps({});
    const r = await kickBatchNowCore({}, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.jobCreate).not.toHaveBeenCalled();
    expect(spies.enqueue).not.toHaveBeenCalled();
  });

  it('BatchPlan 不在で not_found', async () => {
    const { deps } = makeKickDeps({ plan: null });
    const r = await kickBatchNowCore({ batchPlanId: 'bp_x' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });

  it('status が scheduled でなければ validation', async () => {
    const { deps, spies } = makeKickDeps({
      plan: {
        id: 'bp_1',
        planned_at: new Date(),
        concurrency: 5,
        deadline: null,
        predicted_cost_jpy: 0,
        status: 'running',
        kicked_at: new Date(),
        created_at: new Date(),
      } as BatchPlan,
    });
    const r = await kickBatchNowCore({ batchPlanId: 'bp_1' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.jobCreate).not.toHaveBeenCalled();
    expect(spies.enqueue).not.toHaveBeenCalled();
    expect(spies.batchPlanUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// kickBatchNowCore — happy path
// ---------------------------------------------------------------------------

describe('kickBatchNowCore — happy path', () => {
  it('3 items → 各 Job INSERT + enqueueJob + BatchPlanItem.kicked + BatchPlan.running + audit', async () => {
    const items = [
      itemStub('bpi_1', 't_1'),
      itemStub('bpi_2', 't_2'),
      itemStub('bpi_3', 't_3'),
    ];
    const themes = [
      themeStub('t_1', 'accepted'),
      themeStub('t_2', 'accepted'),
      themeStub('t_3', 'accepted'),
    ];
    const { deps, spies, store } = makeKickDeps({ items, themes });

    const r = await kickBatchNowCore({ batchPlanId: 'bp_1' }, deps);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.kicked_count).toBe(3);
      expect(r.data.jobs).toHaveLength(3);
      expect(r.data.batch_id).toBe('bp_1');
      for (const j of r.data.jobs) {
        expect(j.job_id).toMatch(/^job_/);
        expect(j.graphile_job_id).toBe('graphile_job_42');
      }
    }

    // 3 件分の Job INSERT
    expect(spies.jobCreate).toHaveBeenCalledTimes(3);
    for (const call of spies.jobCreate.mock.calls) {
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.kind).toBe(PIPELINE_BOOK_KICKOFF_TASK_NAME);
      expect(arg.data.status).toBe('queued');
      const payload = arg.data.payload_json as Record<string, unknown>;
      expect(payload.theme_id).toMatch(/^t_/);
      expect(payload.account_id).toBe('acc_1');
      expect(payload.batch_plan_item_id).toMatch(/^bpi_/);
    }

    // enqueueJob 3 回 — task name と payload を検証
    expect(spies.enqueue).toHaveBeenCalledTimes(3);
    for (const call of spies.enqueue.mock.calls) {
      const [taskName, payload] = call as [string, Record<string, unknown>];
      expect(taskName).toBe(PIPELINE_BOOK_KICKOFF_TASK_NAME);
      expect(payload.theme_id).toMatch(/^t_/);
      expect(payload.account_id).toBe('acc_1');
      expect(payload.job_id).toMatch(/^job_/);
      expect(payload.batch_plan_item_id).toMatch(/^bpi_/);
    }

    // BatchPlanItem.status='kicked' に遷移
    for (const i of store.items) expect(i.status).toBe('kicked');

    // BatchPlan.update が 1 回 (status='running' + kicked_at)
    expect(spies.batchPlanUpdate).toHaveBeenCalledTimes(1);
    const planUpdArg = spies.batchPlanUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { status?: string; kicked_at?: Date };
    };
    expect(planUpdArg.where.id).toBe('bp_1');
    expect(planUpdArg.data.status).toBe('running');
    expect(planUpdArg.data.kicked_at).toEqual(FROZEN_NOW);

    // audit_log は最後の BatchPlan 更新時 1 件 (`batch_plan.kick`)
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe('batch_plan.kick');
    expect(auditArg.data.target_kind).toBe('batch_plan');
    expect(auditArg.data.target_id).toBe('bp_1');
    const after = auditArg.data.after_json as Record<string, unknown>;
    expect(after.status).toBe('running');
    expect(after.kicked_count).toBe(3);
  });

  it('override_model_assignments_json があれば Job.payload と enqueue payload の両方に乗る', async () => {
    const override = { marketer: { provider: 'openai', model: 'gpt-5' } };
    const items = [itemStub('bpi_1', 't_1', 'pending', override)];
    const themes = [themeStub('t_1', 'accepted')];
    const { deps, spies } = makeKickDeps({ items, themes });

    const r = await kickBatchNowCore({ batchPlanId: 'bp_1' }, deps);
    expect(isOk(r)).toBe(true);

    const jobArg = spies.jobCreate.mock.calls[0]?.[0] as {
      data: { payload_json: Record<string, unknown> };
    };
    expect(jobArg.data.payload_json.model_assignment_overrides).toEqual(override);

    const enqArg = spies.enqueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(enqArg[1].model_assignment_overrides).toEqual(override);
  });

  it('enqueueJob 失敗時は fail / BatchPlan.update は呼ばれない', async () => {
    const items = [itemStub('bpi_1', 't_1')];
    const themes = [themeStub('t_1', 'accepted')];
    const { deps, spies } = makeKickDeps({
      items,
      themes,
      enqueueThrows: new Error('graphile down'),
    });

    const r = await kickBatchNowCore({ batchPlanId: 'bp_1' }, deps);
    expect(isFail(r)).toBe(true);
    // Job INSERT は走ったが、enqueue 失敗で BatchPlan.update まで到達しない
    expect(spies.jobCreate).toHaveBeenCalledTimes(1);
    expect(spies.batchPlanUpdate).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('items 0 件でも plan が scheduled なら成功 (kicked_count=0)', async () => {
    const { deps, spies } = makeKickDeps({ items: [], themes: [] });
    const r = await kickBatchNowCore({ batchPlanId: 'bp_1' }, deps);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.kicked_count).toBe(0);
    expect(spies.jobCreate).not.toHaveBeenCalled();
    expect(spies.enqueue).not.toHaveBeenCalled();
    // BatchPlan は running に遷移する (空バッチ = 即完了相当の運用)
    expect(spies.batchPlanUpdate).toHaveBeenCalledTimes(1);
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// projectExceedsRedThreshold — unit tests (T-07-10)
// ---------------------------------------------------------------------------

describe('projectExceedsRedThreshold', () => {
  it('外挿合計 < 閾値なら false', () => {
    // actual=10000, elapsed=10, total=30 → projected=30000, batch=5000 → total=35000 < 50000
    expect(
      projectExceedsRedThreshold({
        actualCostJpy: 10_000,
        batchCostJpy: 5_000,
        elapsedDays: 10,
        totalDays: 30,
        redThresholdJpy: 50_000,
      }),
    ).toBe(false);
  });

  it('外挿合計 >= 閾値なら true', () => {
    // actual=40000, elapsed=10, total=30 → projected=120000, batch=0 → 120000 >= 50000
    expect(
      projectExceedsRedThreshold({
        actualCostJpy: 40_000,
        batchCostJpy: 0,
        elapsedDays: 10,
        totalDays: 30,
        redThresholdJpy: 50_000,
      }),
    ).toBe(true);
  });

  it('バッチコスト加算で閾値超過なら true', () => {
    // actual=10000, elapsed=10, total=10 (月末) → projected=10000, batch=45000 → 55000 >= 50000
    expect(
      projectExceedsRedThreshold({
        actualCostJpy: 10_000,
        batchCostJpy: 45_000,
        elapsedDays: 10,
        totalDays: 10,
        redThresholdJpy: 50_000,
      }),
    ).toBe(true);
  });

  it('elapsedDays=0 なら false (ゼロ除算回避)', () => {
    expect(
      projectExceedsRedThreshold({
        actualCostJpy: 99_999,
        batchCostJpy: 99_999,
        elapsedDays: 0,
        totalDays: 30,
        redThresholdJpy: 50_000,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-07-10 月次 100% kick rejection テスト
// ---------------------------------------------------------------------------

/**
 * createBatchPlanCore / kickBatchNowCore に月次予算 DI を注入するヘルパ。
 */
function injectMonthlyBudgetDeps(
  deps: BatchesDeps,
  opts: {
    actualCostJpy: number;
    redThresholdJpy: number;
    forceContinue?: boolean;
    /** frozen date の UTC date (elapsed days). */
    utcDate?: number;
  },
): BatchesDeps {
  const {
    actualCostJpy,
    redThresholdJpy,
    forceContinue = false,
    utcDate = 15,
  } = opts;

  const appSettingsRepo: AppSettingsMonthlyRepo = {
    findUnique: vi.fn(async () => ({
      monthly_cost_red_jpy: redThresholdJpy,
      force_continue: forceContinue,
    })),
  };

  const getMonthlyTotalCostFn: GetMonthlyTotalCostFn = vi.fn(async () => ({
    year: 2026,
    month: 5,
    total_cost_jpy: actualCostJpy,
  }));

  // Override now to control elapsed days.
  // FROZEN_NOW = 2026-05-24T12:00:00Z → utcDate=24
  const nowDate = new Date(Date.UTC(2026, 4, utcDate, 12, 0, 0)); // month is 0-based

  return {
    ...deps,
    appSettingsRepo,
    getMonthlyTotalCostFn,
    now: () => nowDate,
  };
}

describe('T-07-10 createBatchPlanCore — would_exceed_monthly', () => {
  function makeDepsWithForecast() {
    const themes = [themeStub('t_1', 'accepted'), themeStub('t_2', 'accepted')];
    const assignments = SNAPSHOT_ROLES.map((r) => assignmentStub(r));
    const catalog = [catalogStub('anthropic', 'claude-opus-4-7')];
    return makeCreateDeps({ themes, assignments, catalog });
  }

  it('予測が閾値を下回れば would_exceed_monthly=false', async () => {
    const { deps } = makeDepsWithForecast();
    // actual=0, batch小さい → projected << 50000
    const withBudget = injectMonthlyBudgetDeps(deps, {
      actualCostJpy: 0,
      redThresholdJpy: 50_000,
      utcDate: 15,
    });
    const r = await createBatchPlanCore(
      { themeIds: ['t_1', 't_2'], plannedAt: '2026-05-25T14:00:00.000Z' },
      withBudget,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.would_exceed_monthly).toBe(false);
  });

  it('予測が閾値以上なら would_exceed_monthly=true', async () => {
    const { deps } = makeDepsWithForecast();
    // actual=49000, elapsed=1 of 31 → projected=49000*31=1519000 >> 50000
    const withBudget = injectMonthlyBudgetDeps(deps, {
      actualCostJpy: 49_000,
      redThresholdJpy: 50_000,
      utcDate: 1,
    });
    const r = await createBatchPlanCore(
      { themeIds: ['t_1', 't_2'], plannedAt: '2026-05-25T14:00:00.000Z' },
      withBudget,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.would_exceed_monthly).toBe(true);
  });

  it('appSettingsRepo が未注入の場合は would_exceed_monthly=false (後方互換)', async () => {
    const { deps } = makeDepsWithForecast();
    // No appSettingsRepo injected (old behavior)
    const r = await createBatchPlanCore(
      { themeIds: ['t_1', 't_2'], plannedAt: '2026-05-25T14:00:00.000Z' },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.would_exceed_monthly).toBe(false);
  });
});

describe('T-07-10 kickBatchNowCore — 月次予算超過時の kick 拒否', () => {
  function makeKickDepsWithItems() {
    const items = [itemStub('bpi_1', 't_1')];
    const themes = [themeStub('t_1', 'accepted')];
    return makeKickDeps({ items, themes });
  }

  it('予測が閾値以上 + force_continue=false → ConflictError で kick 拒否', async () => {
    const { deps } = makeKickDepsWithItems();
    // actual=45000, elapsed=15, total=31 → projected=45000/15*31=93000 >> 50000
    const withBudget = injectMonthlyBudgetDeps(deps, {
      actualCostJpy: 45_000,
      redThresholdJpy: 50_000,
      forceContinue: false,
      utcDate: 15,
    });
    const r = await kickBatchNowCore({ batchPlanId: 'bp_1' }, withBudget);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('conflict');
  });

  it('予測が閾値以上 + force=true → kick 成功', async () => {
    const { deps } = makeKickDepsWithItems();
    const withBudget = injectMonthlyBudgetDeps(deps, {
      actualCostJpy: 45_000,
      redThresholdJpy: 50_000,
      forceContinue: false,
      utcDate: 15,
    });
    const r = await kickBatchNowCore({ batchPlanId: 'bp_1', force: true }, withBudget);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.kicked_count).toBe(1);
  });

  it('予測が閾値以上 + force_continue=true (設定で強制続行) → kick 成功', async () => {
    const { deps } = makeKickDepsWithItems();
    const withBudget = injectMonthlyBudgetDeps(deps, {
      actualCostJpy: 45_000,
      redThresholdJpy: 50_000,
      forceContinue: true, // AppSettings.force_continue=true は kick を許可する
      utcDate: 15,
    });
    const r = await kickBatchNowCore({ batchPlanId: 'bp_1' }, withBudget);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.kicked_count).toBe(1);
  });

  it('予測が閾値未満 → 拒否なし、kick 成功', async () => {
    const { deps } = makeKickDepsWithItems();
    const withBudget = injectMonthlyBudgetDeps(deps, {
      actualCostJpy: 100,
      redThresholdJpy: 50_000,
      forceContinue: false,
      utcDate: 15,
    });
    const r = await kickBatchNowCore({ batchPlanId: 'bp_1' }, withBudget);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.kicked_count).toBe(1);
  });

  it('appSettingsRepo 未注入 → 月次チェックなし、kick 成功', async () => {
    const { deps } = makeKickDepsWithItems();
    // No appSettingsRepo — backward compat
    const r = await kickBatchNowCore({ batchPlanId: 'bp_1' }, deps);
    expect(isOk(r)).toBe(true);
  });
});
