/**
 * E2E: T-07-06 -- Header CostMeter + /api/cost/current.
 *
 * F-036 月次コスト上限到達予測 (Header 表示)
 * S-024 コスト詳細ダッシュボード (CostMeter からのリンク)
 *
 * Scenarios:
 *   1. /api/cost/current returns { monthly_cost_jpy, budget_jpy, ratio, level, ... }
 *   2. /api/cost/current returns 0 cost when token_usage is empty
 *   3. Header CostMeter displays cost value + progress bar after login
 *   4. CostMeter click navigates to /cost (S-024)
 *
 * Notes:
 *  - No external LLM/API calls (display + API only).
 *  - dev server (Next.js port 3001) via playwright.config webServer.
 *  - Postgres via Docker a2p-pg port 5433.
 *  - CostMeter polls every 30s; tests use API fetch + DOM assertions.
 *
 * Spec refs:
 *  - docs/02 F-036
 *  - docs/04 S-024 (CostMeter link)
 *  - docs/sprints/SP-07 T-07-06
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-t-07-06-cost-meter';

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeedContext {
  accountId: string;
  themeId: string;
  bookId: string;
  costJpyTotal: number;
}

/**
 * 1 Account + 1 ThemeCandidate + 1 Book + token_usage rows for the current month.
 */
async function seedWithTokenUsage(label: string): Promise<SeedContext> {
  const ts = Date.now();

  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${label}-${ts}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-${label}-session-${ts}`,
      genre: 'business',
      title: `T-07-06 ${label} test theme`,
      hook: 'e2e cost meter test',
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
      title: `T-07-06 ${label} test book`,
      status: 'running',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  // Insert token_usage for the current month
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), Math.min(now.getDate(), 28));

  const costA = 42.5;
  const costB = 18.3;
  const totalCost = costA + costB;

  await prisma.tokenUsage.createMany({
    data: [
      {
        book_id: book.id,
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
        cost_jpy: costA,
        created_at: today,
      },
      {
        book_id: book.id,
        provider: 'openai',
        model: 'gpt-image-1',
        role: 'thumbnail_image',
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        image_count: 1,
        unit_price_snapshot: {
          image_per_image_usd: 0.04,
          fx_rate_usd_jpy: 155.0,
        } as unknown as Prisma.InputJsonValue,
        cost_jpy: costB,
        created_at: today,
      },
    ],
  });

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    costJpyTotal: totalCost,
  };
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('T-07-06: Header CostMeter + /api/cost/current', () => {
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
  // 1. API /api/cost/current -- returns expected shape with token_usage data
  // -------------------------------------------------------------------------
  test('1. /api/cost/current returns correct shape with seeded token_usage', async ({
    page,
  }) => {
    const ctx = await seedWithTokenUsage('api-shape');

    // Navigate first to establish an authenticated session context
    await page.goto('/dashboard');
    await page.waitForURL(/\/(dashboard|$)/);

    // Call the API directly via the authenticated page context
    const response = await page.evaluate(async () => {
      const res = await fetch('/api/cost/current');
      if (!res.ok) return { error: res.status };
      return res.json();
    });

    // Verify shape: { monthly_cost_jpy, budget_jpy, ratio, level, remaining, warn_count, paused_count }
    expect(response).toHaveProperty('monthly_cost_jpy');
    expect(response).toHaveProperty('budget_jpy');
    expect(response).toHaveProperty('ratio');
    expect(response).toHaveProperty('level');
    expect(response).toHaveProperty('remaining');
    expect(response).toHaveProperty('warn_count');
    expect(response).toHaveProperty('paused_count');

    // Types
    expect(typeof response.monthly_cost_jpy).toBe('number');
    expect(typeof response.budget_jpy).toBe('number');
    expect(typeof response.ratio).toBe('number');
    expect(typeof response.level).toBe('string');
    expect(typeof response.remaining).toBe('number');
    expect(typeof response.warn_count).toBe('number');
    expect(typeof response.paused_count).toBe('number');

    // monthly_cost_jpy should be > 0 since we seeded token_usage
    expect(response.monthly_cost_jpy).toBeGreaterThan(0);

    // budget_jpy should be the default 50,000 (no AppSettings row seeded)
    expect(response.budget_jpy).toBe(50_000);

    // level must be one of the valid values
    expect(['green', 'yellow', 'orange', 'red']).toContain(response.level);

    // With ~61 JPY cost vs 50,000 budget, level should be 'green'
    expect(response.level).toBe('green');

    // ratio should be small (cost / budget * 100) but > 0
    expect(response.ratio).toBeGreaterThan(0);
    expect(response.ratio).toBeLessThan(1); // ~0.1% of 50k

    // remaining = budget - cost, should be close to budget
    expect(response.remaining).toBeGreaterThan(0);
    expect(response.remaining).toBeLessThanOrEqual(response.budget_jpy);

    // Clean up this test's data to not affect subsequent tests
    await prisma.tokenUsage
      .deleteMany({ where: { book_id: ctx.bookId } })
      .catch(() => undefined);
    await prisma.account
      .deleteMany({ where: { id: ctx.accountId } })
      .catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // 2. API /api/cost/current -- returns 0 cost when no token_usage
  // -------------------------------------------------------------------------
  test('2. /api/cost/current returns 0 cost when token_usage is empty', async ({
    page,
  }) => {
    // Ensure clean state: no token_usage rows
    await cleanupTestData();

    await page.goto('/dashboard');
    await page.waitForURL(/\/(dashboard|$)/);

    const response = await page.evaluate(async () => {
      const res = await fetch('/api/cost/current');
      if (!res.ok) return { error: res.status };
      return res.json();
    });

    // With no token_usage data, monthly_cost_jpy should be 0
    expect(response.monthly_cost_jpy).toBe(0);
    expect(response.ratio).toBe(0);
    expect(response.level).toBe('green');
    expect(response.remaining).toBe(response.budget_jpy);
    expect(response.warn_count).toBe(0);
    expect(response.paused_count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Header CostMeter displays cost value + progress bar
  // -------------------------------------------------------------------------
  test('3. Header CostMeter displays cost value and progress bar on dashboard', async ({
    page,
  }) => {
    // Seed token_usage so the meter shows a non-zero value
    const ctx = await seedWithTokenUsage('header-display');

    await page.goto('/dashboard');
    await page.waitForURL(/\/(dashboard|$)/);

    // CostMeter has aria-label="当月コスト"
    const costMeter = page.getByLabel('当月コスト');
    await expect(costMeter).toBeVisible({ timeout: 15_000 });

    // Initially shows fallback "—", then after fetch completes shows yen value
    // Wait for the fetch to complete and display real data
    await expect
      .poll(
        async () => {
          const text = await costMeter.textContent();
          return text ?? '';
        },
        {
          timeout: 15_000,
          message: 'Waiting for CostMeter to load cost data from /api/cost/current',
        },
      )
      .toContain('¥'); // yen sign (¥)

    // The CostMeter text should contain the label "当月コスト"
    await expect(costMeter).toContainText('当月コスト');

    // Progress bar should be visible (role="progressbar" inside CostMeter)
    const progressBar = costMeter.getByRole('progressbar');
    await expect(progressBar).toBeVisible();

    // aria-valuenow should be a number >= 0
    const valueNow = await progressBar.getAttribute('aria-valuenow');
    expect(valueNow).toBeTruthy();
    expect(Number(valueNow)).toBeGreaterThanOrEqual(0);

    // Budget info should be visible (contains "/ ¥50,000" pattern)
    await expect(costMeter).toContainText('/ ¥50,000');

    // Clean up
    await prisma.tokenUsage
      .deleteMany({ where: { book_id: ctx.bookId } })
      .catch(() => undefined);
    await prisma.account
      .deleteMany({ where: { id: ctx.accountId } })
      .catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // 4. CostMeter click navigates to /cost (S-024)
  // -------------------------------------------------------------------------
  test('4. CostMeter click navigates to /cost', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForURL(/\/(dashboard|$)/);

    // CostMeter has role="button" so it is clickable
    const costMeter = page.getByLabel('当月コスト');
    await expect(costMeter).toBeVisible({ timeout: 15_000 });

    // Wait for it to be loaded (not showing fallback)
    await expect
      .poll(
        async () => {
          const text = await costMeter.textContent();
          return text ?? '';
        },
        {
          timeout: 15_000,
          message: 'Waiting for CostMeter to finish initial load',
        },
      )
      .not.toContain('—'); // em-dash fallback character

    // Click the CostMeter
    await costMeter.click();

    // Should navigate to /cost (S-024 cost dashboard)
    await expect(page).toHaveURL(/\/cost(\?|$)/, { timeout: 10_000 });
    await expect(page.getByTestId('cost-dashboard-page')).toBeVisible();
  });
});
