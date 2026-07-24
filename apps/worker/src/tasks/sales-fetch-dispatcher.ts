import type { JobHelpers, Task } from 'graphile-worker';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `sales.fetch.dispatch` タスク (SP-12 T-12-05, docs/05 §5.4 / F-038)
 *
 * cron で毎日 02:00 JST (0 17 * * * UTC) に起動し、
 * accounts.status='active' の全アカウントに対して
 * `sales.fetch` ジョブを enqueue する ($ALL 展開ロジック)。
 *
 * フロー:
 *   1. accounts.status='active' を全件取得
 *   2. 当月 year_month を YYYY-MM 形式で生成
 *   3. 各アカウントに addJob('sales.fetch', { account_id, year_month }) を enqueue
 *
 * エラー方針:
 *   - 1 アカウントの enqueue 失敗で他アカウントは継続
 *   - task 全体の throw は graphile-worker リトライに委ねる
 */

export const SALES_FETCH_DISPATCHER_TASK_NAME = 'sales.fetch.dispatch';

// ---------------------------------------------------------------------------
// Prisma 最小インターフェース
// ---------------------------------------------------------------------------

export interface SalesFetchDispatcherPrisma {
  account: {
    findMany(args: {
      where: { status: string };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
}

// ---------------------------------------------------------------------------
// addJob 型 (batch-plan-dispatcher パターンに倣う)
// ---------------------------------------------------------------------------

export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// deps インターフェース
// ---------------------------------------------------------------------------

export interface SalesFetchDispatcherDeps {
  prisma?: SalesFetchDispatcherPrisma;
  addJob?: AddJobLike;
  logger?: Logger;
  /** 「今」を固定（テスト用） */
  now?: () => Date;
}

export interface SalesFetchDispatcherResult {
  scannedAccounts: number;
  enqueuedJobs: number;
  failedAccounts: number;
  yearMonth: string;
}

// ---------------------------------------------------------------------------
// 純ロジック関数
// ---------------------------------------------------------------------------

export async function runSalesFetchDispatcher(
  deps: SalesFetchDispatcherDeps = {},
): Promise<SalesFetchDispatcherResult> {
  const log = deps.logger ?? createLogger(`worker.${SALES_FETCH_DISPATCHER_TASK_NAME}`);
  const db = deps.prisma ?? (defaultPrisma as unknown as SalesFetchDispatcherPrisma);
  const addJob = deps.addJob;

  if (!addJob) {
    throw new Error(
      `${SALES_FETCH_DISPATCHER_TASK_NAME}: addJob must be provided (got undefined)`,
    );
  }

  const now = deps.now?.() ?? new Date();

  // JST 基準で当月 + 前月を対象にする。
  //  - 当月: KENP ページ/有料販売の速報を毎日更新。
  //  - 前月: 月初に KENP ロイヤリティが確定するので、確定値を取り込み直す。
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth(); // 0-11
  const yearMonth = `${y}-${String(m + 1).padStart(2, '0')}`;
  const prev = m === 0 ? { y: y - 1, m: 12 } : { y, m };
  const prevYearMonth = `${prev.y}-${String(prev.m).padStart(2, '0')}`;
  const targetMonths = [prevYearMonth, yearMonth];

  log.info(
    { task: SALES_FETCH_DISPATCHER_TASK_NAME, targetMonths },
    'sales.fetch.dispatch tick start',
  );

  // 1. active アカウントを全件取得
  const accounts = await db.account.findMany({
    where: { status: 'active' },
    select: { id: true },
  });

  if (accounts.length === 0) {
    log.info(
      { task: SALES_FETCH_DISPATCHER_TASK_NAME, scannedAccounts: 0 },
      'no active accounts — dispatcher tick done',
    );
    return { scannedAccounts: 0, enqueuedJobs: 0, failedAccounts: 0, yearMonth };
  }

  // 2. 各アカウント × 対象月 (前月/当月) に sales.fetch をキュー投入
  let enqueuedJobs = 0;
  let failedAccounts = 0;

  for (const account of accounts) {
    let accountFailed = false;
    for (const ym of targetMonths) {
      try {
        await addJob('sales.fetch', { account_id: account.id, year_month: ym });
        enqueuedJobs++;
      } catch (err) {
        log.warn(
          { task: SALES_FETCH_DISPATCHER_TASK_NAME, account_id: account.id, year_month: ym, err },
          'failed to enqueue sales.fetch — continuing',
        );
        accountFailed = true;
      }
    }
    if (accountFailed) failedAccounts++;
  }

  log.info(
    {
      task: SALES_FETCH_DISPATCHER_TASK_NAME,
      scannedAccounts: accounts.length,
      enqueuedJobs,
      failedAccounts,
      yearMonth,
    },
    'sales.fetch.dispatch tick done',
  );

  return {
    scannedAccounts: accounts.length,
    enqueuedJobs,
    failedAccounts,
    yearMonth,
  };
}

// ---------------------------------------------------------------------------
// graphile-worker Task 薄ラッパ
// ---------------------------------------------------------------------------

export const salesFetchDispatcherTask: Task = async (
  _payload: unknown,
  helpers: JobHelpers,
) => {
  await runSalesFetchDispatcher({
    addJob: helpers.addJob as unknown as AddJobLike,
  });
};
