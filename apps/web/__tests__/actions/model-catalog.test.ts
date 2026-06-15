/**
 * model-catalog-core.ts のユニットテスト (T-02-10 / F-024 / F-025).
 *
 * 検証:
 *  - refreshModelCatalog: enqueueJob('catalog.fetch', { trigger: 'manual' })
 *    が呼ばれ、audit_log に記録され、job_id を返す
 *  - editCatalogEntry: zod 検証 / 対象行 fetch / update (source=manual_edit_v1)
 *    / audit_log の before/after に Decimal が文字列化されて入る
 *  - 不正入力 / 行未発見の振る舞い
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma, type ModelCatalog } from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  editCatalogEntryCore,
  refreshModelCatalogCore,
  type ModelCatalogDeps,
} from '../../lib/model-catalog-core';

const FROZEN_NOW = new Date('2026-05-22T10:00:00.000Z');

function makeRow(overrides: Partial<ModelCatalog> = {}): ModelCatalog {
  return {
    id: 'mc_1',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    input_price_per_mtok_usd: new Prisma.Decimal('15.000000'),
    output_price_per_mtok_usd: new Prisma.Decimal('75.000000'),
    image_price_per_image_usd: null,
    fx_rate_usd_jpy: new Prisma.Decimal('150.0000'),
    fetched_at: new Date('2026-05-20T06:00:00.000Z'),
    source: 'anthropic_pricing_page_v1',
    raw_json: {} as unknown as ModelCatalog['raw_json'],
    is_current: true,
    ...overrides,
  } as ModelCatalog;
}

function makeDeps(opts: {
  current?: ModelCatalog | null;
  enqueueImpl?: (taskName: string, payload: unknown) => Promise<string>;
} = {}): {
  deps: ModelCatalogDeps;
  spies: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };
} {
  let current: ModelCatalog | null = opts.current ?? null;

  const findFirst = vi.fn(async ({ where }: { where: { provider: string; model: string; is_current: boolean } }) => {
    if (
      current
      && current.provider === where.provider
      && current.model === where.model
      && current.is_current === where.is_current
    ) {
      return { ...current };
    }
    return null;
  });
  const update = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    if (!current || current.id !== where.id) throw new Error('not found');
    const merged = { ...current } as ModelCatalog;
    if (data.source !== undefined) merged.source = String(data.source);
    if (data.fetched_at !== undefined) merged.fetched_at = data.fetched_at as Date;
    if (data.input_price_per_mtok_usd !== undefined) {
      merged.input_price_per_mtok_usd = data.input_price_per_mtok_usd as Prisma.Decimal;
    }
    if (data.output_price_per_mtok_usd !== undefined) {
      merged.output_price_per_mtok_usd = data.output_price_per_mtok_usd as Prisma.Decimal;
    }
    if (data.image_price_per_image_usd !== undefined) {
      merged.image_price_per_image_usd = data.image_price_per_image_usd as Prisma.Decimal;
    }
    current = merged;
    return { ...current };
  });
  const auditCreate = vi.fn(async () => ({}));
  const enqueue = vi.fn(opts.enqueueImpl ?? (async () => 'job_42'));

  return {
    deps: {
      modelCatalogRepo: { findFirst, update } as unknown as ModelCatalogDeps['modelCatalogRepo'],
      auditLogRepo: { create: auditCreate } as unknown as ModelCatalogDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
      enqueueJob: enqueue,
      now: () => FROZEN_NOW,
    },
    spies: { findFirst, update, auditCreate, enqueue },
  };
}

// ---------------------------------------------------------------------------
// refreshModelCatalogCore
// ---------------------------------------------------------------------------

describe('refreshModelCatalogCore', () => {
  it('引数なしで enqueue + audit が走り、job_id を返す', async () => {
    const { deps, spies } = makeDeps();
    const r = await refreshModelCatalogCore(undefined, deps);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.job_id).toBe('job_42');

    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    expect(spies.enqueue).toHaveBeenCalledWith('catalog.fetch', { trigger: 'manual' });

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArg.data.actor_id).toBe('u_1');
    expect(auditArg.data.action).toBe('model_catalog.refresh');
    expect(auditArg.data.target_kind).toBe('model_catalog');
    expect(auditArg.data.target_id).toBe('job_42');
    expect(auditArg.data.after_json).toMatchObject({ trigger: 'manual', job_id: 'job_42' });
  });

  it('{ trigger: "manual" } を明示渡しても OK', async () => {
    const { deps, spies } = makeDeps();
    const r = await refreshModelCatalogCore({ trigger: 'manual' }, deps);
    expect(isOk(r)).toBe(true);
    expect(spies.enqueue).toHaveBeenCalledWith('catalog.fetch', { trigger: 'manual' });
  });

  it('trigger に不正値が入ると validation', async () => {
    const { deps, spies } = makeDeps();
    const r = await refreshModelCatalogCore({ trigger: 'auto' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.enqueue).not.toHaveBeenCalled();
  });

  it('enqueue が例外を投げると unknown fail / audit は記録しない', async () => {
    const { deps, spies } = makeDeps({
      enqueueImpl: async () => {
        throw new Error('pg connection refused');
      },
    });
    const r = await refreshModelCatalogCore(undefined, deps);
    expect(isFail(r)).toBe(true);
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// editCatalogEntryCore
// ---------------------------------------------------------------------------

describe('editCatalogEntryCore', () => {
  it('provider 欠落で validation', async () => {
    const { deps } = makeDeps({ current: makeRow() });
    const r = await editCatalogEntryCore({ model: 'claude-opus-4-7' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('input_price が負数で validation', async () => {
    const { deps } = makeDeps({ current: makeRow() });
    const r = await editCatalogEntryCore(
      { provider: 'anthropic', model: 'claude-opus-4-7', input_price_per_mtok_usd: -1 },
      deps,
    );
    expect(isFail(r)).toBe(true);
  });

  it('対象行が無いと not_found', async () => {
    const { deps, spies } = makeDeps({ current: null });
    const r = await editCatalogEntryCore(
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        input_price_per_mtok_usd: 10,
        output_price_per_mtok_usd: 50,
      },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('正常系: update が source=manual_edit_v1 + fetched_at=now + 価格更新で呼ばれる', async () => {
    const row = makeRow();
    const { deps, spies } = makeDeps({ current: row });
    const r = await editCatalogEntryCore(
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        input_price_per_mtok_usd: 12.5,
        output_price_per_mtok_usd: 80,
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.id).toBe('mc_1');

    expect(spies.update).toHaveBeenCalledTimes(1);
    const upArg = spies.update.mock.calls[0]?.[0] as { where: { id: string }; data: Record<string, unknown> };
    expect(upArg.where.id).toBe('mc_1');
    expect(upArg.data.source).toBe('manual_edit_v1');
    expect(upArg.data.fetched_at).toBe(FROZEN_NOW);
    // Decimal 形でラップされていること
    const inDec = upArg.data.input_price_per_mtok_usd as Prisma.Decimal;
    const outDec = upArg.data.output_price_per_mtok_usd as Prisma.Decimal;
    expect(inDec).toBeInstanceOf(Prisma.Decimal);
    expect(inDec.toString()).toBe('12.5');
    expect(outDec.toString()).toBe('80');
    // image は渡していないので update.data に含まれない
    expect(upArg.data.image_price_per_image_usd).toBeUndefined();
  });

  it('image_price のみ更新できる (部分更新)', async () => {
    const row = makeRow();
    const { deps, spies } = makeDeps({ current: row });
    const r = await editCatalogEntryCore(
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        image_price_per_image_usd: 0.04,
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    const upArg = spies.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(upArg.data.input_price_per_mtok_usd).toBeUndefined();
    expect(upArg.data.output_price_per_mtok_usd).toBeUndefined();
    const imgDec = upArg.data.image_price_per_image_usd as Prisma.Decimal;
    expect(imgDec.toString()).toBe('0.04');
  });

  it('audit_log の before/after に provider/model/価格スナップショットが入る', async () => {
    const row = makeRow();
    const { deps, spies } = makeDeps({ current: row });
    await editCatalogEntryCore(
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        input_price_per_mtok_usd: 12.5,
        output_price_per_mtok_usd: 80,
      },
      deps,
    );
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('model_catalog.edit');
    expect(auditArg.data.target_kind).toBe('model_catalog');
    expect(auditArg.data.target_id).toBe('mc_1');

    const before = auditArg.data.before_json as Record<string, unknown>;
    const after = auditArg.data.after_json as Record<string, unknown>;
    expect(before.provider).toBe('anthropic');
    expect(before.model).toBe('claude-opus-4-7');
    expect(before.input_price_per_mtok_usd).toBe('15');
    expect(before.output_price_per_mtok_usd).toBe('75');
    expect(before.source).toBe('anthropic_pricing_page_v1');

    expect(after.source).toBe('manual_edit_v1');
    expect(after.input_price_per_mtok_usd).toBe('12.5');
    expect(after.output_price_per_mtok_usd).toBe('80');
  });

  it('update が例外を投げると unknown fail / audit は記録しない', async () => {
    const row = makeRow();
    const { deps, spies } = makeDeps({ current: row });
    spies.update.mockRejectedValueOnce(new Error('db down'));
    const r = await editCatalogEntryCore(
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        input_price_per_mtok_usd: 12.5,
        output_price_per_mtok_usd: 80,
      },
      deps,
    );
    expect(isFail(r)).toBe(true);
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });
});
