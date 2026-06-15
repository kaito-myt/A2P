/**
 * Runtime verification spec for T-03-10 — batch_plan.dispatcher
 * (F-021: 夜間バッチ計画 cron — `planned_at` 到来 plan を自動 kick)
 *
 * SP-03 段階では batch_plan.dispatcher を触る UI 画面 (BatchPlan の cron 起動済
 * 一覧等) は無いため、通常の Playwright (ブラウザ操作 → DOM 検証) では
 * docs/05 §5.4 / F-021 セマンティクスを検証できない。代わりに以下を Node
 * ランタイム上で実 PostgreSQL + mock addJob に対して直接呼び出して検証する:
 *
 *   1. 過去 planned_at + pending items → 全 item kick, Job + audit_log INSERT
 *   2. 未来 planned_at plan は不変 (findMany フィルタで除外)
 *   3. 冪等性: 同 dispatcher を 2 回連続呼出 → 2 回目は dispatchedPlans=0
 *   4. Worker 登録確認: buildTaskList() 22 件 + buildParsedCronItems() 5 件
 *
 * mock addJob を使うため:
 *   - graphile-worker のジョブテーブル (graphile_worker.jobs) には書き込まれない
 *   - 実外部 API は一切呼ばれない
 *   - コスト ゼロ、ネットワーク 不要 (DB は localhost:5433)
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner
 *     として借用し、@a2p/db / apps/worker のタスクを直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (DATABASE_URL) が前提。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import {
  AUDIT_ACTION_BATCH_PLAN_CRON_KICK,
  BATCH_PLAN_DISPATCHER_TASK_NAME,
  runBatchPlanDispatcher,
  type AddJobLike,
} from '../../apps/worker/src/tasks/batch-plan-dispatcher.js';
import {
  buildTaskList,
} from '../../apps/worker/src/runner.js';
import {
  buildParsedCronItems,
  CRON_ITEMS,
} from '../../apps/worker/src/crontab.js';

// テスト用ペンネーム prefix — cleanup の判定 key
const TEST_ACCOUNT_PEN = 'e2e-batch-dispatcher-acc';
const TEST_THEME_SESSION = 'e2e-batch-dispatcher-session';
const TEST_JOB_KIND = 'pipeline.book.kickoff';
/**
 * 本テスト由来 BatchPlan を識別するためのマーカ値。
 * `BatchPlan` には任意の string カラムが無いため、`predicted_cost_jpy` を本値に固定して
 * cleanup の判定 key とする (実運用の plan は予測コスト > 0 なので衝突しにくい)。
 * さらに `deadline` も MARKER_DEADLINE に固定して 2 重ガードする。
 */
const TEST_PLAN_MARKER_DEADLINE = new Date('2099-01-01T00:00:00.000Z');

interface Seeded {
  accountId: string;
  themeIds: string[];
  pastPlanId: string;
  futurePlanId: string;
  pastItemIds: string[];
}

async function cleanupTestRows(): Promise<void> {
  // 1) 本テスト由来 BatchPlan を marker (deadline=2099-01-01) で全件特定
  //    — 過去 run で afterAll が走らなかったゴミ plan も一緒に掃除する
  const markedPlans = await prisma.batchPlan.findMany({
    where: { deadline: TEST_PLAN_MARKER_DEADLINE },
    select: { id: true },
  });
  const markedPlanIds = markedPlans.map((p) => p.id);

  if (markedPlanIds.length > 0) {
    // 2) その plan 配下の BatchPlanItem id を集め、対応する Job を削除
    const items = await prisma.batchPlanItem.findMany({
      where: { batch_id: { in: markedPlanIds } },
      select: { id: true },
    });
    for (const it of items) {
      await prisma.job
        .deleteMany({
          where: {
            kind: TEST_JOB_KIND,
            payload_json: { path: ['batch_plan_item_id'], equals: it.id },
          },
        })
        .catch(() => undefined);
    }

    // 3) audit_log: target_kind='batch_plan' AND action='batch_plan.cron_kick'
    //    AND target_id ∈ markedPlanIds
    await prisma.auditLog
      .deleteMany({
        where: {
          target_kind: 'batch_plan',
          action: AUDIT_ACTION_BATCH_PLAN_CRON_KICK,
          target_id: { in: markedPlanIds },
        },
      })
      .catch(() => undefined);

    // 4) BatchPlan を削除 (cascade で BatchPlanItem も削除される)
    await prisma.batchPlan.deleteMany({ where: { id: { in: markedPlanIds } } });
  }

  // 5) テスト用 ThemeCandidate / Account を削除 (account を消せば
  //    ThemeCandidate は cascade 削除される)
  await prisma.account
    .deleteMany({ where: { pen_name: { startsWith: TEST_ACCOUNT_PEN } } })
    .catch(() => undefined);
}

async function seedFixtures(now: Date): Promise<Seeded> {
  // 一時 Account (genre_policy_json は最小)
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_ACCOUNT_PEN}-${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'practical',
        ratio: { practical: 1 },
        focus_themes: [],
      },
    },
    select: { id: true },
  });

  // 3 件 ThemeCandidate (status='accepted')
  const themeIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await prisma.themeCandidate.create({
      data: {
        account_id: account.id,
        theme_session_id: TEST_THEME_SESSION,
        genre: 'practical',
        title: `e2e batch dispatcher theme ${i + 1}`,
        hook: 'e2e test hook',
        competitors_json: [],
        signals_json: { sources: [] },
        status: 'accepted',
        decided_at: now,
      },
      select: { id: true },
    });
    themeIds.push(t.id);
  }

  // 1 件 BatchPlan (scheduled, planned_at=過去 5 分前) + 3 BatchPlanItem(pending)
  // deadline をマーカ値 (2099-01-01) に固定して cleanup 識別 key にする。
  const pastPlan = await prisma.batchPlan.create({
    data: {
      planned_at: new Date(now.getTime() - 5 * 60 * 1000),
      concurrency: 3,
      predicted_cost_jpy: 0,
      status: 'scheduled',
      deadline: TEST_PLAN_MARKER_DEADLINE,
    },
    select: { id: true },
  });

  const pastItemIds: string[] = [];
  for (const themeId of themeIds) {
    const item = await prisma.batchPlanItem.create({
      data: {
        batch_id: pastPlan.id,
        theme_id: themeId,
        status: 'pending',
      },
      select: { id: true },
    });
    pastItemIds.push(item.id);
  }

  // 1 件 BatchPlan (scheduled, planned_at=未来 +1h) — 対象外確認用
  // deadline をマーカ値に固定して cleanup 識別 key にする。
  const futurePlan = await prisma.batchPlan.create({
    data: {
      planned_at: new Date(now.getTime() + 60 * 60 * 1000),
      concurrency: 1,
      predicted_cost_jpy: 0,
      status: 'scheduled',
      deadline: TEST_PLAN_MARKER_DEADLINE,
    },
    select: { id: true },
  });
  // future plan は item を持たない (status=scheduled のまま不変であることだけ確認)

  return {
    accountId: account.id,
    themeIds,
    pastPlanId: pastPlan.id,
    futurePlanId: futurePlan.id,
    pastItemIds,
  };
}

test.describe('runtime: batch_plan.dispatcher (T-03-10 / F-021)', () => {
  // 実 DB I/O のみ (mock addJob) — 60s で十分
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. happy path: 過去 plan + 3 pending items → 全 item kick + Job INSERT
  //                + audit_log INSERT。未来 plan は不変。
  //    冪等性: 同 dispatcher を 2 回呼ぶ → 2 回目は dispatchedPlans=0
  // -------------------------------------------------------------------------
  test('happy path + 未来 plan 不変 + 冪等性', async () => {
    const NOW = new Date();
    const seeded = await seedFixtures(NOW);

    // mock addJob: graphile-worker キューには書かず、呼出ログだけ取る
    const addJobCalls: Array<{ identifier: string; payload: unknown }> = [];
    const addJob: AddJobLike = async (identifier, payload) => {
      addJobCalls.push({ identifier, payload });
      return { id: 'mock-graphile-job-id' };
    };

    // ----- 1 回目 -----
    const result1 = await runBatchPlanDispatcher({
      addJob,
      now: () => NOW,
    });

    // 戻り値: 過去 plan 1 件のみ scanned/dispatched
    expect(result1.scannedPlans).toBe(1);
    expect(result1.dispatchedPlans).toBe(1);
    expect(result1.kickedItems).toBe(3);

    // addJob は 3 回呼ばれ (1 plan × 3 pending item)、全て pipeline.book.kickoff
    expect(addJobCalls.length).toBe(3);
    for (const c of addJobCalls) {
      expect(c.identifier).toBe(TEST_JOB_KIND);
      const p = c.payload as Record<string, unknown>;
      expect(typeof p.theme_id).toBe('string');
      expect(p.account_id).toBe(seeded.accountId);
      expect(typeof p.batch_plan_item_id).toBe('string');
      expect(typeof p.job_id).toBe('string');
    }
    // 全 pastItemId が payload.batch_plan_item_id に出現
    const enqItemIds = new Set(
      addJobCalls.map(
        (c) => (c.payload as { batch_plan_item_id: string }).batch_plan_item_id,
      ),
    );
    for (const id of seeded.pastItemIds) {
      expect(enqItemIds.has(id)).toBe(true);
    }

    // DB: 過去 plan は status='running' + kicked_at != null
    const pastPlan = await prisma.batchPlan.findUnique({
      where: { id: seeded.pastPlanId },
    });
    expect(pastPlan).not.toBeNull();
    expect(pastPlan!.status).toBe('running');
    expect(pastPlan!.kicked_at).not.toBeNull();

    // DB: 3 件 BatchPlanItem は全て status='kicked'
    const pastItems = await prisma.batchPlanItem.findMany({
      where: { batch_id: seeded.pastPlanId },
    });
    expect(pastItems.length).toBe(3);
    for (const it of pastItems) {
      expect(it.status).toBe('kicked');
    }

    // DB: Job 3 件 INSERT (kind=pipeline.book.kickoff, status=queued,
    //     payload に theme_id/account_id/batch_plan_item_id)
    const jobs = await prisma.job.findMany({
      where: {
        kind: TEST_JOB_KIND,
        OR: seeded.pastItemIds.map((id) => ({
          payload_json: { path: ['batch_plan_item_id'], equals: id },
        })),
      },
    });
    expect(jobs.length).toBe(3);
    for (const j of jobs) {
      expect(j.kind).toBe(TEST_JOB_KIND);
      expect(j.status).toBe('queued');
      const payload = j.payload_json as Record<string, unknown>;
      expect(payload.account_id).toBe(seeded.accountId);
      expect(seeded.themeIds).toContain(payload.theme_id);
      expect(seeded.pastItemIds).toContain(payload.batch_plan_item_id);
    }

    // DB: 未来 plan は status='scheduled' のまま
    const futurePlan = await prisma.batchPlan.findUnique({
      where: { id: seeded.futurePlanId },
    });
    expect(futurePlan).not.toBeNull();
    expect(futurePlan!.status).toBe('scheduled');
    expect(futurePlan!.kicked_at).toBeNull();

    // DB: audit_log 1 件 (action='batch_plan.cron_kick', actor_id=null,
    //     target_kind='batch_plan', target_id=pastPlanId)
    const auditRows = await prisma.auditLog.findMany({
      where: {
        action: AUDIT_ACTION_BATCH_PLAN_CRON_KICK,
        target_kind: 'batch_plan',
        target_id: seeded.pastPlanId,
      },
    });
    expect(auditRows.length).toBe(1);
    const audit = auditRows[0]!;
    expect(audit.actor_id).toBeNull();
    expect(audit.action).toBe(AUDIT_ACTION_BATCH_PLAN_CRON_KICK);
    const after = audit.after_json as Record<string, unknown>;
    expect(after.batch_id).toBe(seeded.pastPlanId);
    expect(after.status).toBe('running');
    expect(after.kicked_count).toBe(3);
    expect(after.failed_item_count).toBe(0);
    expect((after.job_ids as string[]).length).toBe(3);

    // ----- 2 回目 (冪等性) -----
    // 過去 plan は既に status='running' に遷移済なので scheduled の findMany に該当しない
    const addJobCalls2: Array<{ identifier: string; payload: unknown }> = [];
    const addJob2: AddJobLike = async (identifier, payload) => {
      addJobCalls2.push({ identifier, payload });
      return { id: 'mock-graphile-job-id-2' };
    };
    const result2 = await runBatchPlanDispatcher({
      addJob: addJob2,
      now: () => NOW, // 同じ now なので未来 plan も依然対象外
    });

    expect(result2.scannedPlans).toBe(0);
    expect(result2.dispatchedPlans).toBe(0);
    expect(result2.kickedItems).toBe(0);
    expect(addJobCalls2.length).toBe(0); // 2 回目は addJob 呼ばれない

    // Job 行は増えていない (依然 3 件のみ)
    const jobsAfter = await prisma.job.findMany({
      where: {
        kind: TEST_JOB_KIND,
        OR: seeded.pastItemIds.map((id) => ({
          payload_json: { path: ['batch_plan_item_id'], equals: id },
        })),
      },
    });
    expect(jobsAfter.length).toBe(3);

    // audit_log も増えていない (依然 1 件のみ)
    const auditAfter = await prisma.auditLog.findMany({
      where: {
        action: AUDIT_ACTION_BATCH_PLAN_CRON_KICK,
        target_kind: 'batch_plan',
        target_id: seeded.pastPlanId,
      },
    });
    expect(auditAfter.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Worker 登録確認: buildTaskList / buildParsedCronItems
  // -------------------------------------------------------------------------
  test('worker: buildTaskList に batch_plan.dispatcher を含む 23 タスクが登録されている', () => {
    const tasks = buildTaskList();
    const taskNames = Object.keys(tasks);
    // 23 件: docs/05 §2 の 19 件 + locks.sweep [SP-02 T-02-07] +
    // pipeline.theme.generate [SP-03 T-03-06] + batch_plan.dispatcher [SP-03 T-03-10] +
    // pipeline.book.writer.chapters.dispatch [SP-04 T-04-05]
    expect(taskNames.length).toBe(23);
    expect(taskNames).toContain(BATCH_PLAN_DISPATCHER_TASK_NAME);
    expect(taskNames).toContain('pipeline.book.writer.chapters.dispatch');
    expect(BATCH_PLAN_DISPATCHER_TASK_NAME).toBe('batch_plan.dispatcher');
  });

  test('worker: buildParsedCronItems に batch-plan-dispatcher-minute を含む 6 件の cron が登録されている', () => {
    const parsed = buildParsedCronItems();
    // SP-09 T-09-04 で archive-jobs-weekly が追加され 6 件
    //   (T-07-11 で standalone locks-sweep-hourly は削除済み)。
    expect(parsed.length).toBe(6);

    const identifiers = CRON_ITEMS.map((c) => c.identifier);
    expect(identifiers).toEqual(
      expect.arrayContaining([
        'archive-db-backup-weekly',
        'fx-fetch-daily',
        'catalog-fetch-daily',
        'batch-plan-dispatcher-minute',
        'alert-cost-check-hourly',
        'archive-jobs-weekly',
      ]),
    );

    const dispatcher = CRON_ITEMS.find(
      (c) => c.identifier === 'batch-plan-dispatcher-minute',
    );
    expect(dispatcher).toBeDefined();
    expect(dispatcher!.task).toBe(BATCH_PLAN_DISPATCHER_TASK_NAME);
    expect(dispatcher!.match).toBe('* * * * *'); // 毎分
  });
});
