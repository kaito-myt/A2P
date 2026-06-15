/**
 * E2E: S-024 コスト詳細ダッシュボード (T-07-05).
 *
 * 検証ケース:
 *   1. ページ表示 — /cost に遷移 -> KPI ストリップ + PredictionAlertStrip が表示
 *   2. TopCostBooksTable — token_usage データがある場合に高コスト書籍テーブルが表示
 *   3. 空状態 — token_usage がない場合の表示
 *   4. CSV エクスポート — CSV ダウンロードボタンが存在する
 *   5. BreakdownTables タブ切替 — プロバイダ/モデル/役割タブの切替え動作
 *   6. DailyCostTable — 日別コストテーブルが表示
 *
 * 注:
 *  - 外部 LLM/API は呼ばない (表示系のみの検証)。
 *  - dev server (Next.js port 3001) は既に稼働中前提。
 *  - Postgres は Docker a2p-pg port 5433。
 *
 * 仕様根拠:
 *  - docs/02 F-033, F-035, F-036
 *  - docs/04 S-024
 *  - docs/sprints/SP-07 T-07-05
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-s024-cost';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeedContext {
  accountId: string;
  themeId: string;
  bookId: string;
  bookTitle: string;
}

/**
 * Delete rows created by this spec (identified by pen_name prefix).
 */
async function cleanupTestData(): Promise<void> {
  const accounts = await prisma.account.findMany({
    where: { pen_name: { startsWith: TEST_PEN_PREFIX } },
    select: { id: true },
  });
  if (accounts.length === 0) return;
  const accountIds = accounts.map((a) => a.id);

  const books = await prisma.book.findMany({
    where: { account_id: { in: accountIds } },
    select: { id: true },
  });
  const bookIds = books.map((b) => b.id);

  if (bookIds.length > 0) {
    await prisma.tokenUsage
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
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

/**
 * 1 Account + 1 ThemeCandidate + 1 Book.
 */
async function seedBase(label: string): Promise<SeedContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${label}-${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['cost_management'],
      } as unknown as Prisma.InputJsonValue,
      status: 'archived',
    },
    select: { id: true },
  });

  const theme = await prisma.themeCandidate.create({
    data: {
      account_id: account.id,
      theme_session_id: `${TEST_PEN_PREFIX}-${label}-session-${Date.now()}`,
      genre: 'business',
      title: `T-07-05 ${label} テスト用テーマ`,
      hook: 'e2e cost test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const bookTitle = `T-07-05 ${label} テスト書籍`;
  const book = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: bookTitle,
      status: 'running',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    bookTitle,
  };
}

/**
 * Insert token_usage rows for the current month (so that the dashboard page
 * picks them up). Returns the created_at date used.
 */
async function seedTokenUsage(bookId: string): Promise<void> {
  const now = new Date();
  // Use a date within the current month
  const today = new Date(now.getFullYear(), now.getMonth(), Math.min(now.getDate(), 28));

  await prisma.tokenUsage.createMany({
    data: [
      {
        book_id: bookId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        role: 'writer',
        input_tokens: 20000,
        output_tokens: 12000,
        cached_input_tokens: 3000,
        image_count: 0,
        unit_price_snapshot: {
          input_per_mtok_usd: 3.0,
          output_per_mtok_usd: 15.0,
          fx_rate_usd_jpy: 155.0,
        } as unknown as Prisma.InputJsonValue,
        cost_jpy: 37.2,
        created_at: today,
      },
      {
        book_id: bookId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        role: 'editor',
        input_tokens: 15000,
        output_tokens: 8000,
        cached_input_tokens: 2000,
        image_count: 0,
        unit_price_snapshot: {
          input_per_mtok_usd: 3.0,
          output_per_mtok_usd: 15.0,
          fx_rate_usd_jpy: 155.0,
        } as unknown as Prisma.InputJsonValue,
        cost_jpy: 24.6,
        created_at: today,
      },
      {
        book_id: bookId,
        provider: 'openai',
        model: 'gpt-image-1',
        role: 'thumbnail_image',
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        image_count: 2,
        unit_price_snapshot: {
          image_per_image_usd: 0.04,
          fx_rate_usd_jpy: 155.0,
        } as unknown as Prisma.InputJsonValue,
        cost_jpy: 12.4,
        created_at: today,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('S-024: コスト詳細ダッシュボード (T-07-05)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupTestData();
  });

  test.afterAll(async () => {
    await cleanupTestData();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. ページ表示 (with data) — KPI stripe + PredictionAlertStrip
  // -------------------------------------------------------------------------
  test('1. /cost ページに遷移すると KPI ストリップと予測アラートが表示される', async ({
    page,
  }) => {
    // Seed a book with token_usage for the current month
    const ctx = await seedBase('kpi');
    await seedTokenUsage(ctx.bookId);

    await page.goto('/cost');
    await expect(page.getByTestId('cost-dashboard-page')).toBeVisible();

    // CostDashboardShell should be present (not empty state)
    await expect(page.getByTestId('cost-dashboard-shell')).toBeVisible();

    // KPI stripe should display all 5 KPIs
    await expect(page.getByTestId('cost-kpi-stripe')).toBeVisible();
    await expect(page.getByTestId('cost-kpi-actual')).toBeVisible();
    await expect(page.getByTestId('cost-kpi-forecast')).toBeVisible();
    await expect(page.getByTestId('cost-kpi-remaining')).toBeVisible();
    await expect(page.getByTestId('cost-kpi-ratio')).toBeVisible();
    await expect(page.getByTestId('cost-kpi-per-book')).toBeVisible();

    // Actual KPI should show a yen value (non-zero)
    const actualText = await page.getByTestId('cost-kpi-actual').textContent();
    expect(actualText).toContain('¥'); // yen sign

    // PredictionAlertStrip should be visible
    await expect(page.getByTestId('prediction-alert-strip')).toBeVisible();
    await expect(page.getByTestId('prediction-status')).toBeVisible();
    await expect(page.getByTestId('prediction-bar')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 2. TopCostBooksTable — token_usage データがある場合
  // -------------------------------------------------------------------------
  test('2. token_usage データがある場合に高コスト書籍テーブルが表示される', async ({
    page,
  }) => {
    const ctx = await seedBase('top-books');
    await seedTokenUsage(ctx.bookId);

    await page.goto('/cost');
    await expect(page.getByTestId('cost-dashboard-page')).toBeVisible();
    await expect(page.getByTestId('cost-dashboard-shell')).toBeVisible();

    // TopCostBooksTable should be visible (not empty)
    await expect(page.getByTestId('top-cost-books-table')).toBeVisible();

    // Table should contain the seeded book title
    const table = page.getByTestId('top-cost-books-table');
    await expect(table).toContainText(ctx.bookTitle);

    // Table headers should be present
    await expect(table).toContainText('タイトル');
    await expect(table).toContainText('コスト (円)');
  });

  // -------------------------------------------------------------------------
  // 3. 空状態 — token_usage がない場合
  // -------------------------------------------------------------------------
  test('3. token_usage データがない場合に空状態メッセージが表示される', async ({
    page,
  }) => {
    // Make sure there are no token_usage records at all for the current month
    // cleanupTransientData already ran in beforeAll, and we do not seed any data here.
    // However, previous tests may have left data. We clean up specifically.
    await cleanupTestData();

    await page.goto('/cost');
    await expect(page.getByTestId('cost-dashboard-page')).toBeVisible();

    // Empty state should be visible
    await expect(page.getByTestId('cost-empty-state')).toBeVisible();
    await expect(page.getByTestId('cost-empty-state')).toContainText(
      'コスト記録がありません',
    );

    // Dashboard shell should NOT be present in empty state
    await expect(page.getByTestId('cost-dashboard-shell')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 4. CSV エクスポート — ボタンの存在確認
  // -------------------------------------------------------------------------
  test('4. CSV エクスポートボタンが存在しクリック可能である', async ({
    page,
  }) => {
    const ctx = await seedBase('csv');
    await seedTokenUsage(ctx.bookId);

    await page.goto('/cost');
    await expect(page.getByTestId('cost-dashboard-page')).toBeVisible();
    await expect(page.getByTestId('cost-dashboard-shell')).toBeVisible();

    // CSV export button should be visible
    const csvButton = page.getByTestId('csv-export-button');
    await expect(csvButton).toBeVisible();
    await expect(csvButton).toBeEnabled();
    await expect(csvButton).toContainText('CSV エクスポート');
  });

  // -------------------------------------------------------------------------
  // 5. BreakdownTables タブ切替
  // -------------------------------------------------------------------------
  test('5. 切り口別コスト集計のタブ切替が動作する', async ({
    page,
  }) => {
    const ctx = await seedBase('breakdown');
    await seedTokenUsage(ctx.bookId);

    await page.goto('/cost');
    await expect(page.getByTestId('cost-dashboard-page')).toBeVisible();
    await expect(page.getByTestId('cost-dashboard-shell')).toBeVisible();

    const breakdownSection = page.getByTestId('breakdown-tables');
    await expect(breakdownSection).toBeVisible();

    // Default tab: provider
    const tablist = breakdownSection.getByRole('tablist');
    await expect(tablist).toBeVisible();

    // Provider tab should be active by default; table should show provider data
    await expect(breakdownSection).toContainText('anthropic');

    // Click the model tab
    const modelTab = tablist.getByRole('tab', { name: 'モデル別' });
    await modelTab.click();

    // Model data should appear
    await expect(breakdownSection).toContainText('claude-sonnet-4-20250514');

    // Click the role tab
    const roleTab = tablist.getByRole('tab', { name: '役割別' });
    await roleTab.click();

    // Role data should appear (localized)
    await expect(breakdownSection).toContainText('Writer');
  });

  // -------------------------------------------------------------------------
  // 6. DailyCostTable — 日別コストテーブル
  // -------------------------------------------------------------------------
  test('6. 日別コストテーブルが当月の token_usage データで表示される', async ({
    page,
  }) => {
    const ctx = await seedBase('daily');
    await seedTokenUsage(ctx.bookId);

    await page.goto('/cost');
    await expect(page.getByTestId('cost-dashboard-page')).toBeVisible();
    await expect(page.getByTestId('cost-dashboard-shell')).toBeVisible();

    // DailyCostTable should be visible
    const dailyTable = page.getByTestId('daily-cost-table');
    await expect(dailyTable).toBeVisible();

    // Table headers
    await expect(dailyTable).toContainText('日付');
    await expect(dailyTable).toContainText('プロバイダ');
    await expect(dailyTable).toContainText('コスト (円)');
    await expect(dailyTable).toContainText('呼出回数');

    // Should contain provider names from seeded data
    await expect(dailyTable).toContainText('anthropic');
  });
});
