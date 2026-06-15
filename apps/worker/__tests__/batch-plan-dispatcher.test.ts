import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@a2p/contracts/logger';

import {
  AUDIT_ACTION_BATCH_PLAN_CRON_KICK,
  BATCH_PLAN_DISPATCHER_TASK_NAME,
  runBatchPlanDispatcher,
  type AddJobLike,
  type BatchPlanDispatcherPrisma,
} from '../src/tasks/batch-plan-dispatcher.js';

// ---------------------------------------------------------------------------
// テスト用ファクトリ
// ---------------------------------------------------------------------------

function makeLogger() {
  const calls: Array<{
    level: 'info' | 'warn' | 'error';
    obj: Record<string, unknown>;
    msg: string;
  }> = [];
  const mk =
    (level: 'info' | 'warn' | 'error') =>
    (obj: Record<string, unknown>, msg?: string) => {
      calls.push({ level, obj, msg: msg ?? '' });
    };
  const logger = {
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  return { logger, calls };
}

interface PlanRecord {
  id: string;
  status: string;
  planned_at: Date;
}

interface ItemRecord {
  id: string;
  batch_id: string;
  theme_id: string | null;
  status: string;
  override_model_assignments_json: unknown;
}

interface ThemeRecord {
  id: string;
  account_id: string;
}

interface JobRecord {
  id: string;
  kind: string;
  status: string;
  payload_json: unknown;
}

interface AuditLogRecord {
  actor_id: string | null;
  action: string;
  target_kind: string;
  target_id: string;
  before_json: unknown;
  after_json: unknown;
}

interface PrismaCaptures {
  planFindMany: Array<{ where: unknown; select?: unknown; orderBy?: unknown }>;
  planUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  itemFindMany: Array<{ where: unknown; select?: unknown }>;
  itemUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  themeFindMany: Array<{ where: unknown; select?: unknown }>;
  jobCreates: Array<{ data: Record<string, unknown> }>;
  auditLogCreates: AuditLogRecord[];
  addJobCalls: Array<{ identifier: string; payload: unknown }>;
}

interface BuildPrismaArgs {
  plans: PlanRecord[];
  items: ItemRecord[];
  themes: ThemeRecord[];
  /** job.create を強制失敗させるための item_id ホワイトリスト。 */
  jobCreateThrowForItemIds?: Set<string>;
  /** addJob を強制失敗させるための item_id ホワイトリスト。 */
  addJobThrowForItemIds?: Set<string>;
  /** plan.update を強制失敗させるための plan_id (1 plan の dispatch を失敗扱いにする検証用)。 */
  planUpdateThrowForPlanId?: string;
  /** Job.id seed (省略時 'job_seq')。 */
  jobIdSeed?: string;
}

function buildPrismaAndAddJob(args: BuildPrismaArgs): {
  prisma: BatchPlanDispatcherPrisma;
  addJob: AddJobLike;
  captures: PrismaCaptures;
  jobs: JobRecord[];
  items: ItemRecord[];
  plans: PlanRecord[];
} {
  const captures: PrismaCaptures = {
    planFindMany: [],
    planUpdates: [],
    itemFindMany: [],
    itemUpdates: [],
    themeFindMany: [],
    jobCreates: [],
    auditLogCreates: [],
    addJobCalls: [],
  };
  const plans = [...args.plans];
  const items = [...args.items];
  const themes = [...args.themes];
  const jobs: JobRecord[] = [];
  const jobSeed = args.jobIdSeed ?? 'job_seq';
  let jobCounter = 0;
  const jobIdByItem = new Map<string, string>();

  const prisma: BatchPlanDispatcherPrisma = {
    batchPlan: {
      findMany: async ({ where, select, orderBy }) => {
        captures.planFindMany.push({ where, select, orderBy });
        const filtered = plans.filter(
          (p) =>
            p.status === where.status &&
            p.planned_at.getTime() <= where.planned_at.lte.getTime(),
        );
        // orderBy planned_at asc を反映
        filtered.sort((a, b) => a.planned_at.getTime() - b.planned_at.getTime());
        return filtered.map((p) => ({ id: p.id }));
      },
      update: async ({ where, data }) => {
        captures.planUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        if (args.planUpdateThrowForPlanId && where.id === args.planUpdateThrowForPlanId) {
          throw new Error('forced plan.update failure');
        }
        const p = plans.find((x) => x.id === where.id);
        if (p && typeof data.status === 'string') p.status = data.status;
        return {};
      },
    },
    batchPlanItem: {
      findMany: async ({ where, select }) => {
        captures.itemFindMany.push({ where, select });
        return items
          .filter(
            (i) => i.batch_id === where.batch_id && i.status === where.status,
          )
          .map((i) => ({
            id: i.id,
            theme_id: i.theme_id,
            override_model_assignments_json: i.override_model_assignments_json,
          }));
      },
      update: async ({ where, data }) => {
        captures.itemUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        const it = items.find((x) => x.id === where.id);
        if (it) it.status = data.status;
        return {};
      },
    },
    themeCandidate: {
      findMany: async ({ where, select }) => {
        captures.themeFindMany.push({ where, select });
        const ids = new Set(where.id.in);
        return themes
          .filter((t) => ids.has(t.id))
          .map((t) => ({ id: t.id, account_id: t.account_id }));
      },
    },
    job: {
      create: async ({ data }) => {
        captures.jobCreates.push({
          data: data as unknown as Record<string, unknown>,
        });
        // payload_json.batch_plan_item_id でホワイトリスト判定
        const payload = data.payload_json as { batch_plan_item_id?: string };
        const itemId = payload?.batch_plan_item_id;
        if (
          itemId &&
          args.jobCreateThrowForItemIds?.has(itemId)
        ) {
          throw new Error(`forced job.create failure for item=${itemId}`);
        }
        jobCounter += 1;
        const id = `${jobSeed}_${jobCounter}`;
        const rec: JobRecord = {
          id,
          kind: data.kind,
          status: data.status,
          payload_json: data.payload_json,
        };
        jobs.push(rec);
        if (itemId) jobIdByItem.set(itemId, id);
        return { id };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        captures.auditLogCreates.push({
          actor_id: data.actor_id,
          action: data.action,
          target_kind: data.target_kind,
          target_id: data.target_id,
          before_json: data.before_json,
          after_json: data.after_json,
        });
        return {};
      },
    },
  };

  const addJob: AddJobLike = async (identifier, payload) => {
    captures.addJobCalls.push({ identifier, payload });
    const p = payload as { batch_plan_item_id?: string };
    const itemId = p?.batch_plan_item_id;
    if (itemId && args.addJobThrowForItemIds?.has(itemId)) {
      throw new Error(`forced addJob failure for item=${itemId}`);
    }
    return jobIdByItem.get(itemId ?? '') ?? 'graphile_job_stub';
  };

  return { prisma, addJob, captures, jobs, items, plans };
}

// ---------------------------------------------------------------------------
// テストケース
// ---------------------------------------------------------------------------

describe('batch_plan.dispatcher task', () => {
  const NOW = new Date('2026-05-24T03:00:00Z');

  it('task identifier が docs/05 §5.4 と一致する', () => {
    expect(BATCH_PLAN_DISPATCHER_TASK_NAME).toBe('batch_plan.dispatcher');
  });

  // -------------------------------------------------------------------------
  // 1. 対象 plan なし
  // -------------------------------------------------------------------------
  it('対象 plan が 0 件なら dispatchedPlans=0 で何もしない', async () => {
    const { prisma, addJob, captures } = buildPrismaAndAddJob({
      plans: [], // 0 件
      items: [],
      themes: [],
    });
    const { logger } = makeLogger();

    const result = await runBatchPlanDispatcher({
      prisma,
      addJob,
      logger,
      now: () => NOW,
    });

    expect(result.scannedPlans).toBe(0);
    expect(result.dispatchedPlans).toBe(0);
    expect(result.kickedItems).toBe(0);
    expect(captures.planFindMany).toHaveLength(1);
    // planFindMany 以外の DB 操作は走らない
    expect(captures.itemFindMany).toHaveLength(0);
    expect(captures.jobCreates).toHaveLength(0);
    expect(captures.addJobCalls).toHaveLength(0);
    expect(captures.planUpdates).toHaveLength(0);
    expect(captures.auditLogCreates).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. happy path: scheduled plan 1 件 + 3 pending items → 3 Job + 3 addJob + status 更新
  // -------------------------------------------------------------------------
  it('happy path: 1 plan + 3 pending items → 3 Job INSERT + 3 addJob + plan.status=running + audit_log', async () => {
    const { prisma, addJob, captures } = buildPrismaAndAddJob({
      plans: [
        {
          id: 'plan_1',
          status: 'scheduled',
          planned_at: new Date('2026-05-24T02:59:00Z'),
        },
      ],
      items: [
        {
          id: 'item_1',
          batch_id: 'plan_1',
          theme_id: 'theme_1',
          status: 'pending',
          override_model_assignments_json: null,
        },
        {
          id: 'item_2',
          batch_id: 'plan_1',
          theme_id: 'theme_2',
          status: 'pending',
          override_model_assignments_json: {
            writer: { provider: 'anthropic', model: 'claude-opus-4-7' },
          },
        },
        {
          id: 'item_3',
          batch_id: 'plan_1',
          theme_id: 'theme_3',
          status: 'pending',
          override_model_assignments_json: null,
        },
      ],
      themes: [
        { id: 'theme_1', account_id: 'acc_1' },
        { id: 'theme_2', account_id: 'acc_1' },
        { id: 'theme_3', account_id: 'acc_2' },
      ],
    });
    const { logger } = makeLogger();

    const result = await runBatchPlanDispatcher({
      prisma,
      addJob,
      logger,
      now: () => NOW,
    });

    expect(result.scannedPlans).toBe(1);
    expect(result.dispatchedPlans).toBe(1);
    expect(result.kickedItems).toBe(3);

    // 3 Job INSERT
    expect(captures.jobCreates).toHaveLength(3);
    for (const j of captures.jobCreates) {
      expect(j.data.kind).toBe('pipeline.book.kickoff');
      expect(j.data.status).toBe('queued');
    }

    // 3 addJob
    expect(captures.addJobCalls).toHaveLength(3);
    for (const c of captures.addJobCalls) {
      expect(c.identifier).toBe('pipeline.book.kickoff');
      const p = c.payload as Record<string, unknown>;
      expect(typeof p.theme_id).toBe('string');
      expect(typeof p.account_id).toBe('string');
      expect(typeof p.batch_plan_item_id).toBe('string');
      expect(typeof p.job_id).toBe('string');
    }

    // override 持ち item は payload に model_assignment_overrides を含む
    const overridePayload = captures.addJobCalls.find(
      (c) => (c.payload as { batch_plan_item_id?: string }).batch_plan_item_id === 'item_2',
    );
    expect(overridePayload).toBeDefined();
    const op = overridePayload!.payload as Record<string, unknown>;
    expect(op.model_assignment_overrides).toBeDefined();
    expect((op.model_assignment_overrides as { writer?: unknown }).writer).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });

    // 非 override item は payload に model_assignment_overrides を含まない
    const noOverridePayload = captures.addJobCalls.find(
      (c) => (c.payload as { batch_plan_item_id?: string }).batch_plan_item_id === 'item_1',
    );
    expect(noOverridePayload).toBeDefined();
    const nop = noOverridePayload!.payload as Record<string, unknown>;
    expect('model_assignment_overrides' in nop).toBe(false);

    // 3 BatchPlanItem.status='kicked'
    expect(captures.itemUpdates).toHaveLength(3);
    for (const u of captures.itemUpdates) {
      expect(u.data.status).toBe('kicked');
    }

    // BatchPlan.status='running' + kicked_at
    expect(captures.planUpdates).toHaveLength(1);
    expect(captures.planUpdates[0]!.where.id).toBe('plan_1');
    expect(captures.planUpdates[0]!.data.status).toBe('running');
    expect(captures.planUpdates[0]!.data.kicked_at).toEqual(NOW);

    // audit_log 1 件 (action='batch_plan.cron_kick', actor_id=null)
    expect(captures.auditLogCreates).toHaveLength(1);
    const al = captures.auditLogCreates[0]!;
    expect(al.actor_id).toBeNull();
    expect(al.action).toBe(AUDIT_ACTION_BATCH_PLAN_CRON_KICK);
    expect(al.target_kind).toBe('batch_plan');
    expect(al.target_id).toBe('plan_1');
    const after = al.after_json as Record<string, unknown>;
    expect(after.batch_id).toBe('plan_1');
    expect(after.status).toBe('running');
    expect(after.kicked_count).toBe(3);
    expect(after.failed_item_count).toBe(0);
    expect((after.job_ids as string[]).length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 3. planned_at が未来の plan は対象外
  // -------------------------------------------------------------------------
  it('planned_at が未来の scheduled plan は対象外 (findMany フィルタで除外)', async () => {
    const { prisma, addJob, captures } = buildPrismaAndAddJob({
      plans: [
        {
          id: 'plan_future',
          status: 'scheduled',
          // NOW より 1 時間後
          planned_at: new Date(NOW.getTime() + 60 * 60 * 1000),
        },
        {
          id: 'plan_past',
          status: 'scheduled',
          planned_at: new Date(NOW.getTime() - 60 * 60 * 1000),
        },
      ],
      items: [
        {
          id: 'item_past',
          batch_id: 'plan_past',
          theme_id: 'theme_x',
          status: 'pending',
          override_model_assignments_json: null,
        },
      ],
      themes: [{ id: 'theme_x', account_id: 'acc_x' }],
    });
    const { logger } = makeLogger();

    const result = await runBatchPlanDispatcher({
      prisma,
      addJob,
      logger,
      now: () => NOW,
    });

    expect(result.scannedPlans).toBe(1); // 過去 plan のみ
    expect(result.dispatchedPlans).toBe(1);
    expect(result.kickedItems).toBe(1);
    // 未来 plan は触られない
    expect(
      captures.planUpdates.find((u) => u.where.id === 'plan_future'),
    ).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 4. 既に kicked の item は skip (T-03-09 申し送り — idempotent ガード)
  // -------------------------------------------------------------------------
  it('既に kicked の BatchPlanItem は skip (idempotent ガード — T-03-09 申し送り)', async () => {
    const { prisma, addJob, captures } = buildPrismaAndAddJob({
      plans: [
        {
          id: 'plan_2',
          status: 'scheduled',
          planned_at: new Date(NOW.getTime() - 60_000),
        },
      ],
      items: [
        // 既に kicked: dispatcher は触らない
        {
          id: 'item_already_kicked',
          batch_id: 'plan_2',
          theme_id: 'theme_a',
          status: 'kicked',
          override_model_assignments_json: null,
        },
      ],
      themes: [{ id: 'theme_a', account_id: 'acc_a' }],
    });
    const { logger } = makeLogger();

    const result = await runBatchPlanDispatcher({
      prisma,
      addJob,
      logger,
      now: () => NOW,
    });

    // plan は scanned されるが、pending item が 0 → kickedCount=0 だが
    // items.length===0 のため plan は running に進む (空 plan を放置しない)
    expect(result.scannedPlans).toBe(1);
    expect(result.kickedItems).toBe(0);
    expect(result.dispatchedPlans).toBe(1);
    expect(captures.jobCreates).toHaveLength(0);
    expect(captures.addJobCalls).toHaveLength(0);
    // BatchPlanItem.update は呼ばれない
    expect(captures.itemUpdates).toHaveLength(0);
    // plan は status='running' に遷移
    expect(captures.planUpdates).toHaveLength(1);
    expect(captures.planUpdates[0]!.data.status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // 5. mixed status: 一部 pending + 一部 kicked → pending のみ kick
  // -------------------------------------------------------------------------
  it('mixed status: pending と kicked が混在 → pending のみ kick (kicked は skip)', async () => {
    const { prisma, addJob, captures } = buildPrismaAndAddJob({
      plans: [
        {
          id: 'plan_3',
          status: 'scheduled',
          planned_at: new Date(NOW.getTime() - 60_000),
        },
      ],
      items: [
        {
          id: 'item_pending_a',
          batch_id: 'plan_3',
          theme_id: 'theme_a',
          status: 'pending',
          override_model_assignments_json: null,
        },
        {
          id: 'item_kicked_b',
          batch_id: 'plan_3',
          theme_id: 'theme_b',
          status: 'kicked',
          override_model_assignments_json: null,
        },
        {
          id: 'item_pending_c',
          batch_id: 'plan_3',
          theme_id: 'theme_c',
          status: 'pending',
          override_model_assignments_json: null,
        },
      ],
      themes: [
        { id: 'theme_a', account_id: 'acc_x' },
        { id: 'theme_b', account_id: 'acc_x' },
        { id: 'theme_c', account_id: 'acc_x' },
      ],
    });
    const { logger } = makeLogger();

    const result = await runBatchPlanDispatcher({
      prisma,
      addJob,
      logger,
      now: () => NOW,
    });

    expect(result.kickedItems).toBe(2);
    expect(captures.jobCreates).toHaveLength(2);
    expect(captures.addJobCalls).toHaveLength(2);
    const kickedItemIds = captures.itemUpdates.map((u) => u.where.id).sort();
    expect(kickedItemIds).toEqual(['item_pending_a', 'item_pending_c']);
    // kicked item の id は touched されない
    expect(kickedItemIds).not.toContain('item_kicked_b');
  });

  // -------------------------------------------------------------------------
  // 6. 複数 plan: 1 plan 失敗で他 plan は継続
  // -------------------------------------------------------------------------
  it('複数 plan: 1 plan が plan.update 失敗 → 他 plan は dispatch 継続', async () => {
    const { prisma, addJob, captures } = buildPrismaAndAddJob({
      plans: [
        {
          id: 'plan_ok',
          status: 'scheduled',
          planned_at: new Date(NOW.getTime() - 120_000),
        },
        {
          id: 'plan_fail',
          status: 'scheduled',
          planned_at: new Date(NOW.getTime() - 60_000),
        },
      ],
      items: [
        {
          id: 'item_ok',
          batch_id: 'plan_ok',
          theme_id: 'theme_ok',
          status: 'pending',
          override_model_assignments_json: null,
        },
        {
          id: 'item_fail',
          batch_id: 'plan_fail',
          theme_id: 'theme_fail',
          status: 'pending',
          override_model_assignments_json: null,
        },
      ],
      themes: [
        { id: 'theme_ok', account_id: 'acc_x' },
        { id: 'theme_fail', account_id: 'acc_x' },
      ],
      // plan_fail の plan.update を強制失敗 → dispatchSinglePlan が throw
      planUpdateThrowForPlanId: 'plan_fail',
    });
    const { logger } = makeLogger();

    const result = await runBatchPlanDispatcher({
      prisma,
      addJob,
      logger,
      now: () => NOW,
    });

    expect(result.scannedPlans).toBe(2);
    // plan_ok は dispatch 成功
    expect(result.dispatchedPlans).toBe(1);
    // plan_ok の item は kicked、plan_fail の item は (plan.update 直前まで) Job INSERT + addJob は完了済
    expect(result.kickedItems).toBeGreaterThanOrEqual(1);
    // 少なくとも plan_ok の audit_log は INSERT されている
    const okAudit = captures.auditLogCreates.find((a) => a.target_id === 'plan_ok');
    expect(okAudit).toBeDefined();
    expect(okAudit!.action).toBe(AUDIT_ACTION_BATCH_PLAN_CRON_KICK);
    // plan_fail の audit_log は INSERT されていない (plan.update が先に失敗)
    const failAudit = captures.auditLogCreates.find((a) => a.target_id === 'plan_fail');
    expect(failAudit).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 7. enqueueJob 失敗: 3 items のうち 2 件目が addJob 失敗 → 1 件目は kicked、
  //    2 件目は pending のまま、3 件目は正常 kick (programmer 判断: 失敗 item を skip して他 item は継続)
  // -------------------------------------------------------------------------
  it('enqueueJob (addJob) 失敗: 3 items のうち 2 件目が失敗 → 1 件目・3 件目は kicked、2 件目は pending のまま', async () => {
    const { prisma, addJob, captures } = buildPrismaAndAddJob({
      plans: [
        {
          id: 'plan_partial',
          status: 'scheduled',
          planned_at: new Date(NOW.getTime() - 60_000),
        },
      ],
      items: [
        {
          id: 'item_a',
          batch_id: 'plan_partial',
          theme_id: 'theme_a',
          status: 'pending',
          override_model_assignments_json: null,
        },
        {
          id: 'item_b_fail',
          batch_id: 'plan_partial',
          theme_id: 'theme_b',
          status: 'pending',
          override_model_assignments_json: null,
        },
        {
          id: 'item_c',
          batch_id: 'plan_partial',
          theme_id: 'theme_c',
          status: 'pending',
          override_model_assignments_json: null,
        },
      ],
      themes: [
        { id: 'theme_a', account_id: 'acc_x' },
        { id: 'theme_b', account_id: 'acc_x' },
        { id: 'theme_c', account_id: 'acc_x' },
      ],
      addJobThrowForItemIds: new Set(['item_b_fail']),
    });
    const { logger } = makeLogger();

    const result = await runBatchPlanDispatcher({
      prisma,
      addJob,
      logger,
      now: () => NOW,
    });

    expect(result.kickedItems).toBe(2); // item_a + item_c
    // BatchPlanItem.update は kicked 化した 2 件のみ (item_b_fail は触られない)
    const kickedItemIds = captures.itemUpdates.map((u) => u.where.id).sort();
    expect(kickedItemIds).toEqual(['item_a', 'item_c']);
    // plan は running に進む (1 件以上 kicked 化済)
    expect(captures.planUpdates).toHaveLength(1);
    expect(captures.planUpdates[0]!.data.status).toBe('running');
    // audit_log の failed_item_count=1
    expect(captures.auditLogCreates).toHaveLength(1);
    const al = captures.auditLogCreates[0]!.after_json as Record<string, unknown>;
    expect(al.kicked_count).toBe(2);
    expect(al.failed_item_count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 8. 全 item 失敗 → plan は scheduled のまま残す (次 tick で再試行)
  // -------------------------------------------------------------------------
  it('全 item が addJob 失敗 → plan は status=scheduled のまま (次 tick で再試行)', async () => {
    const { prisma, addJob, captures } = buildPrismaAndAddJob({
      plans: [
        {
          id: 'plan_all_fail',
          status: 'scheduled',
          planned_at: new Date(NOW.getTime() - 60_000),
        },
      ],
      items: [
        {
          id: 'item_x',
          batch_id: 'plan_all_fail',
          theme_id: 'theme_x',
          status: 'pending',
          override_model_assignments_json: null,
        },
      ],
      themes: [{ id: 'theme_x', account_id: 'acc_x' }],
      addJobThrowForItemIds: new Set(['item_x']),
    });
    const { logger } = makeLogger();

    const result = await runBatchPlanDispatcher({
      prisma,
      addJob,
      logger,
      now: () => NOW,
    });

    expect(result.kickedItems).toBe(0);
    expect(result.dispatchedPlans).toBe(0);
    // plan.update は呼ばれない (= status=scheduled のまま)
    expect(captures.planUpdates).toHaveLength(0);
    // audit_log も INSERT されない
    expect(captures.auditLogCreates).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 9. addJob 未注入 → throw (本番経路で渡し忘れ防止)
  // -------------------------------------------------------------------------
  it('addJob を渡さずに呼ぶと throw (本番経路で渡し忘れを防ぐ安全装置)', async () => {
    const { prisma } = buildPrismaAndAddJob({
      plans: [],
      items: [],
      themes: [],
    });
    const { logger } = makeLogger();
    await expect(
      runBatchPlanDispatcher({
        prisma,
        logger,
        now: () => NOW,
        // addJob 省略
      }),
    ).rejects.toThrow(/addJob must be provided/);
  });
});
