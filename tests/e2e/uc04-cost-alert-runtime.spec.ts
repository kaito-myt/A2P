/**
 * E2E Runtime: UC-04 段階的アラート発火ロジック — runAlertCostCheck 実行 (T-09-06)
 *
 * 本 spec は `page` を使わない Node ランタイム上での DB テスト。
 * 既存の global.setup.ts による UI ログイン認証は不要。
 * Playwright を test runner として借用し、実 DB に対して直接 runAlertCostCheck を呼ぶ。
 *
 * 仕様:
 *   - 450 円段階: アラート発火なし / cost_status='normal'
 *   - 500 円段階: warn alert 発火 / cost_status='warn'
 *   - 750 円段階: pause alert 発火 / cost_status='paused' / status='paused_cost' / Job キャンセル
 *   - 冪等性: 750 円で再度 check → alert 増加なし
 *   - 時系列: warn → pause の発火順序確認
 *
 * コスト: ゼロ (DB のみ、LLM/外部 API 呼出なし)
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';
import {
  runAlertCostCheck,
  type AlertCostCheckDeps,
  type AlertCostCheckPrisma,
} from '../../apps/worker/src/tasks/alert-cost-check.js';

const TEST_PEN_PREFIX = 'e2e-uc04-cost-alert-runtime';

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupTestRows(): Promise<void> {
  const accounts = await prisma.account.findMany({
    where: { pen_name: { startsWith: TEST_PEN_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return;

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
      // Alert: book_id ごとに個別削除
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
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface UC04SeedContext {
  accountId: string;
  bookId: string;
}

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
      title: `UC-04 runtime ${label} テーマ`,
      hook: 'cost alert runtime test',
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
      title: `UC-04 runtime ${label} テスト書籍`,
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
  };
}

async function seedTokenUsageForBook(
  bookId: string,
  totalCostJpy: number,
): Promise<void> {
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

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('E2E Runtime: UC-04 段階的アラート発火ロジック — runAlertCostCheck (T-09-06)', () => {
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

    // Seed token_usage: 合計 500 円
    await seedTokenUsageForBook(seeded.bookId, 450);
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
    const storedCost = payload.total_cost_jpy
      ? Number(payload.total_cost_jpy)
      : 0;
    expect(storedCost).toBeCloseTo(500, 0);

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

    // Verify cost sum
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
