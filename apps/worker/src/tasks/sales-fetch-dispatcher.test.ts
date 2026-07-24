import { describe, it, expect, vi } from 'vitest';

import {
  runSalesFetchDispatcher,
  SALES_FETCH_DISPATCHER_TASK_NAME,
  type SalesFetchDispatcherPrisma,
  type AddJobLike,
} from './sales-fetch-dispatcher.js';
import type { Logger } from '@a2p/contracts/logger';

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

const silentLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => silentLogger,
} as unknown as Logger;

function makeMockPrisma(accounts: Array<{ id: string }>): SalesFetchDispatcherPrisma {
  return {
    account: {
      findMany: vi.fn().mockResolvedValue(accounts),
    },
  };
}

function makeAddJob(): { fn: AddJobLike; calls: Array<{ id: string; payload: unknown }> } {
  const calls: Array<{ id: string; payload: unknown }> = [];
  const fn: AddJobLike = vi.fn().mockImplementation((id: string, payload: unknown) => {
    calls.push({ id, payload });
    return Promise.resolve({});
  });
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('runSalesFetchDispatcher', () => {
  const FIXED_NOW = new Date('2026-06-14T00:00:00Z');
  const EXPECTED_YEAR_MONTH = '2026-06';

  // -----------------------------------------------------------------------
  // addJob 未提供でエラー
  // -----------------------------------------------------------------------
  it('addJob が未提供のとき throw する', async () => {
    await expect(
      runSalesFetchDispatcher({ logger: silentLogger }),
    ).rejects.toThrow(`${SALES_FETCH_DISPATCHER_TASK_NAME}: addJob must be provided`);
  });

  // -----------------------------------------------------------------------
  // active アカウントなし
  // -----------------------------------------------------------------------
  it('active アカウントが 0 件のとき enqueuedJobs=0 を返す', async () => {
    const db = makeMockPrisma([]);
    const { fn } = makeAddJob();

    const result = await runSalesFetchDispatcher({
      prisma: db,
      addJob: fn,
      logger: silentLogger,
      now: () => FIXED_NOW,
    });

    expect(result.scannedAccounts).toBe(0);
    expect(result.enqueuedJobs).toBe(0);
    expect(result.failedAccounts).toBe(0);
    expect(result.yearMonth).toBe(EXPECTED_YEAR_MONTH);
    expect(fn).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 正常系: 全 active アカウント分を enqueue
  // -----------------------------------------------------------------------
  it('active アカウント 3 件 × 対象月(前月/当月) 2 で sales.fetch を 6 件 enqueue する', async () => {
    const accounts = [
      { id: 'acc-001' },
      { id: 'acc-002' },
      { id: 'acc-003' },
    ];
    const db = makeMockPrisma(accounts);
    const { fn, calls } = makeAddJob();

    const result = await runSalesFetchDispatcher({
      prisma: db,
      addJob: fn,
      logger: silentLogger,
      now: () => FIXED_NOW,
    });

    expect(result.scannedAccounts).toBe(3);
    expect(result.enqueuedJobs).toBe(6); // 3 アカウント × 2 ヶ月
    expect(result.failedAccounts).toBe(0);
    expect(result.yearMonth).toBe(EXPECTED_YEAR_MONTH);

    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(call.id).toBe('sales.fetch');
    }

    // 各アカウントが 2 回 (前月/当月) 現れる
    const payloadAccountIds = calls.map((c) => (c.payload as { account_id: string }).account_id).sort();
    expect(payloadAccountIds).toEqual(['acc-001', 'acc-001', 'acc-002', 'acc-002', 'acc-003', 'acc-003']);

    // year_month は前月(2026-05) と 当月(2026-06)
    const months = new Set(calls.map((c) => (c.payload as { year_month: string }).year_month));
    expect([...months].sort()).toEqual(['2026-05', '2026-06']);
  });

  // -----------------------------------------------------------------------
  // 1 アカウントの enqueue 失敗は他アカウントに波及しない
  // -----------------------------------------------------------------------
  it('1 アカウントの addJob 失敗は他アカウントの enqueue を継続する', async () => {
    const accounts = [{ id: 'acc-ok1' }, { id: 'acc-fail' }, { id: 'acc-ok2' }];
    const db = makeMockPrisma(accounts);

    let callCount = 0;
    const addJob: AddJobLike = vi.fn().mockImplementation((_id: string, payload: unknown) => {
      callCount++;
      const p = payload as { account_id: string };
      if (p.account_id === 'acc-fail') {
        return Promise.reject(new Error('simulated enqueue error'));
      }
      return Promise.resolve({});
    });

    const result = await runSalesFetchDispatcher({
      prisma: db,
      addJob,
      logger: silentLogger,
      now: () => FIXED_NOW,
    });

    expect(result.scannedAccounts).toBe(3);
    expect(result.enqueuedJobs).toBe(4); // 2 アカウント成功 × 2 ヶ月
    expect(result.failedAccounts).toBe(1); // acc-fail のみ (両月失敗)
    expect(callCount).toBe(6); // 3 アカウント × 2 ヶ月すべて試行
  });

  // -----------------------------------------------------------------------
  // year_month の UTC 計算確認
  // -----------------------------------------------------------------------
  it('now が 2025-12-31T23:59:59Z なら year_month は 2025-12', async () => {
    const db = makeMockPrisma([{ id: 'acc-x' }]);
    const { fn, calls } = makeAddJob();

    await runSalesFetchDispatcher({
      prisma: db,
      addJob: fn,
      logger: silentLogger,
      now: () => new Date('2025-12-31T23:59:59Z'),
    });

    const payload = calls[0]!.payload as { year_month: string };
    expect(payload.year_month).toBe('2025-12');
  });

  // -----------------------------------------------------------------------
  // accounts.status='active' フィルタが DB クエリに渡されることを確認
  // -----------------------------------------------------------------------
  it('DB に status="active" フィルタを渡す', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db: SalesFetchDispatcherPrisma = { account: { findMany } };
    const { fn } = makeAddJob();

    await runSalesFetchDispatcher({
      prisma: db,
      addJob: fn,
      logger: silentLogger,
      now: () => FIXED_NOW,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'active' },
      }),
    );
  });
});
