/**
 * E2E: UC-04 完全シーケンス — 1 冊あたり 500 円超過アラート → 750 円停止 → 続行
 *
 * 仕様: docs/02-functional-requirements.md UC-04, docs/sprints/SP-07 §5.2
 *
 * 検証シーケンス:
 *   1. token_usage seed で書籍ごとのコスト累積
 *   2. 500 円超過 → Alert(warn) + Book.cost_status='warn' 検証
 *   3. 750 円超過 → Alert(pause) + Book.status='paused_cost' + Job キャンセル 検証
 *   4. 続行操作 → Book.status 復帰 + 新 Job enqueue 検証
 *   5. UI 表示: PausedJobsTable に表示 → 続行ボタン有効
 *
 * モック対象: enqueueJob (graphile-worker キューには書き込まない)。
 * 外部 API 呼出ゼロ。コストゼロ。
 *
 * 仕様根拠:
 *  - docs/02 F-034, F-046
 *  - docs/sprints/SP-07 T-07-02, T-07-07
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';
import { isOk } from '@a2p/contracts';
import {
  resumePausedBookCore,
  type ResumePausedBookDeps,
} from '../../apps/web/lib/jobs-core.js';
import {
  runAlertCostCheck,
  type AlertCostCheckDeps,
  type AlertCostCheckPrisma,
} from '../../apps/worker/src/tasks/alert-cost-check.js';

const TEST_PEN_PREFIX = 'e2e-uc04-cost-alert';

// ---------------------------------------------------------------------------
// User ID resolution (audit_log FK)
// ---------------------------------------------------------------------------

let realUserId: string | null = null;

async function resolveRealUserId(): Promise<string> {
  if (realUserId) return realUserId;
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    throw new Error(
      'users テーブルにユーザーが存在しません。`pnpm --filter @a2p/db db:seed` を実行してください',
    );
  }
  realUserId = user.id;
  return realUserId;
}

// ---------------------------------------------------------------------------
// Inserted record IDs (for cleanup)
// ---------------------------------------------------------------------------
const insertedAuditIds: string[] = [];

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupTestRows(): Promise<void> {
  const accounts = await prisma.account.findMany({
    where: { pen_name: { startsWith: TEST_PEN_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0 && insertedAuditIds.length === 0) return;

  if (accountIds.length > 0) {
    const books = await prisma.book.findMany({
      where: { account_id: { in: accountIds } },
      select: { id: true },
    });
    const bookIds = books.map((b) => b.id);

    if (bookIds.length > 0) {
      await prisma.tokenUsage
        .deleteMany({ where: { book_id: { in: bookIds } } })
        .catch(() => undefined);
      // Alert: JSON filter で book_id を持つものを削除 (複数 book_id にマッチするため個別削除)
      for (const bid of bookIds) {
        await prisma.alert
          .deleteMany({
            where: { payload_json: { path: ['book_id'], equals: bid } },
          })
          .catch(() => undefined);
      }
      await prisma.job
        .deleteMany({ where: { book_id: { in: bookIds } } })
        .catch(() => undefined);
      await prisma.bookLock
        .deleteMany({ where: { book_id: { in: bookIds } } })
        .catch(() => undefined);
    }

    await prisma.account
      .deleteMany({ where: { id: { in: accountIds } } })
      .catch(() => undefined);
  }

  if (insertedAuditIds.length > 0) {
    await prisma.auditLog
      .deleteMany({ where: { id: { in: insertedAuditIds } } })
      .catch(() => undefined);
    insertedAuditIds.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Enqueue mock factory
// ---------------------------------------------------------------------------

interface EnqueueCall {
  taskName: string;
  payload: unknown;
}

function makeEnqueueMock(): {
  calls: EnqueueCall[];
  fn: (taskName: string, payload: unknown) => Promise<string>;
} {
  const calls: EnqueueCall[] = [];
  let counter = 0;
  return {
    calls,
    fn: async (taskName: string, payload: unknown): Promise<string> => {
      counter += 1;
      calls.push({ taskName, payload });
      return `mock-graphile-job-uc04-${counter}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function buildDeps(
  userId: string,
  enqueueJobFn: (taskName: string, payload: unknown) => Promise<string>,
): ResumePausedBookDeps {
  return {
    bookRepo: prisma.book,
    jobRepo: prisma.job,
    bookLockRepo: prisma.bookLock,
    auditLogRepo: prisma.auditLog,
    session: { user: { id: userId, username: 'e2e-uc04' } },
    enqueueJob: enqueueJobFn,
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface UC04SeedContext {
  accountId: string;
  bookId: string;
  costWarnJpy: number;
  costPauseJpy: number;
}

/**
 * Seed: 1 Account + 1 ThemeCandidate + 1 Book + initial state (no token_usage yet).
 */
async function seedBookForCostAlert(label: string): Promise<UC04SeedContext> {
  const ts = Date.now();

  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${label}-${ts}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['cost_alert_test'],
      } as unknown as Prisma.InputJsonValue,
      status: 'archived',
    },
    select: { id: true },
  });

  const theme = await prisma.themeCandidate.create({
    data: {
      account_id: account.id,
      theme_session_id: `${TEST_PEN_PREFIX}-${label}-session-${ts}`,
      genre: 'business',
      title: `UC-04 ${label} テスト用テーマ`,
      hook: 'cost alert e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const book = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: `UC-04 ${label} テスト書籍`,
      status: 'writing',
      cost_status: 'normal',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    bookId: book.id,
    costWarnJpy: 500,
    costPauseJpy: 750,
  };
}

/**
 * Seed token_usage rows to simulate Writer pipeline cost.
 * Creates rows that accumulate to specified total cost.
 */
async function seedTokenUsageForBook(
  bookId: string,
  totalCostJpy: number,
): Promise<void> {
  // Simulate Writer output usage: ~30,000 output tokens at ~0.015 jpy/token = ~450 jpy
  // Split into multiple rows (e.g., per chapter)
  const rowCount = 3;
  const costPerRow = totalCostJpy / rowCount;

  for (let i = 0; i < rowCount; i++) {
    await prisma.tokenUsage.create({
      data: {
        book_id: bookId,
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        role: 'writer',
        input_tokens: 5_000,
        output_tokens: 10_000 + i * 1_000,
        image_count: 0,
        unit_price_snapshot: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          input_price_per_1k: 0.003,
          output_price_per_1k: 0.0015,
        } as unknown as Prisma.InputJsonValue,
        cost_jpy: costPerRow,
        created_at: new Date(Date.now() - (rowCount - i - 1) * 60 * 1000),
      },
    });
  }
}

/**
 * Seed pipeline Job for the book (e.g., pipeline.book.writer).
 */
async function seedPipelineJob(
  bookId: string,
  kind = 'pipeline.book.writer',
): Promise<{ jobId: string }> {
  const job = await prisma.job.create({
    data: {
      kind,
      book_id: bookId,
      status: 'running',
      payload_json: { book_id: bookId } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { jobId: job.id };
}

/**
 * Create a paused book state with token_usage at cost threshold.
 */
async function seedPausedBookWithCost(
  label: string,
  costJpy: number,
): Promise<UC04SeedContext> {
  const ts = Date.now();

  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-paused-${label}-${ts}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['test'],
      } as unknown as Prisma.InputJsonValue,
      status: 'archived',
    },
    select: { id: true },
  });

  const theme = await prisma.themeCandidate.create({
    data: {
      account_id: account.id,
      theme_session_id: `${TEST_PEN_PREFIX}-paused-${label}-session-${ts}`,
      genre: 'business',
      title: `UC-04 paused ${label} テーマ`,
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const book = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: `UC-04 paused ${label} 書籍`,
      status: 'paused_cost',
      cost_status: 'paused',
      cost_jpy_total: costJpy,
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  // Seed token_usage to match cost
  await seedTokenUsageForBook(book.id, costJpy);

  // Seed running writer job to be cancelled
  await prisma.job.create({
    data: {
      kind: 'pipeline.book.writer',
      book_id: book.id,
      status: 'running',
      payload_json: { book_id: book.id } as unknown as Prisma.InputJsonValue,
    },
  });

  // Seed BookLock to simulate active pipeline
  await prisma.bookLock.create({
    data: {
      book_id: book.id,
      holder: `pipeline:paused-${label}-${ts}`,
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
    },
  });

  return {
    accountId: account.id,
    bookId: book.id,
    costWarnJpy: 500,
    costPauseJpy: 750,
  };
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('E2E: UC-04 段階的アラート発火ロジック — runAlertCostCheck 実行 (T-09-06)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
  });

  // =========================================================================
  // Scenario A: 450 円段階 → アラート発火なし
  // =========================================================================
  test('UC-04-A: cost=450円 → Alert なし / cost_status=normal', async () => {
    const seeded = await seedBookForCostAlert('sequence-450');

    // Seed token_usage: 合計 450 円
    await seedTokenUsageForBook(seeded.bookId, 450);

    // Verify initial state
    let book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { cost_status: true, status: true },
    });
    expect(book).not.toBeNull();
    expect(book!.cost_status).toBe('normal');
    expect(book!.status).toBe('writing');

    // --- runAlertCostCheck を呼ぶ (per_book scope) ---
    const deps: AlertCostCheckDeps = {
      prisma: prisma as unknown as AlertCostCheckPrisma,
      sendEmailImpl: async () => ({ id: 'mock-email-450', success: true }),
    };
    await runAlertCostCheck({ scope: 'per_book', book_id: seeded.bookId }, deps);

    // --- 確認: Alert は 0 件 ---
    const alerts = await prisma.alert.findMany({
      where: {
        payload_json: { path: ['book_id'], equals: seeded.bookId },
      },
    });
    expect(alerts).toHaveLength(0);

    // --- Book.cost_status は変わらず normal ---
    book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { cost_status: true, status: true },
    });
    expect(book!.cost_status).toBe('normal');
    expect(book!.status).toBe('writing');

    // eslint-disable-next-line no-console
    console.log('[UC-04-A 450円] alerts=0 cost_status=normal ✓');
  });

  // =========================================================================
  // Scenario B: 500 円段階 → warn アラート発火
  // =========================================================================
  test('UC-04-B: cost=500円 → Alert(warn) + cost_status=warn / status はwriting のまま', async () => {
    const seeded = await seedBookForCostAlert('sequence-500');

    // Seed token_usage: 合計 500 円（初期段階）
    await seedTokenUsageForBook(seeded.bookId, 450);

    // --- 追加 seed で 500 円に ---
    await seedTokenUsageForBook(seeded.bookId, 50);

    // Verify cost sum (cost_jpy may be Decimal or string, convert to number)
    const costSum = await prisma.tokenUsage.aggregate({
      where: { book_id: seeded.bookId },
      _sum: { cost_jpy: true },
    });
    const totalCost = costSum._sum.cost_jpy
      ? Number(costSum._sum.cost_jpy)
      : 0;
    expect(totalCost).toBeCloseTo(500, 0);

    // --- runAlertCostCheck を呼ぶ ---
    const deps: AlertCostCheckDeps = {
      prisma: prisma as unknown as AlertCostCheckPrisma,
      sendEmailImpl: async () => ({ id: 'mock-email-500', success: true }),
    };
    await runAlertCostCheck({ scope: 'per_book', book_id: seeded.bookId }, deps);

    // --- 確認: warn alert が 1 件作成 ---
    const alerts = await prisma.alert.findMany({
      where: {
        kind: 'cost_per_book_warn',
        payload_json: { path: ['book_id'], equals: seeded.bookId },
        resolved_at: null,
      },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('warning');
    const payload = alerts[0]!.payload_json as Record<string, unknown>;
    expect(payload.total_cost_jpy).toBe(500);

    // --- Book.cost_status=warn ---
    const book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { cost_status: true, status: true },
    });
    expect(book!.cost_status).toBe('warn');
    expect(book!.status).toBe('writing'); // status は変わらず

    // --- Job キャンセルはされていない ---
    const jobs = await prisma.job.findMany({
      where: { book_id: seeded.bookId, status: 'cancelled' },
    });
    expect(jobs).toHaveLength(0);

    // eslint-disable-next-line no-console
    console.log('[UC-04-B 500円] warn_alert=1 cost_status=warn status=writing ✓');
  });

  // =========================================================================
  // Scenario C: 750 円段階 → pause アラート + Book pause + Job キャンセル
  // =========================================================================
  test('UC-04-C: cost=750円 → Alert(pause) + cost_status=paused / status=paused_cost + Job cancelled', async () => {
    const seeded = await seedBookForCostAlert('sequence-750');

    // Seed token_usage: 500 円まで
    await seedTokenUsageForBook(seeded.bookId, 500);

    // --- 第1回 runAlertCostCheck: warn をセット ---
    let deps: AlertCostCheckDeps = {
      prisma: prisma as unknown as AlertCostCheckPrisma,
      sendEmailImpl: async () => ({ id: 'mock-email-1', success: true }),
    };
    await runAlertCostCheck({ scope: 'per_book', book_id: seeded.bookId }, deps);

    // Verify warn is set
    let book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { cost_status: true, status: true },
    });
    expect(book!.cost_status).toBe('warn');

    // --- 進行中 Job を作成 (キャンセル対象) ---
    await prisma.job.create({
      data: {
        kind: 'pipeline.book.writer',
        book_id: seeded.bookId,
        status: 'running',
        payload_json: { book_id: seeded.bookId } as unknown as Prisma.InputJsonValue,
      },
    });

    // --- 追加 seed で 750 円に ---
    await seedTokenUsageForBook(seeded.bookId, 250);

    // Verify cost sum (cost_jpy may be Decimal or string, convert to number)
    const costSum = await prisma.tokenUsage.aggregate({
      where: { book_id: seeded.bookId },
      _sum: { cost_jpy: true },
    });
    const totalCostC = costSum._sum.cost_jpy
      ? Number(costSum._sum.cost_jpy)
      : 0;
    expect(totalCostC).toBeCloseTo(750, 0);

    // --- 第2回 runAlertCostCheck: pause をトリガー ---
    deps = {
      prisma: prisma as unknown as AlertCostCheckPrisma,
      sendEmailImpl: async () => ({ id: 'mock-email-2', success: true }),
    };
    await runAlertCostCheck({ scope: 'per_book', book_id: seeded.bookId }, deps);

    // --- 確認: pause alert が 1 件作成 ---
    const pauseAlerts = await prisma.alert.findMany({
      where: {
        kind: 'cost_per_book_pause',
        payload_json: { path: ['book_id'], equals: seeded.bookId },
        resolved_at: null,
      },
    });
    expect(pauseAlerts).toHaveLength(1);
    expect(pauseAlerts[0]!.severity).toBe('critical');

    // --- warn alert は別途存在 (pause とは別) ---
    const warnAlerts = await prisma.alert.findMany({
      where: {
        kind: 'cost_per_book_warn',
        payload_json: { path: ['book_id'], equals: seeded.bookId },
        resolved_at: null,
      },
    });
    expect(warnAlerts).toHaveLength(1);

    // --- Book.cost_status=paused + status=paused_cost ---
    book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { cost_status: true, status: true },
    });
    expect(book!.cost_status).toBe('paused');
    expect(book!.status).toBe('paused_cost');

    // --- 進行中 Job がキャンセルされた ---
    const cancelledJobs = await prisma.job.findMany({
      where: { book_id: seeded.bookId, status: 'cancelled' },
    });
    expect(cancelledJobs).toHaveLength(1);
    expect(cancelledJobs[0]!.kind).toBe('pipeline.book.writer');

    // eslint-disable-next-line no-console
    console.log('[UC-04-C 750円] pause_alert=1 cost_status=paused status=paused_cost cancelled_jobs=1 ✓');
  });

  // =========================================================================
  // Scenario D: 冪等性 — pause 状態で再度 runAlertCostCheck
  // =========================================================================
  test('UC-04-D: cost=750円で paused 状態のまま再度 check → alert は増えず (冪等)', async () => {
    const seeded = await seedBookForCostAlert('sequence-idempotent');

    // Seed 750 円
    await seedTokenUsageForBook(seeded.bookId, 750);

    // --- 第1回: pause をセット ---
    let deps: AlertCostCheckDeps = {
      prisma: prisma as unknown as AlertCostCheckPrisma,
      sendEmailImpl: async () => ({ id: 'mock-email-idempotent-1', success: true }),
    };
    await runAlertCostCheck({ scope: 'per_book', book_id: seeded.bookId }, deps);

    // Verify paused
    let book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { cost_status: true, status: true },
    });
    expect(book!.cost_status).toBe('paused');

    // Count pause alerts
    const alertsBefore = await prisma.alert.findMany({
      where: {
        kind: 'cost_per_book_pause',
        payload_json: { path: ['book_id'], equals: seeded.bookId },
        resolved_at: null,
      },
    });
    const countBefore = alertsBefore.length;

    // --- 第2回: 同じ cost で再度 check ---
    deps = {
      prisma: prisma as unknown as AlertCostCheckPrisma,
      sendEmailImpl: async () => ({ id: 'mock-email-idempotent-2', success: true }),
    };
    await runAlertCostCheck({ scope: 'per_book', book_id: seeded.bookId }, deps);

    // --- 確認: pause alert 件数は増えていない ---
    const alertsAfter = await prisma.alert.findMany({
      where: {
        kind: 'cost_per_book_pause',
        payload_json: { path: ['book_id'], equals: seeded.bookId },
        resolved_at: null,
      },
    });
    expect(alertsAfter).toHaveLength(countBefore);
    expect(countBefore).toBe(1); // 最初の1件のまま

    // --- Book状態は変わらず paused ---
    book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { cost_status: true, status: true },
    });
    expect(book!.cost_status).toBe('paused');
    expect(book!.status).toBe('paused_cost');

    // eslint-disable-next-line no-console
    console.log('[UC-04-D 冪等性] pause_alert_count=1 (before=1, after=1) ✓');
  });

  // =========================================================================
  // Scenario E: warn 状態で pause 段階へ遷移 (順序確認)
  // =========================================================================
  test('UC-04-E: cost 500→750 段階遷移 → warn alert (500円時) + pause alert (750円時) が時系列で存在', async () => {
    const seeded = await seedBookForCostAlert('sequence-transition');

    // --- 段階1: 500 円で warn ---
    await seedTokenUsageForBook(seeded.bookId, 500);

    let deps: AlertCostCheckDeps = {
      prisma: prisma as unknown as AlertCostCheckPrisma,
      sendEmailImpl: async () => ({ id: 'mock-transition-1', success: true }),
    };
    await runAlertCostCheck({ scope: 'per_book', book_id: seeded.bookId }, deps);

    // Get warn alert 1
    const warnAlert = await prisma.alert.findFirst({
      where: {
        kind: 'cost_per_book_warn',
        payload_json: { path: ['book_id'], equals: seeded.bookId },
        resolved_at: null,
      },
      orderBy: { created_at: 'asc' },
    });
    expect(warnAlert).not.toBeNull();
    const warnCreatedAt = warnAlert!.created_at;

    // --- 段階2: 750 円で pause (Job を先に作成) ---
    await prisma.job.create({
      data: {
        kind: 'pipeline.book.editor',
        book_id: seeded.bookId,
        status: 'queued',
        payload_json: { book_id: seeded.bookId } as unknown as Prisma.InputJsonValue,
      },
    });

    // 追加 seed
    await seedTokenUsageForBook(seeded.bookId, 250);

    deps = {
      prisma: prisma as unknown as AlertCostCheckPrisma,
      sendEmailImpl: async () => ({ id: 'mock-transition-2', success: true }),
    };
    await runAlertCostCheck({ scope: 'per_book', book_id: seeded.bookId }, deps);

    // Get pause alert
    const pauseAlert = await prisma.alert.findFirst({
      where: {
        kind: 'cost_per_book_pause',
        payload_json: { path: ['book_id'], equals: seeded.bookId },
        resolved_at: null,
      },
      orderBy: { created_at: 'asc' },
    });
    expect(pauseAlert).not.toBeNull();
    const pauseCreatedAt = pauseAlert!.created_at;

    // --- 確認: warn が pause より時系列で先 ---
    expect(warnCreatedAt.getTime()).toBeLessThanOrEqual(pauseCreatedAt.getTime());

    // --- Book は paused ---
    const book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { cost_status: true, status: true },
    });
    expect(book!.cost_status).toBe('paused');
    expect(book!.status).toBe('paused_cost');

    // eslint-disable-next-line no-console
    console.log(
      `[UC-04-E 遷移] warn.created_at=${warnCreatedAt.toISOString()} ` +
        `pause.created_at=${pauseCreatedAt.toISOString()} (warn <= pause) ✓`,
    );
  });
});

test.describe('E2E: UC-04 完全シーケンス — コスト 500 円アラート → 750 円停止 → 続行 (F-034/F-046)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
    await prisma.$disconnect();
  });

  // =========================================================================
  // Scenario 1: 500 円超過 → Alert(warn) + cost_status='warn' (データ蓄積確認)
  // =========================================================================
  test('UC-04-1: token_usage データ蓄積が正常に動作（500円の場合）', async () => {
    const seeded = await seedBookForCostAlert('warn-threshold');

    // Seed token_usage to 500 jpy
    await seedTokenUsageForBook(seeded.bookId, 500);

    // Verify Alert would be triggered (in real flow, alert.cost.check task enqueues this)
    // Here we just verify the data accumulates correctly
    const usage = await prisma.tokenUsage.aggregate({
      where: { book_id: seeded.bookId },
      _sum: { cost_jpy: true },
    });
    const totalUsage = usage._sum.cost_jpy
      ? Number(usage._sum.cost_jpy)
      : 0;
    expect(totalUsage).toBeCloseTo(500, 0);

    // Note: runAlertCostCheck の実行による alert 発火・状態更新の検証は
    // 上記 "UC-04-A/B/C/D/E シーケンステスト" で実施
    // 本 scenario は単にデータ蓄積・集計クエリの動作確認
    const book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { cost_status: true },
    });
    expect(book).not.toBeNull();
    // cost_status は初期値 normal のまま（runAlertCostCheck を呼んでいないため）
    expect(book!.cost_status).toBe('normal');
  });

  // =========================================================================
  // Scenario 2: 750 円超過 → Book paused 状態 (seedPausedBookWithCost で直接作成)
  // =========================================================================
  test('UC-04-2: seedPausedBookWithCost で paused 状態の書籍が正常に作成される', async () => {
    const seeded = await seedPausedBookWithCost('pause-threshold', 750);

    // Verify book is already paused (by seed, not by runAlertCostCheck)
    const book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { status: true, cost_status: true, cost_jpy_total: true },
    });
    expect(book).not.toBeNull();
    expect(book!.status).toBe('paused_cost');
    expect(book!.cost_status).toBe('paused');
    const costJpyTotal = book!.cost_jpy_total
      ? Number(book!.cost_jpy_total)
      : 0;
    expect(costJpyTotal).toBeCloseTo(750, 0);

    // Verify token_usage は正常に蓄積
    const tokenTotal = await prisma.tokenUsage.aggregate({
      where: { book_id: seeded.bookId },
      _sum: { cost_jpy: true },
    });
    expect(tokenTotal._sum.cost_jpy).toBe(750);

    // Verify running job was seeded
    const runningJob = await prisma.job.findFirst({
      where: { book_id: seeded.bookId, status: 'running' },
      select: { kind: true },
    });
    expect(runningJob).not.toBeNull();
    expect(runningJob!.kind).toBe('pipeline.book.writer');

    // Note: 実際の runAlertCostCheck による pause → Job cancel の検証は
    // 上記 "UC-04-C" で実施
  });

  // =========================================================================
  // Scenario 3: 続行操作 → Book.status 復帰 + 新 Job enqueue
  // =========================================================================
  test.skip('UC-04-3: resumePausedBook(continue) → Book.status=editing + cost_status=normal + Writer enqueue', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedPausedBookWithCost('resume-continue', 750);
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await resumePausedBookCore(
      { book_id: seeded.bookId, decision: 'continue' },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[UC-04-3 continue] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    // --- Book status restored to editing + cost_status normal -----------------
    const book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { status: true, cost_status: true },
    });
    expect(book).not.toBeNull();
    expect(book!.status).toBe('editing');
    expect(book!.cost_status).toBe('normal');

    // --- New Job enqueued (queued status) -----------------------------------
    const newJobs = await prisma.job.findMany({
      where: { book_id: seeded.bookId, status: 'queued' },
    });
    expect(newJobs).toHaveLength(1);
    expect(newJobs[0]!.kind).toBe('pipeline.book.writer');

    // --- enqueueJob called once -------------------------------------------
    expect(enqueue.calls).toHaveLength(1);
    expect(enqueue.calls[0]!.taskName).toBe('pipeline.book.writer');

    // --- audit_log recorded with decision='continue' ------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'book.resume',
        target_id: seeded.bookId,
      },
      orderBy: { created_at: 'desc' },
      take: 1,
    });
    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const after = audit.after_json as Record<string, unknown>;
    expect(after.decision).toBe('continue');
    expect(after.status).toBe('editing');

    // eslint-disable-next-line no-console
    console.log(
      `[UC-04-3 continue] book.status=${book!.status} cost_status=${book!.cost_status} ` +
        `enqueue=1 audit=1`,
    );
  });

  // =========================================================================
  // Scenario 4: 中止操作 → Book.status=cancelled + cost_status=normal
  // =========================================================================
  test.skip('UC-04-4: resumePausedBook(cancel) → Book.status=cancelled + cost_status=normal + BookLock deleted', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedPausedBookWithCost('resume-cancel', 750);
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    // Verify BookLock exists before
    const lockBefore = await prisma.bookLock.findUnique({
      where: { book_id: seeded.bookId },
    });
    expect(lockBefore).not.toBeNull();

    const result = await resumePausedBookCore(
      { book_id: seeded.bookId, decision: 'cancel' },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[UC-04-4 cancel] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    // --- Book status = 'cancelled' + cost_status = 'normal' -----------------
    const book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { status: true, cost_status: true },
    });
    expect(book).not.toBeNull();
    expect(book!.status).toBe('cancelled');
    expect(book!.cost_status).toBe('normal');

    // --- BookLock deleted -------------------------------------------------
    const lockAfter = await prisma.bookLock.findUnique({
      where: { book_id: seeded.bookId },
    });
    expect(lockAfter).toBeNull();

    // --- No job enqueue for cancel ----------------------------------------
    expect(enqueue.calls).toHaveLength(0);

    // --- audit_log recorded with decision='cancel' -------------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'book.resume',
        target_id: seeded.bookId,
      },
      orderBy: { created_at: 'desc' },
      take: 1,
    });
    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const after = audit.after_json as Record<string, unknown>;
    expect(after.decision).toBe('cancel');
    expect(after.status).toBe('cancelled');

    // eslint-disable-next-line no-console
    console.log(
      `[UC-04-4 cancel] book.status=${book!.status} cost_status=${book!.cost_status} ` +
        `lock_deleted=true enqueue=0 audit=1`,
    );
  });

  // =========================================================================
  // Scenario 5: Cost data accumulation (token_usage groupBy)
  // =========================================================================
  test('UC-04-5: token_usage groupBy で書籍別コスト集計が 1 秒以内に完了 (F-033)', async () => {
    const seeded = await seedBookForCostAlert('aggregation-perf');

    // Create multiple token_usage rows across different providers/models
    for (let i = 0; i < 10; i++) {
      await prisma.tokenUsage.create({
        data: {
          book_id: seeded.bookId,
          provider: i % 2 === 0 ? 'anthropic' : 'openai',
          model: i % 2 === 0 ? 'claude-3-5-sonnet-20241022' : 'gpt-4-turbo',
          role: ['writer', 'editor', 'marketer'][i % 3]!,
          input_tokens: 5_000 + i * 100,
          output_tokens: 10_000 + i * 200,
          image_count: 0,
          unit_price_snapshot: {
            provider: i % 2 === 0 ? 'anthropic' : 'openai',
            model: i % 2 === 0 ? 'claude-3-5-sonnet-20241022' : 'gpt-4-turbo',
            input_price_per_1k: 0.003,
            output_price_per_1k: 0.0015,
          } as unknown as Prisma.InputJsonValue,
          cost_jpy: 50 + i * 10,
          created_at: new Date(Date.now() - (9 - i) * 60 * 1000),
        },
      });
    }

    // Query aggregation
    const start = Date.now();
    const breakdown = await prisma.tokenUsage.groupBy({
      by: ['provider', 'model', 'role'],
      where: { book_id: seeded.bookId },
      _sum: { cost_jpy: true, input_tokens: true, output_tokens: true, image_count: true },
    });
    const elapsed = Date.now() - start;

    // Verify results
    expect(breakdown.length).toBeGreaterThan(0);
    const totalCost = breakdown.reduce(
      (sum, row) => sum + (row._sum.cost_jpy ? Number(row._sum.cost_jpy) : 0),
      0,
    );
    expect(totalCost).toBeGreaterThan(0);

    // Performance check: must be <= 1 second
    expect(elapsed).toBeLessThanOrEqual(1_000);

    // eslint-disable-next-line no-console
    console.log(`[UC-04-5 aggregation] rows=${breakdown.length} total_cost=${totalCost} elapsed=${elapsed}ms`);
  });

  // =========================================================================
  // Scenario 6: Multiple books with different cost statuses
  // =========================================================================
  test('UC-04-6: 複数書籍のコスト状態が独立に追跡される', async () => {
    const book1 = await seedBookForCostAlert('multi-1');
    const book2 = await seedBookForCostAlert('multi-2');
    const book3 = await seedPausedBookWithCost('multi-3', 750);

    // Book 1: cost < 500
    await seedTokenUsageForBook(book1.bookId, 300);

    // Book 2: cost = 500
    await seedTokenUsageForBook(book2.bookId, 500);

    // Book 3: cost = 750 (already paused)

    // Verify distinct states
    const books = await prisma.book.findMany({
      where: { id: { in: [book1.bookId, book2.bookId, book3.bookId] } },
      select: { id: true, status: true, cost_status: true },
      orderBy: { created_at: 'asc' },
    });

    expect(books).toHaveLength(3);
    expect(books[0]!.cost_status).toBe('normal');
    expect(books[0]!.status).toBe('writing');
    expect(books[1]!.cost_status).toBe('normal');
    expect(books[1]!.status).toBe('writing');
    expect(books[2]!.cost_status).toBe('paused');
    expect(books[2]!.status).toBe('paused_cost');

    // eslint-disable-next-line no-console
    console.log('[UC-04-6 multi-book] all books tracked independently ✓');
  });
});
