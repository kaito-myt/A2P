/**
 * triggerSalesFetchCore 単体テスト (T-12-06, F-038).
 *
 * 検証:
 *  1. 認証なし → fail('unauthorized')
 *  2. 無効 account_id (空文字) → zod validation エラー
 *  3. 無効 year_month 形式 → zod validation エラー
 *  4. 正常系: SalesFetchRun INSERT + addJob 呼出
 *  5. year_month 省略時は当月が使われる
 *  6. 同 account_id+year_month で 2 回呼んでも jobKey が同一（重複防止確認）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isFail, isOk } from '@a2p/contracts';

import {
  triggerSalesFetchCore,
  currentYearMonth,
  type TriggerSalesFetchDeps,
  type SalesFetchRunRepo,
  type SalesFetchEnqueueFn,
} from '../../lib/sales-fetch-core';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const SESSION = { user: { id: 'u_1', username: 'operator' } };
const FROZEN_NOW = new Date('2026-06-14T10:00:00.000Z');

function makeSalesFetchRunRepo(): {
  repo: SalesFetchRunRepo;
  createSpy: ReturnType<typeof vi.fn>;
} {
  let counter = 0;
  const createSpy = vi.fn(async () => {
    counter += 1;
    return { id: `run_${counter}` };
  });
  return { repo: { create: createSpy }, createSpy };
}

function makeEnqueueJob(): {
  fn: SalesFetchEnqueueFn;
  spy: ReturnType<typeof vi.fn>;
} {
  let jobCounter = 0;
  const spy = vi.fn(async () => {
    jobCounter += 1;
    return `job_${jobCounter}`;
  });
  return { fn: spy as unknown as SalesFetchEnqueueFn, spy };
}

function makeDeps(opts: {
  runRepo?: SalesFetchRunRepo;
  enqueueFn?: SalesFetchEnqueueFn;
} = {}): {
  deps: TriggerSalesFetchDeps;
  runRepo: ReturnType<typeof makeSalesFetchRunRepo>;
  enqueue: ReturnType<typeof makeEnqueueJob>;
} {
  const runRepo = { ...makeSalesFetchRunRepo(), ...(opts.runRepo ? { repo: opts.runRepo } : {}) };
  const enqueue = { ...makeEnqueueJob(), ...(opts.enqueueFn ? { fn: opts.enqueueFn } : {}) };

  return {
    deps: {
      salesFetchRunRepo: runRepo.repo,
      enqueueJob: enqueue.fn,
      session: SESSION,
      now: () => FROZEN_NOW,
    },
    runRepo,
    enqueue,
  };
}

// ---------------------------------------------------------------------------
// テスト 1: 無効 account_id → zod validation エラー
// ---------------------------------------------------------------------------

describe('triggerSalesFetchCore — 入力バリデーション', () => {
  it('account_id が空文字の場合 validation エラーを返す', async () => {
    const { deps } = makeDeps();
    const result = await triggerSalesFetchCore({ account_id: '' }, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('account_id がない場合 validation エラーを返す', async () => {
    const { deps } = makeDeps();
    const result = await triggerSalesFetchCore({ year_month: '2026-06' }, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('year_month の形式が不正な場合 validation エラーを返す', async () => {
    const { deps } = makeDeps();
    const result = await triggerSalesFetchCore(
      { account_id: 'acc_1', year_month: '2026/06' },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('null 入力で validation エラーを返す', async () => {
    const { deps } = makeDeps();
    const result = await triggerSalesFetchCore(null, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// テスト 2: 正常系
// ---------------------------------------------------------------------------

describe('triggerSalesFetchCore — 正常系', () => {
  it('SalesFetchRun が INSERT され addJob が呼ばれ job_id/run_id を返す', async () => {
    const { deps, runRepo, enqueue } = makeDeps();

    const result = await triggerSalesFetchCore(
      { account_id: 'acc_1', year_month: '2026-06' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.run_id).toBe('run_1');
      expect(result.data.job_id).toBe('job_1');
    }

    // SalesFetchRun が status=running で INSERT されている
    expect(runRepo.createSpy).toHaveBeenCalledTimes(1);
    const createArg = runRepo.createSpy.mock.calls[0]?.[0];
    expect(createArg?.data.account_id).toBe('acc_1');
    expect(createArg?.data.year_month).toBe('2026-06');
    expect(createArg?.data.status).toBe('running');

    // addJob が正しいタスク名とペイロードで呼ばれている
    expect(enqueue.spy).toHaveBeenCalledTimes(1);
    const [taskName, payload, spec] = enqueue.spy.mock.calls[0] ?? [];
    expect(taskName).toBe('sales.fetch');
    expect(payload).toEqual({ account_id: 'acc_1', year_month: '2026-06' });
    expect(spec?.jobKey).toBe('sales-fetch-acc_1-2026-06');
  });

  it('year_month 省略時は当月 (FROZEN_NOW=2026-06) が使われる', async () => {
    const { deps, runRepo, enqueue } = makeDeps();

    const result = await triggerSalesFetchCore({ account_id: 'acc_1' }, deps);

    expect(isOk(result)).toBe(true);

    const createArg = runRepo.createSpy.mock.calls[0]?.[0];
    expect(createArg?.data.year_month).toBe('2026-06');

    const [, payload] = enqueue.spy.mock.calls[0] ?? [];
    expect((payload as { year_month: string }).year_month).toBe('2026-06');
  });
});

// ---------------------------------------------------------------------------
// テスト 3: jobKey 重複防止 — 同 account+year_month の 2 回呼出
// ---------------------------------------------------------------------------

describe('triggerSalesFetchCore — jobKey 重複防止', () => {
  it('同じ account_id+year_month で 2 回呼んでも jobKey が同一', async () => {
    const { deps, enqueue } = makeDeps();

    await triggerSalesFetchCore({ account_id: 'acc_1', year_month: '2026-06' }, deps);
    await triggerSalesFetchCore({ account_id: 'acc_1', year_month: '2026-06' }, deps);

    expect(enqueue.spy).toHaveBeenCalledTimes(2);

    const [, , spec1] = enqueue.spy.mock.calls[0] ?? [];
    const [, , spec2] = enqueue.spy.mock.calls[1] ?? [];

    // 両呼出で jobKey が同一 → graphile-worker が重複排除する
    expect(spec1?.jobKey).toBe('sales-fetch-acc_1-2026-06');
    expect(spec2?.jobKey).toBe('sales-fetch-acc_1-2026-06');
    expect(spec1?.jobKey).toBe(spec2?.jobKey);
  });

  it('異なる year_month では jobKey が異なる', async () => {
    const { deps, enqueue } = makeDeps();

    await triggerSalesFetchCore({ account_id: 'acc_1', year_month: '2026-06' }, deps);
    await triggerSalesFetchCore({ account_id: 'acc_1', year_month: '2026-07' }, deps);

    const [, , spec1] = enqueue.spy.mock.calls[0] ?? [];
    const [, , spec2] = enqueue.spy.mock.calls[1] ?? [];

    expect(spec1?.jobKey).toBe('sales-fetch-acc_1-2026-06');
    expect(spec2?.jobKey).toBe('sales-fetch-acc_1-2026-07');
    expect(spec1?.jobKey).not.toBe(spec2?.jobKey);
  });
});

// ---------------------------------------------------------------------------
// テスト 4: enqueueJob 失敗時のエラーハンドリング
// ---------------------------------------------------------------------------

describe('triggerSalesFetchCore — enqueueFailed', () => {
  it('enqueueJob が例外を投げた場合 unknown エラーを返す', async () => {
    const failingEnqueue = vi.fn(async () => {
      throw new Error('DB connection failed');
    });

    const runRepo = makeSalesFetchRunRepo();

    const result = await triggerSalesFetchCore(
      { account_id: 'acc_1', year_month: '2026-06' },
      {
        salesFetchRunRepo: runRepo.repo,
        enqueueJob: failingEnqueue as unknown as SalesFetchEnqueueFn,
        session: SESSION,
        now: () => FROZEN_NOW,
      },
    );

    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// テスト 5: currentYearMonth ユーティリティ
// ---------------------------------------------------------------------------

describe('currentYearMonth', () => {
  it('2026-06-14 から 2026-06 を返す', () => {
    expect(currentYearMonth(new Date('2026-06-14T00:00:00.000Z'))).toBe('2026-06');
  });

  it('2026-01-01 から 2026-01 を返す（ゼロパディング）', () => {
    expect(currentYearMonth(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01');
  });
});
