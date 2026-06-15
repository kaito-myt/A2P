/**
 * model-assignments-core.ts のユニットテスト (T-02-11 / F-022・F-023).
 *
 * 検証:
 *  - upsertModelAssignmentCore: zod 検証 / catalog 存在チェック / archived 化 +
 *    新規 INSERT / audit_log の before/after / 同一割当の no-op
 *  - revertModelAssignmentCore: zod 検証 / archived のみ revert 可 /
 *    対象不在で NotFound / 現 active を archived 化して指定行を active に戻す
 *
 * トランザクションは in-memory state を共有する deps を作って即時実行する。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ModelAssignment, ModelCatalog } from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  revertModelAssignmentCore,
  upsertModelAssignmentCore,
  type ModelAssignmentsDeps,
} from '../../lib/model-assignments-core';

const FROZEN_NOW = new Date('2026-05-22T10:00:00.000Z');

function makeAssignment(overrides: Partial<ModelAssignment> = {}): ModelAssignment {
  return {
    id: 'asg_1',
    role: 'writer',
    genre: null,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    status: 'active',
    activated_at: new Date('2026-05-01T00:00:00.000Z'),
    archived_at: null,
    created_by: 'system',
    ...overrides,
  } as ModelAssignment;
}

function makeCatalog(overrides: Partial<ModelCatalog> = {}): ModelCatalog {
  return {
    id: 'mc_1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    input_price_per_mtok_usd: '3.000000' as unknown as ModelCatalog['input_price_per_mtok_usd'],
    output_price_per_mtok_usd: '15.000000' as unknown as ModelCatalog['output_price_per_mtok_usd'],
    image_price_per_image_usd: null,
    fx_rate_usd_jpy: '150.0000' as unknown as ModelCatalog['fx_rate_usd_jpy'],
    fetched_at: new Date('2026-05-20T00:00:00.000Z'),
    source: 'anthropic_pricing_page_v1',
    raw_json: {} as unknown as ModelCatalog['raw_json'],
    is_current: true,
    ...overrides,
  } as ModelCatalog;
}

interface DepsBag {
  deps: ModelAssignmentsDeps;
  spies: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    catalogFindFirst: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
  };
  store: ModelAssignment[];
}

function makeDeps(opts: {
  initial?: ModelAssignment[];
  catalog?: ModelCatalog[];
} = {}): DepsBag {
  const store: ModelAssignment[] = (opts.initial ?? []).map((a) => ({ ...a }));
  const catalog: ModelCatalog[] = opts.catalog ?? [makeCatalog()];

  const findFirst = vi.fn(
    async ({ where }: { where: { role: string; genre: string | null; status: string } }) => {
      const found = store.find(
        (a) => a.role === where.role && a.genre === where.genre && a.status === where.status,
      );
      return found ? { ...found } : null;
    },
  );

  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    const found = store.find((a) => a.id === where.id);
    return found ? { ...found } : null;
  });

  let createCounter = store.length;
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    createCounter += 1;
    const id = `asg_${createCounter}`;
    const row = {
      id,
      role: data.role as string,
      genre: (data.genre as string | null) ?? null,
      provider: data.provider as string,
      model: data.model as string,
      status: (data.status as string) ?? 'active',
      activated_at: (data.activated_at as Date | undefined) ?? FROZEN_NOW,
      archived_at: (data.archived_at as Date | null | undefined) ?? null,
      created_by: data.created_by as string,
    } as ModelAssignment;
    store.push({ ...row });
    return { ...row };
  });

  const update = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const idx = store.findIndex((a) => a.id === where.id);
      if (idx < 0) throw new Error('not found');
      const merged = { ...store[idx]! } as ModelAssignment;
      if (data.status !== undefined) merged.status = data.status as string;
      if (data.archived_at !== undefined)
        merged.archived_at = data.archived_at as Date | null;
      if (data.activated_at !== undefined) merged.activated_at = data.activated_at as Date;
      if (data.provider !== undefined) merged.provider = data.provider as string;
      if (data.model !== undefined) merged.model = data.model as string;
      store[idx] = { ...merged };
      return { ...merged };
    },
  );

  const catalogFindFirst = vi.fn(
    async ({ where }: { where: { provider: string; model: string; is_current: boolean } }) => {
      const found = catalog.find(
        (c) =>
          c.provider === where.provider &&
          c.model === where.model &&
          c.is_current === where.is_current,
      );
      return found ? ({ ...found } as ModelCatalog) : null;
    },
  );

  const auditCreate = vi.fn(async () => ({}));

  const repos = {
    modelAssignmentRepo: { findFirst, findUnique, create, update },
    auditLogRepo: { create: auditCreate },
  };

  const runTransaction: ModelAssignmentsDeps['runTransaction'] = async (fn) =>
    fn(repos as Parameters<typeof fn>[0]);

  return {
    deps: {
      modelAssignmentRepo: repos.modelAssignmentRepo as ModelAssignmentsDeps['modelAssignmentRepo'],
      modelCatalogRepo: { findFirst: catalogFindFirst } as ModelAssignmentsDeps['modelCatalogRepo'],
      auditLogRepo: repos.auditLogRepo as ModelAssignmentsDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
      runTransaction,
      now: () => FROZEN_NOW,
    },
    spies: { findFirst, findUnique, create, update, catalogFindFirst, auditCreate },
    store,
  };
}

// ---------------------------------------------------------------------------
// upsertModelAssignmentCore — zod
// ---------------------------------------------------------------------------

describe('upsertModelAssignmentCore — zod', () => {
  it('role が enum 外で validation', async () => {
    const { deps, spies } = makeDeps();
    const r = await upsertModelAssignmentCore(
      { role: 'designer', genre: null, provider: 'anthropic', model: 'm1' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.create).not.toHaveBeenCalled();
  });

  it('provider が enum 外で validation', async () => {
    const { deps } = makeDeps();
    const r = await upsertModelAssignmentCore(
      { role: 'writer', genre: null, provider: 'tavily', model: 'm1' },
      deps,
    );
    expect(isFail(r)).toBe(true);
  });

  it('genre が enum 外 (空文字) で validation', async () => {
    const { deps } = makeDeps();
    const r = await upsertModelAssignmentCore(
      { role: 'writer', genre: '', provider: 'anthropic', model: 'm1' },
      deps,
    );
    expect(isFail(r)).toBe(true);
  });

  it('genre=null は許容される (デフォルト枠)', async () => {
    const { deps } = makeDeps({
      catalog: [makeCatalog({ provider: 'anthropic', model: 'claude-opus-4-7' })],
    });
    const r = await upsertModelAssignmentCore(
      { role: 'writer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7' },
      deps,
    );
    expect(isOk(r)).toBe(true);
  });

  it('genre="business" 等の有効値は許容される', async () => {
    const { deps } = makeDeps({
      catalog: [makeCatalog({ provider: 'anthropic', model: 'claude-opus-4-7' })],
    });
    const r = await upsertModelAssignmentCore(
      { role: 'writer', genre: 'business', provider: 'anthropic', model: 'claude-opus-4-7' },
      deps,
    );
    expect(isOk(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// upsertModelAssignmentCore — happy paths
// ---------------------------------------------------------------------------

describe('upsertModelAssignmentCore — INSERT', () => {
  it('既存 active なし → 新規 INSERT のみ / audit_log 1 件 / before は null', async () => {
    const { deps, spies, store } = makeDeps({
      catalog: [makeCatalog({ provider: 'anthropic', model: 'claude-opus-4-7' })],
    });
    const r = await upsertModelAssignmentCore(
      { role: 'writer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7' },
      deps,
    );
    expect(isOk(r)).toBe(true);

    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.create).toHaveBeenCalledTimes(1);
    const createArg = spies.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createArg.data.role).toBe('writer');
    expect(createArg.data.genre).toBeNull();
    expect(createArg.data.provider).toBe('anthropic');
    expect(createArg.data.model).toBe('claude-opus-4-7');
    expect(createArg.data.status).toBe('active');
    expect(createArg.data.created_by).toBe('u_1');
    expect(createArg.data.activated_at).toBe(FROZEN_NOW);

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('model_assignment.upsert');
    expect(auditArg.data.target_kind).toBe('model_assignment');
    expect(auditArg.data.target_id).toBe('writer/default');
    expect(auditArg.data.actor_id).toBe('u_1');
    // before_json は Prisma.JsonNull (= null) として記録される
    expect(auditArg.data.before_json).toBeDefined();
    expect(auditArg.data.after_json).toMatchObject({
      role: 'writer',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      status: 'active',
    });

    expect(store.length).toBe(1);
  });

  it('既存 active あり → archived 化 + 新 INSERT / audit_log 1 件 (before/after 共に snapshot)', async () => {
    const existing = makeAssignment({
      id: 'asg_old',
      role: 'writer',
      genre: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      status: 'active',
    });
    const { deps, spies, store } = makeDeps({
      initial: [existing],
      catalog: [makeCatalog({ provider: 'openai', model: 'gpt-5' })],
    });
    const r = await upsertModelAssignmentCore(
      { role: 'writer', genre: null, provider: 'openai', model: 'gpt-5' },
      deps,
    );
    expect(isOk(r)).toBe(true);

    // 既存 active を archived 化
    expect(spies.update).toHaveBeenCalledTimes(1);
    const updArg = spies.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updArg.where.id).toBe('asg_old');
    expect(updArg.data.status).toBe('archived');
    expect(updArg.data.archived_at).toBe(FROZEN_NOW);

    // 新規 INSERT
    expect(spies.create).toHaveBeenCalledTimes(1);
    const createArg = spies.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createArg.data.provider).toBe('openai');
    expect(createArg.data.model).toBe('gpt-5');

    // audit_log
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('model_assignment.upsert');
    const before = auditArg.data.before_json as Record<string, unknown>;
    expect(before.id).toBe('asg_old');
    expect(before.provider).toBe('anthropic');
    expect(before.model).toBe('claude-sonnet-4-6');
    const after = auditArg.data.after_json as Record<string, unknown>;
    expect(after.provider).toBe('openai');
    expect(after.model).toBe('gpt-5');
    expect(after.status).toBe('active');

    // store: archived 1 + active 1
    expect(store.length).toBe(2);
    expect(store.find((a) => a.id === 'asg_old')?.status).toBe('archived');
  });

  it('同一 provider/model に切り替え → validation で no-op', async () => {
    const existing = makeAssignment({
      id: 'asg_old',
      role: 'writer',
      genre: 'business',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      status: 'active',
    });
    const { deps, spies } = makeDeps({
      initial: [existing],
      catalog: [makeCatalog({ provider: 'anthropic', model: 'claude-opus-4-7' })],
    });
    const r = await upsertModelAssignmentCore(
      { role: 'writer', genre: 'business', provider: 'anthropic', model: 'claude-opus-4-7' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.create).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('catalog に provider/model が無い → validation (modelNotInCatalog)', async () => {
    const { deps, spies } = makeDeps({
      catalog: [makeCatalog({ provider: 'anthropic', model: 'claude-opus-4-7' })],
    });
    const r = await upsertModelAssignmentCore(
      { role: 'writer', genre: null, provider: 'openai', model: 'ghost-model' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) {
      expect(r.error.code).toBe('validation');
      expect(r.error.message).toMatch(/カタログ/);
    }
    expect(spies.create).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('target_id は role/genre 形式で記録される (default はリテラル "default")', async () => {
    const { deps, spies } = makeDeps({
      catalog: [makeCatalog({ provider: 'anthropic', model: 'claude-opus-4-7' })],
    });
    await upsertModelAssignmentCore(
      { role: 'editor', genre: 'self_help', provider: 'anthropic', model: 'claude-opus-4-7' },
      deps,
    );
    const arg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(arg.data.target_id).toBe('editor/self_help');

    // 別ケース: genre=null → "default"
    const { deps: deps2, spies: spies2 } = makeDeps({
      catalog: [makeCatalog({ provider: 'anthropic', model: 'claude-opus-4-7' })],
    });
    await upsertModelAssignmentCore(
      { role: 'marketer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7' },
      deps2,
    );
    const arg2 = spies2.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(arg2.data.target_id).toBe('marketer/default');
  });
});

// ---------------------------------------------------------------------------
// revertModelAssignmentCore
// ---------------------------------------------------------------------------

describe('revertModelAssignmentCore', () => {
  it('zod: id 欠落で validation', async () => {
    const { deps } = makeDeps();
    const r = await revertModelAssignmentCore({}, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('存在しない id → not_found', async () => {
    const { deps, spies } = makeDeps();
    const r = await revertModelAssignmentCore({ id: 'ghost' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('active 行を指定 → validation (alreadyActive)', async () => {
    const active = makeAssignment({
      id: 'asg_curr',
      role: 'writer',
      genre: null,
      status: 'active',
    });
    const { deps, spies } = makeDeps({ initial: [active] });
    const r = await revertModelAssignmentCore({ id: 'asg_curr' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('archived 行を revert → 現 active を archived 化 + 対象を active に戻す + audit 1 件', async () => {
    const current = makeAssignment({
      id: 'asg_curr',
      role: 'writer',
      genre: null,
      provider: 'openai',
      model: 'gpt-5',
      status: 'active',
      activated_at: new Date('2026-05-10T00:00:00.000Z'),
    });
    const old = makeAssignment({
      id: 'asg_old',
      role: 'writer',
      genre: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      status: 'archived',
      archived_at: new Date('2026-05-10T00:00:00.000Z'),
    });
    const { deps, spies, store } = makeDeps({ initial: [current, old] });

    const r = await revertModelAssignmentCore({ id: 'asg_old' }, deps);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.id).toBe('asg_old');

    // update は 2 回: (1) current を archived 化, (2) old を active 化
    expect(spies.update).toHaveBeenCalledTimes(2);
    const firstUpd = spies.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(firstUpd.where.id).toBe('asg_curr');
    expect(firstUpd.data.status).toBe('archived');
    expect(firstUpd.data.archived_at).toBe(FROZEN_NOW);

    const secondUpd = spies.update.mock.calls[1]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(secondUpd.where.id).toBe('asg_old');
    expect(secondUpd.data.status).toBe('active');
    expect(secondUpd.data.activated_at).toBe(FROZEN_NOW);
    expect(secondUpd.data.archived_at).toBeNull();

    // audit_log
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('model_assignment.revert');
    expect(auditArg.data.target_id).toBe('writer/default');
    const before = auditArg.data.before_json as Record<string, unknown>;
    expect(before.id).toBe('asg_curr');
    expect(before.provider).toBe('openai');
    const after = auditArg.data.after_json as Record<string, unknown>;
    expect(after.id).toBe('asg_old');
    expect(after.provider).toBe('anthropic');
    expect(after.status).toBe('active');

    // store: ちょうど 2 行で active が old に切り替わっている
    expect(store.length).toBe(2);
    expect(store.find((a) => a.id === 'asg_old')?.status).toBe('active');
    expect(store.find((a) => a.id === 'asg_curr')?.status).toBe('archived');
  });

  it('現 active が無いケース (孤立した archived) でも revert 出来る', async () => {
    const orphan = makeAssignment({
      id: 'asg_orphan',
      role: 'writer',
      genre: 'business',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      status: 'archived',
      archived_at: new Date('2026-05-15T00:00:00.000Z'),
    });
    const { deps, spies, store } = makeDeps({ initial: [orphan] });

    const r = await revertModelAssignmentCore({ id: 'asg_orphan' }, deps);
    expect(isOk(r)).toBe(true);

    // update は 1 回 (orphan を active 化のみ)
    expect(spies.update).toHaveBeenCalledTimes(1);
    const updArg = spies.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updArg.where.id).toBe('asg_orphan');
    expect(updArg.data.status).toBe('active');

    expect(store.find((a) => a.id === 'asg_orphan')?.status).toBe('active');

    // audit before_json は Prisma.JsonNull (現 active が居なかった)
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('model_assignment.revert');
  });
});
