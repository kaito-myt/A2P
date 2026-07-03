import type { JobHelpers, Task } from 'graphile-worker';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma, Prisma } from '@a2p/db';

/**
 * `batch_plan.dispatcher` タスク (T-03-10, docs/05 §5.4 / F-021)
 *
 * 毎分 cron で起動し、`status='scheduled' AND planned_at <= now()` の `BatchPlan` を一括 kick する。
 * SP-03 T-03-09 の `kickBatchNowCore` (apps/web/lib/batches-core.ts) と同等の DB 効果を持つが、
 * worker 側で独立実装することで以下のトレードオフを取った:
 *   - core を packages/* へ昇格させると Next.js セッション依存が grafilte-worker に染み出す
 *   - SA 側 (T-03-09) は session.user.id を audit_log に残すが、cron 起動はシステム実行のため
 *     actor_id=null + action='batch_plan.cron_kick' で区別
 *
 * フロー (1 cron tick):
 *   1. 対象 BatchPlan を一括 fetch (status='scheduled' AND planned_at <= now())
 *   2. 各 plan について `dispatchSinglePlan` を try/catch で個別実行
 *      (1 plan 失敗で他 plan は継続。docs/05 §5 共通ポリシー)
 *   3. dispatchSinglePlan 内:
 *      a. pending BatchPlanItem を fetch (status='kicked' は idempotent skip;
 *         T-03-09 申し送り対応)
 *      b. 各 pending item について (per-item トランザクション):
 *         - Job 行 INSERT (kind='pipeline.book.kickoff', status='queued', payload に
 *           theme_id / account_id / batch_plan_item_id / model_assignment_overrides)
 *         - addJob('pipeline.book.kickoff', payload + job_id) で graphile-worker キュー投入
 *         - BatchPlanItem.status='kicked'
 *      c. BatchPlan.status='running', kicked_at=now()
 *      d. audit_log INSERT (action='batch_plan.cron_kick', actor_id=null)
 *
 * 冪等性 (T-03-09 申し送り):
 *   - BatchPlanItem.status='pending' のみ kick 対象 → kicked は skip
 *   - 同一 plan が複数 dispatcher tick で読まれることはほぼ無いが、念のため status='scheduled'
 *     条件で fetch するため、running 化済 plan は次 tick で対象外
 *
 * エラー方針:
 *   - graphile-worker のリトライに任せる (throw すれば retry)
 *   - ただし「一部 plan のみ失敗」のケースでは throw せず continue
 *     (失敗 plan は status='scheduled' のまま残り、次 tick で再試行される)
 *   - addJob 失敗時はその item のみ pending のまま残し、ループ継続
 */

export const BATCH_PLAN_DISPATCHER_TASK_NAME = 'batch_plan.dispatcher';

/** docs/05 §3 audit_log.action 列挙 — cron 起動の batch_plan kick。 */
export const AUDIT_ACTION_BATCH_PLAN_CRON_KICK = 'batch_plan.cron_kick';

/** kickoff payload の task identifier (graphile-worker addJob 用)。 */
const PIPELINE_BOOK_KICKOFF_TASK_NAME = 'pipeline.book.kickoff';

/** `helpers.addJob` の最小 I/F — テスト時は mock を差し込む。 */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Prisma 部分 I/F (テストで mock しやすいよう最小サブセット)
// ---------------------------------------------------------------------------

export interface BatchPlanDispatcherPrisma {
  batchPlan: {
    findMany: (args: {
      where: { status: string; planned_at: { lte: Date } };
      select: { id: true };
      orderBy?: { planned_at: 'asc' | 'desc' };
    }) => Promise<Array<{ id: string }>>;
    update: (args: {
      where: { id: string };
      data: { status?: string; kicked_at?: Date };
    }) => Promise<unknown>;
  };
  batchPlanItem: {
    findMany: (args: {
      where: { batch_id: string; status: string };
      select: {
        id: true;
        theme_id: true;
        override_model_assignments_json: true;
      };
    }) => Promise<
      Array<{
        id: string;
        theme_id: string | null;
        override_model_assignments_json: unknown;
      }>
    >;
    update: (args: {
      where: { id: string };
      data: { status: string };
    }) => Promise<unknown>;
  };
  themeCandidate: {
    findMany: (args: {
      where: { id: { in: string[] } };
      select: { id: true; account_id: true };
    }) => Promise<Array<{ id: string; account_id: string }>>;
  };
  job: {
    create: (args: {
      data: {
        kind: string;
        status: string;
        payload_json: Prisma.InputJsonValue;
      };
    }) => Promise<{ id: string }>;
  };
  auditLog: {
    create: (args: {
      data: {
        actor_id: string | null;
        action: string;
        target_kind: string;
        target_id: string;
        before_json: Prisma.InputJsonValue;
        after_json: Prisma.InputJsonValue;
      };
    }) => Promise<unknown>;
  };
}

export interface BatchPlanDispatcherDeps {
  prisma?: BatchPlanDispatcherPrisma;
  /** graphile-worker `helpers.addJob`。テストでは mock。 */
  addJob?: AddJobLike;
  logger?: Logger;
  now?: () => Date;
}

export interface BatchPlanDispatcherResult {
  /** 対象として fetch された BatchPlan 件数。 */
  scannedPlans: number;
  /** 正常 dispatch 完了した BatchPlan 件数 (= status='running' 遷移成功)。 */
  dispatchedPlans: number;
  /** 全 plan 合計 — 実際に kicked 化した BatchPlanItem 件数。 */
  kickedItems: number;
}

// ---------------------------------------------------------------------------
// dispatchSinglePlan: 1 plan に対する一括 kick
// ---------------------------------------------------------------------------

interface DispatchSinglePlanArgs {
  planId: string;
  prisma: BatchPlanDispatcherPrisma;
  addJob: AddJobLike;
  log: Logger;
  now: Date;
}

interface DispatchSinglePlanResult {
  kickedCount: number;
  failedItemCount: number;
}

async function dispatchSinglePlan(
  args: DispatchSinglePlanArgs,
): Promise<DispatchSinglePlanResult> {
  const { planId, prisma, addJob, log, now } = args;

  // 1. pending BatchPlanItem fetch (kicked は idempotent skip)
  const items = await prisma.batchPlanItem.findMany({
    where: { batch_id: planId, status: 'pending' },
    select: {
      id: true,
      theme_id: true,
      override_model_assignments_json: true,
    },
  });
  if (items.length === 0) {
    log.info(
      { task: BATCH_PLAN_DISPATCHER_TASK_NAME, planId },
      'no pending items — marking plan as done (already kicked or empty)',
    );
  }

  // 2. theme_id → account_id を一括 fetch (各 item の payload に必要)
  const themeIds = items
    .map((i) => i.theme_id)
    .filter((id): id is string => id !== null);
  const themes =
    themeIds.length > 0
      ? await prisma.themeCandidate.findMany({
          where: { id: { in: themeIds } },
          select: { id: true, account_id: true },
        })
      : [];
  const accountByTheme = new Map(themes.map((t) => [t.id, t.account_id]));

  // 3. per-item: Job INSERT → addJob enqueue → BatchPlanItem.status='kicked'
  //    1 item の失敗で他 item は継続 (失敗 item は pending のまま残し次 tick で再試行)
  let kickedCount = 0;
  let failedItemCount = 0;
  const jobIds: string[] = [];

  for (const item of items) {
    if (!item.theme_id) {
      log.warn(
        { task: BATCH_PLAN_DISPATCHER_TASK_NAME, planId, batchPlanItemId: item.id },
        'BatchPlanItem.theme_id is null — skipping',
      );
      failedItemCount++;
      continue;
    }
    const accountId = accountByTheme.get(item.theme_id);
    if (!accountId) {
      log.warn(
        {
          task: BATCH_PLAN_DISPATCHER_TASK_NAME,
          planId,
          batchPlanItemId: item.id,
          themeId: item.theme_id,
        },
        'theme referenced by BatchPlanItem not found — skipping',
      );
      failedItemCount++;
      continue;
    }

    const override = item.override_model_assignments_json;
    const hasOverride =
      override !== null && override !== undefined && typeof override === 'object';
    const overrideJson = hasOverride
      ? (override as Prisma.InputJsonValue)
      : null;

    try {
      // 3-a. Job INSERT (kind='pipeline.book.kickoff', status='queued')
      const created = await prisma.job.create({
        data: {
          kind: PIPELINE_BOOK_KICKOFF_TASK_NAME,
          status: 'queued',
          payload_json: {
            theme_id: item.theme_id,
            account_id: accountId,
            batch_plan_item_id: item.id,
            ...(overrideJson !== null
              ? { model_assignment_overrides: overrideJson }
              : {}),
          } as Prisma.InputJsonValue,
        },
      });

      // 3-b. addJob — payload に job_id を含めて kickoff worker タスクへ
      const enqPayload = {
        theme_id: item.theme_id,
        account_id: accountId,
        batch_plan_item_id: item.id,
        job_id: created.id,
        ...(overrideJson !== null
          ? { model_assignment_overrides: overrideJson }
          : {}),
      };
      await addJob(PIPELINE_BOOK_KICKOFF_TASK_NAME, enqPayload);

      // 3-c. BatchPlanItem.status='kicked' (per-item で即更新; 1 item 失敗が他に波及しない)
      await prisma.batchPlanItem.update({
        where: { id: item.id },
        data: { status: 'kicked' },
      });

      jobIds.push(created.id);
      kickedCount++;
    } catch (itemErr) {
      // この item は pending のまま残し、次 tick の再試行に委ねる
      log.warn(
        {
          task: BATCH_PLAN_DISPATCHER_TASK_NAME,
          planId,
          batchPlanItemId: item.id,
          themeId: item.theme_id,
          err: itemErr,
        },
        'failed to dispatch BatchPlanItem — leaving as pending for next tick',
      );
      failedItemCount++;
      // 1 件失敗で plan 全体を諦めると、kicked 化済 item の整合性が崩れるため continue
    }
  }

  // 4. BatchPlan.status='done' (= dispatch 完了) + kicked_at + audit_log
  //    dispatcher の責務は「本を kick off する」ことなので、全 pending item を
  //    kick したら plan は完了扱い ('done')。以降の各書籍の進捗は書籍ごとの
  //    pipeline (kickoff→…→export) で管理する。旧実装は 'running' のままにして
  //    いたため、バッチが永遠に「実行中」に見える不具合になっていた。
  //    全 item 失敗の場合 (kickedCount=0 && items.length>0) は status を変えず次 tick で再試行。
  if (kickedCount > 0 || items.length === 0) {
    await prisma.batchPlan.update({
      where: { id: planId },
      data: { status: 'done', kicked_at: now },
    });

    await prisma.auditLog.create({
      data: {
        actor_id: null, // cron 起動 = システム実行
        action: AUDIT_ACTION_BATCH_PLAN_CRON_KICK,
        target_kind: 'batch_plan',
        target_id: planId,
        before_json: {
          batch_id: planId,
          status: 'scheduled',
        } as Prisma.InputJsonValue,
        after_json: {
          batch_id: planId,
          status: 'done',
          kicked_at: now.toISOString(),
          kicked_count: kickedCount,
          failed_item_count: failedItemCount,
          job_ids: jobIds,
        } as Prisma.InputJsonValue,
      },
    });
  } else {
    log.warn(
      {
        task: BATCH_PLAN_DISPATCHER_TASK_NAME,
        planId,
        itemCount: items.length,
        failedItemCount,
      },
      'all items failed to dispatch — leaving plan as scheduled for next tick',
    );
  }

  return { kickedCount, failedItemCount };
}

// ---------------------------------------------------------------------------
// runBatchPlanDispatcher: テストから直接呼べる純粋ヘルパ
// ---------------------------------------------------------------------------

export async function runBatchPlanDispatcher(
  deps: BatchPlanDispatcherDeps = {},
): Promise<BatchPlanDispatcherResult> {
  const log =
    deps.logger ?? createLogger(`worker.${BATCH_PLAN_DISPATCHER_TASK_NAME}`);
  const prisma =
    deps.prisma ?? (defaultPrisma as unknown as BatchPlanDispatcherPrisma);
  const addJob = deps.addJob;
  if (!addJob) {
    // Task 本体 (pipelineBookKickoffTask) からは helpers.addJob を渡す。
    // 単体テストで省略した場合は明示的に no-op で動作させたいが、本番経路で
    // 渡し忘れると enqueue が無音化するため、最低でも warn + throw を出す。
    throw new Error(
      `${BATCH_PLAN_DISPATCHER_TASK_NAME}: addJob must be provided (got undefined)`,
    );
  }
  const now = deps.now?.() ?? new Date();

  log.info({ task: BATCH_PLAN_DISPATCHER_TASK_NAME, now: now.toISOString() }, 'dispatcher tick start');

  // 1. 対象 BatchPlan を一括 fetch
  const plans = await prisma.batchPlan.findMany({
    where: { status: 'scheduled', planned_at: { lte: now } },
    select: { id: true },
    orderBy: { planned_at: 'asc' },
  });

  if (plans.length === 0) {
    log.info(
      { task: BATCH_PLAN_DISPATCHER_TASK_NAME, scannedPlans: 0 },
      'no scheduled plans due — dispatcher tick done',
    );
    return { scannedPlans: 0, dispatchedPlans: 0, kickedItems: 0 };
  }

  let dispatchedPlans = 0;
  let kickedItems = 0;

  for (const plan of plans) {
    try {
      const r = await dispatchSinglePlan({
        planId: plan.id,
        prisma,
        addJob,
        log,
        now,
      });
      // 1 件でも kicked 化したら、または items が空 (= 既に全部 kicked) で plan を進めた場合
      if (r.kickedCount > 0 || r.failedItemCount === 0) {
        dispatchedPlans++;
      }
      kickedItems += r.kickedCount;
    } catch (planErr) {
      // 1 plan 失敗 → 他 plan は継続
      log.warn(
        { task: BATCH_PLAN_DISPATCHER_TASK_NAME, planId: plan.id, err: planErr },
        'plan dispatch failed — continuing with other plans',
      );
      // この plan は status='scheduled' のまま残し、次 tick で再試行
    }
  }

  log.info(
    {
      task: BATCH_PLAN_DISPATCHER_TASK_NAME,
      scannedPlans: plans.length,
      dispatchedPlans,
      kickedItems,
    },
    'dispatcher tick done',
  );

  return {
    scannedPlans: plans.length,
    dispatchedPlans,
    kickedItems,
  };
}

// ---------------------------------------------------------------------------
// graphile-worker Task 本体 (薄ラッパ)
// ---------------------------------------------------------------------------

export const batchPlanDispatcherTask: Task = async (
  _payload: unknown,
  helpers: JobHelpers,
) => {
  // helpers.addJob は graphile-worker 0.16 の型では Promise<unknown> 互換。
  // 型互換性のため AddJobLike にキャストする。
  await runBatchPlanDispatcher({
    addJob: helpers.addJob as unknown as AddJobLike,
  });
};

