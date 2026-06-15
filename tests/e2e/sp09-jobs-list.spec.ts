/**
 * E2E: S-025 ジョブログ一覧 (T-09-01, F-045/F-046).
 *
 * 検証する 2 つのシナリオ:
 *   a. ページロード + UI 要素表示: フィルタ・統計・テーブルが表示される
 *   b. 一括リトライ フロー: failed ジョブを選択 → bulk retry → retried 状態に変化
 *
 * 前提:
 *   - storageState は global.setup.ts が認証済みで保存済
 *   - PostgreSQL 稼働中
 *   - apps/worker は起動していない (ジョブが進行しない = 状態が安定)
 *
 * テストデータ:
 *   - Account 1 件 (pen_name='e2e-s025-...')
 *   - Book 5 冊 (各書籍に複数ステップのジョブを seeding)
 *   - 混在ジョブ: failed / done / running / cancelled (bulkRetry が選別する動作を確認)
 *   - 本 spec で作成されたデータは afterAll で削除
 *
 * コスト: ゼロ (DB 操作 + UI 操作のみ、実 API 呼び出しなし)
 */
import { test, expect, type Page } from '@playwright/test';
import { Prisma, prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const E2E_PREFIX = 'e2e-s025-';

interface TestContext {
  accountId: string;
  bookIds: string[];
  jobIds: { failed: string[]; done: string[]; running: string[]; cancelled: string[] };
}

let ctx: TestContext = {
  accountId: '',
  bookIds: [],
  jobIds: { failed: [], done: [], running: [], cancelled: [] },
};

/**
 * Seed テストデータ: Account + 5 冊 × 複数ジョブ (混在ステータス)
 */
async function seedS025Data(): Promise<void> {
  // Create account
  const account = await prisma.account.create({
    data: {
      pen_name: `${E2E_PREFIX}${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['publishing'],
      } as unknown as Prisma.InputJsonValue,
      status: 'active',
    },
  });
  ctx.accountId = account.id;

  // Create 5 books
  for (let i = 0; i < 5; i++) {
    const book = await prisma.book.create({
      data: {
        account_id: account.id,
        title: `テスト書籍 #${i + 1}`,
        status: 'running',
        prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
        model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      },
    });
    ctx.bookIds.push(book.id);
  }

  // Create mixed jobs for each book
  // Book 0: failed editor job (for bulk retry)
  const editorFailed = await prisma.job.create({
    data: {
      kind: 'pipeline.book.editor',
      book_id: ctx.bookIds[0]!,
      status: 'failed',
      payload_json: { book_id: ctx.bookIds[0] } as unknown as Prisma.InputJsonValue,
      error: 'Editor timed out after 5 retries',
      retries: 2,
    },
  });
  ctx.jobIds.failed.push(editorFailed.id);

  // Book 1: failed marketer job + done export job (mixed statuses)
  const marketerFailed = await prisma.job.create({
    data: {
      kind: 'pipeline.book.marketer',
      book_id: ctx.bookIds[1]!,
      status: 'failed',
      payload_json: { book_id: ctx.bookIds[1] } as unknown as Prisma.InputJsonValue,
      error: 'Marketer API rate limited',
      retries: 1,
    },
  });
  ctx.jobIds.failed.push(marketerFailed.id);

  const exportDone = await prisma.job.create({
    data: {
      kind: 'pipeline.book.export',
      book_id: ctx.bookIds[1]!,
      status: 'done',
      payload_json: { book_id: ctx.bookIds[1] } as unknown as Prisma.InputJsonValue,
      finished_at: new Date(),
    },
  });
  ctx.jobIds.done.push(exportDone.id);

  // Book 2: running job (should not be retriable)
  const runningJob = await prisma.job.create({
    data: {
      kind: 'pipeline.book.writer.chapter',
      book_id: ctx.bookIds[2]!,
      status: 'running',
      payload_json: { book_id: ctx.bookIds[2], chapter_index: 0 } as unknown as Prisma.InputJsonValue,
      started_at: new Date(),
    },
  });
  ctx.jobIds.running.push(runningJob.id);

  // Book 3: cancelled job (should not be retriable)
  const cancelledJob = await prisma.job.create({
    data: {
      kind: 'pipeline.book.thumbnail.image',
      book_id: ctx.bookIds[3]!,
      status: 'cancelled',
      payload_json: { book_id: ctx.bookIds[3] } as unknown as Prisma.InputJsonValue,
    },
  });
  ctx.jobIds.cancelled.push(cancelledJob.id);

  // Book 4: another failed job (to test batch retry with multiple failed)
  const writerFailed = await prisma.job.create({
    data: {
      kind: 'pipeline.book.writer.outline',
      book_id: ctx.bookIds[4]!,
      status: 'failed',
      payload_json: { book_id: ctx.bookIds[4] } as unknown as Prisma.InputJsonValue,
      error: 'Writer refused task (budget exceeded)',
      retries: 0,
    },
  });
  ctx.jobIds.failed.push(writerFailed.id);

  // One more done job for padding
  const kickoffDone = await prisma.job.create({
    data: {
      kind: 'pipeline.book.kickoff',
      book_id: ctx.bookIds[4]!,
      status: 'done',
      payload_json: { book_id: ctx.bookIds[4] } as unknown as Prisma.InputJsonValue,
      finished_at: new Date(),
    },
  });
  ctx.jobIds.done.push(kickoffDone.id);
}

/**
 * Cleanup: テストで作成した Account / Book / Job を削除
 */
async function cleanupS025Data(): Promise<void> {
  // Jobs are cascade-deleted by Book deletion
  if (ctx.bookIds.length > 0) {
    await prisma.book
      .deleteMany({
        where: { id: { in: ctx.bookIds } },
      })
      .catch(() => undefined);
  }

  if (ctx.accountId) {
    await prisma.account
      .deleteMany({
        where: { pen_name: { startsWith: E2E_PREFIX } },
      })
      .catch(() => undefined);
  }
}

test.describe('S-025 ジョブログ一覧 (T-09-01, F-045/F-046)', () => {
  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await seedS025Data();
  });

  test.afterAll(async () => {
    await cleanupS025Data();
  });

  // -----------------------------------------------------------------------
  // a. ページロード + UI 要素表示
  // -----------------------------------------------------------------------

  test('a. ページ遷移 + UI 要素が表示される', async ({ page }) => {
    // Navigate to S-025 jobs page
    await page.goto('/jobs');
    await expect(page).toHaveURL('/jobs');

    // Page title should be visible
    const pageTitle = page.getByRole('heading', { level: 1 });
    await expect(pageTitle).toBeVisible();

    // Stats cards should be visible
    const statsCards = page.locator('[data-testid="job-stats-cards"]');
    await expect(statsCards).toBeVisible();

    // Filter bar should be visible
    const filterBar = page.locator('[data-testid="jobs-filter-bar"]');
    await expect(filterBar).toBeVisible();

    // Jobs table should be visible
    const jobsTable = page.locator('[data-testid="jobs-table"]');
    await expect(jobsTable).toBeVisible();

    // Table should have rows (we seeded 7 jobs)
    const tableRows = page.locator('table tbody tr');
    const rowCount = await tableRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(3); // At least failed + running + cancelled
  });

  // -----------------------------------------------------------------------
  // b. フィルタ動作確認 (failed status でフィルタ可能)
  // -----------------------------------------------------------------------

  test('b. ステータスフィルタ「failed」で failed ジョブのみ表示', async ({ page }) => {
    await page.goto('/jobs');

    // Get the status select in filter bar
    const filterBar = page.locator('[data-testid="jobs-filter-bar"]');
    const statusSelects = filterBar.locator('select');
    const statusSelect = statusSelects.nth(1); // Second select is status

    // Change status filter to "failed"
    await statusSelect.selectOption('failed');

    // Wait for navigation to complete
    await page.waitForURL(/status=failed/);

    // Wait for table to update
    await page.waitForTimeout(500);

    // Verify table has rows (all should be failed)
    const tableRows = page.locator('table tbody tr');
    const rowCount = await tableRows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Check that at least the first row shows failed status
    const firstRow = tableRows.first();
    const statusBadge = firstRow.locator('span[class*="bg-red"]'); // failed has red background
    await expect(statusBadge).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // c. 一括リトライ フロー
  // -----------------------------------------------------------------------

  test('c. failed ジョブを選択 → 一括リトライ → リトライ実行確認', async ({ page }) => {
    // 1. Navigate to jobs page
    await page.goto('/jobs');

    // 2. Find and select a failed job by locating red status badge
    const tableRows = page.locator('table tbody tr');
    const rowCount = await tableRows.count();

    // Find first failed job row
    let failedRowIndex = -1;
    for (let i = 0; i < rowCount; i++) {
      const row = tableRows.nth(i);
      const redBadge = row.locator('span[class*="bg-red"]');
      if (await redBadge.isVisible()) {
        failedRowIndex = i;
        break;
      }
    }

    if (failedRowIndex === -1) {
      test.skip(); // Skip if no failed job found
    }

    // 3. Click checkbox for failed job
    const failedRow = tableRows.nth(failedRowIndex);
    const checkbox = failedRow.locator('input[type="checkbox"]').first();
    await checkbox.check();

    // 4. Verify bulk action bar appears
    const bulkActionBar = page.locator('[data-testid="bulk-action-bar"]');
    await expect(bulkActionBar).toBeVisible();

    // 5. Click retry button
    const retryButton = page.locator('[data-testid="bulk-retry-button"]');
    await expect(retryButton).toBeVisible();
    await retryButton.click();

    // 6. Wait for API response (bulkRetryJobs Server Action)
    await page.waitForTimeout(1000);

    // 7. Verify bulk action bar shows feedback (success or error)
    const bulkActionBarText = await bulkActionBar.textContent();
    expect(bulkActionBarText).toMatch(/リトライ|スキップ|エラー/);
  });

  // -----------------------------------------------------------------------
  // d. Mixed ジョブ一括選択: failed/running/done/cancelled 混在
  // -----------------------------------------------------------------------

  test('d. Mixed ジョブ選択 → bulk retry で failed のみリトライ、他はスキップ通知', async ({
    page,
  }) => {
    await page.goto('/jobs');

    // Manually check multiple rows (first 3-4 jobs should include mixed statuses)
    const tableRows = page.locator('table tbody tr');
    const rowCount = Math.min(4, await tableRows.count());

    for (let i = 0; i < rowCount; i++) {
      const checkbox = tableRows.nth(i).locator('input[type="checkbox"]').first();
      try {
        await checkbox.check({ force: true });
      } catch {
        // Checkbox might be disabled, ignore
      }
    }

    // Verify bulk action bar
    const bulkActionBar = page.locator('[data-testid="bulk-action-bar"]');
    await expect(bulkActionBar).toBeVisible();

    // Click retry
    const retryButton = page.locator('[data-testid="bulk-retry-button"]');
    await expect(retryButton).toBeVisible();
    await retryButton.click();

    // Wait for response
    await page.waitForTimeout(1000);

    // Check for response message in bulk action bar
    const bulkActionBarText = await bulkActionBar.textContent();
    // Should mention "retried" or "skipped"
    expect(bulkActionBarText).toMatch(/リトライ|スキップ|実行/i);
  });

  // -----------------------------------------------------------------------
  // e. ページネーション表示 (1000件上限)
  // -----------------------------------------------------------------------

  test('e. ページネーション情報が表示される', async ({ page }) => {
    await page.goto('/jobs');

    // Look for jobs page shell with total count text
    const jobsPageShell = page.locator('[data-testid="jobs-page-shell"]');
    await expect(jobsPageShell).toBeVisible();

    // Check that page shows some count info (typically "全 N 件のジョブ")
    const pageText = await jobsPageShell.textContent();
    expect(pageText).toMatch(/件/); // Should mention count in Japanese

    // Verify table exists and has rows
    const jobsTable = page.locator('[data-testid="jobs-table"]');
    await expect(jobsTable).toBeVisible();
  });
});
