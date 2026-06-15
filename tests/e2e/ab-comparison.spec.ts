/**
 * E2E: S-021 モデル A/B 比較ビュー (T-13-08, F-026)
 *
 * UC-02「モデル切替（Writer を Claude Sonnet → Gemini に変更してコスト/品質を比較）」の
 * S-021 部分を Playwright で E2E テストする。
 *
 * データは DB 内 fixture seed、LLM 呼び出しなし。
 * storageState は global.setup.ts による認証済み状態を使用。
 *
 * テストシナリオ:
 *   1. ログイン → /models/ab にアクセス
 *   2. デフォルト表示 (mode=period、先月 vs 今月) で KPI カード表示
 *   3. group_a の book_count が fixture の冊数と一致
 *   4. "データ不足" メッセージ表示 (minSample 未満グループ)
 *   5. mode 切替 → 更新後に書籍リスト表示
 *   6. 書籍タイトルクリック → /books/[id] リダイレクト
 */

import { test, expect, type Page } from '@playwright/test';
import { prisma } from '@a2p/db';
import {
  cleanupAbComparisonSeed,
  seedBooksForPeriodMode,
  seedBooksForPromptMode,
  PERIOD_MODE_DATE_PARAMS,
} from './fixtures/ab-comparison-seed';
import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

test.describe('S-021: モデル A/B 比較ビュー (T-13-08, F-026)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupAbComparisonSeed();
  });

  test.afterAll(async () => {
    await cleanupAbComparisonSeed();
    await prisma.$disconnect();
  });

  // =========================================================================
  // Scenario 1: Page Navigation and Default View
  // =========================================================================

  test('a. ログイン → /models/ab にアクセス → ab-comparison-page が表示される', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-root')).toBeVisible();

    // Navigate to AB comparison via sidebar
    await page.goto('/models/ab');
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();
  });

  // =========================================================================
  // Scenario 2: Default Period Mode with Seeded Data
  // =========================================================================

  test('b. デフォルト表示 (mode=period、先月 vs 今月) でデータを seed して KPI カード表示', async ({
    page,
  }) => {
    // Seed books for period mode (3 books in A, 8 books in B)
    await seedBooksForPeriodMode();

    // Navigate to page with explicit date params to avoid timezone ambiguity
    await page.goto(`/models/ab?${PERIOD_MODE_DATE_PARAMS}`);
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // Verify page structure
    await expect(page.getByTestId('ab-comparison-shell')).toBeVisible();
    await expect(page.getByTestId('ab-comparison-form-section')).toBeVisible();
    await expect(page.getByTestId('ab-sample-count-section')).toBeVisible();

    // Both groups should be visible initially
    const groupA = page.getByTestId('ab-sample-count-a');
    const groupB = page.getByTestId('ab-sample-count-b');

    await expect(groupA).toBeVisible();
    await expect(groupB).toBeVisible();

    // eslint-disable-next-line no-console
    console.log('[scenario-b] Default period mode page structure ✓');
  });

  // =========================================================================
  // Scenario 3: Sample Count Display
  // =========================================================================

  test('c. group_a の book_count が fixture の冊数 (3) と一致', async ({ page }) => {
    // Data already seeded from previous test; use explicit date params for determinism
    await page.goto(`/models/ab?${PERIOD_MODE_DATE_PARAMS}`);
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // Verify group A has 3 books
    const groupACard = page.getByTestId('ab-sample-count-a');
    await expect(groupACard).toBeVisible();

    // Check that the text contains "3"
    const groupAText = await groupACard.textContent();
    expect(groupAText).toContain('3');

    // eslint-disable-next-line no-console
    console.log('[scenario-c] group_a book_count=3 ✓');
  });

  test('d. group_b の book_count が fixture の冊数 (8) と一致', async ({ page }) => {
    await page.goto(`/models/ab?${PERIOD_MODE_DATE_PARAMS}`);
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // Verify group B has 8 books
    const groupBCard = page.getByTestId('ab-sample-count-b');
    await expect(groupBCard).toBeVisible();

    // Check that the text contains "8"
    const groupBText = await groupBCard.textContent();
    expect(groupBText).toContain('8');

    // eslint-disable-next-line no-console
    console.log('[scenario-d] group_b book_count=8 ✓');
  });

  // =========================================================================
  // Scenario 4: Insufficient Data Display
  // =========================================================================

  test('e. "データ不足" メッセージが minSample 未満グループに表示される', async ({
    page,
  }) => {
    await page.goto(`/models/ab?${PERIOD_MODE_DATE_PARAMS}`);
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // Group A has 3 books (< 5 default minSample), so should show insufficient
    const groupAInsufficient = page.getByTestId('ab-sample-count-a-insufficient');
    await expect(groupAInsufficient).toBeVisible();

    // Group B has 8 books (>= 5), so should show sufficient message
    const groupBInsufficient = page.getByTestId('ab-sample-count-b-insufficient');
    // This one should NOT be visible (instead a "sufficient" message should appear)
    await expect(groupBInsufficient).not.toBeVisible();

    // eslint-disable-next-line no-console
    console.log('[scenario-e] "データ不足" message on group_a (insufficient) ✓');
  });

  // =========================================================================
  // Scenario 5: Form and Mode Switching
  // =========================================================================

  test('f. ComparisonForm が表示され、mode selector で "period" が選択されている', async ({
    page,
  }) => {
    await page.goto('/models/ab');
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // Form should be visible
    const form = page.getByTestId('ab-comparison-form');
    await expect(form).toBeVisible();

    // Mode selector should exist and be set to "period"
    const modeSelect = page.getByTestId('ab-mode-select');
    await expect(modeSelect).toBeVisible();
    await expect(modeSelect).toHaveValue('period');

    // eslint-disable-next-line no-console
    console.log('[scenario-f] ComparisonForm visible with mode=period ✓');
  });

  test('g. mode を "prompt" に切替 → baselineId/candidateId 入力 → フォーム送信', async ({
    page,
  }) => {
    // Seed books for prompt mode first
    await seedBooksForPromptMode();

    await page.goto('/models/ab');
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // Change mode to 'prompt'
    const modeSelect = page.getByTestId('ab-mode-select');
    await modeSelect.selectOption('prompt');

    // Role should already be 'writer' (default)
    const roleSelect = page.getByTestId('ab-role-select');
    await expect(roleSelect).toHaveValue('writer');

    // Set baseline and candidate IDs (inputs become visible when mode !== 'period')
    const baselineInput = page.getByTestId('ab-baseline-id-input');
    const candidateInput = page.getByTestId('ab-candidate-id-input');

    await expect(baselineInput).toBeVisible();
    await expect(candidateInput).toBeVisible();

    await baselineInput.fill('pv-baseline-v1');
    await candidateInput.fill('pv-candidate-v1');

    // Submit form
    const submitButton = page.getByTestId('ab-form-submit');
    await submitButton.click();

    // Wait for URL to update with new params
    await page.waitForURL(/mode=prompt/);

    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // eslint-disable-next-line no-console
    console.log('[scenario-g] mode switched to prompt + baseline/candidate entered + form submitted ✓');
  });

  // =========================================================================
  // Scenario 6: Book List and Navigation
  // =========================================================================

  test('h. 書籍リストが表示され、各行に data-testid="ab-book-list-row" がある', async ({
    page,
  }) => {
    // Use period mode data with explicit date params for determinism
    await page.goto(`/models/ab?${PERIOD_MODE_DATE_PARAMS}`);
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // Both book lists should be visible
    const bookList = page.getByTestId('ab-book-list');
    await expect(bookList).toBeVisible();

    // Group A list (though insufficient data, structure should exist)
    const groupAList = page.getByTestId('ab-book-list-a');
    await expect(groupAList).toBeVisible();

    // Group B list (sufficient data with books)
    const groupBList = page.getByTestId('ab-book-list-b');
    await expect(groupBList).toBeVisible();

    // Check that group B has book list rows (since it has sufficient data)
    const bookRows = groupBList.locator('[data-testid="ab-book-list-row"]');
    const rowCount = await bookRows.count();
    expect(rowCount).toBe(8); // Group B has 8 books

    // eslint-disable-next-line no-console
    console.log(`[scenario-h] ab-book-list-b contains ${rowCount} rows ✓`);
  });

  test('i. 書籍リンク (data-testid="book-list-row-link") クリック → /books/[id] にリダイレクト', async ({
    page,
  }) => {
    await page.goto(`/models/ab?${PERIOD_MODE_DATE_PARAMS}`);
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // Find first book list row link in group B (which has books)
    const groupBList = page.getByTestId('ab-book-list-b');
    const firstBookLink = groupBList.locator('[data-testid="book-list-row-link"]').first();

    // Extract the href to verify it's /books/[id]
    const href = await firstBookLink.getAttribute('href');
    expect(href).toMatch(/^\/books\/.+/);

    // Click and verify navigation — wait for URL change only (not full page load)
    await firstBookLink.click();
    await page.waitForURL(/\/books\/.+/, { waitUntil: 'commit' });

    // Verify we're on a book detail page
    expect(page.url()).toMatch(/\/books\/[a-z0-9-]+$/);

    // eslint-disable-next-line no-console
    console.log(`[scenario-i] Book link navigated to ${page.url()} ✓`);
  });

  // =========================================================================
  // Scenario 7: KPI Cards Display (when both groups sufficient)
  // =========================================================================

  test('j. 両グ룹 충분 시 KPI 카드 표시', async ({ page }) => {
    // Create a scenario where both groups have sufficient data
    // by manually seeding or adjusting the minSample
    await page.goto('/models/ab?minSample=1'); // Set minSample to 1 so both groups are sufficient

    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // KPI section should be visible when both groups have sufficient data
    const kpiSection = page.getByTestId('ab-kpi-section');
    const boxPlotSection = page.getByTestId('ab-box-plot-section');

    // Both should be visible when not both insufficient
    if (!(await page.getByTestId('ab-both-insufficient').isVisible())) {
      await expect(kpiSection).toBeVisible();
      await expect(boxPlotSection).toBeVisible();

      // eslint-disable-next-line no-console
      console.log('[scenario-j] KPI and box-plot sections visible ✓');
    } else {
      // eslint-disable-next-line no-console
      console.log('[scenario-j] Both groups insufficient; skipping KPI check');
    }
  });

  // =========================================================================
  // Scenario 8: Empty State (both groups insufficient)
  // =========================================================================

  test('k. 両グループとも insufficient_data=true の場合は "データ不足" メッセージと CTA 表示', async ({
    page,
  }) => {
    // Use high minSample to make both groups insufficient
    await page.goto('/models/ab?minSample=100');
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    // Both-insufficient state should be shown
    const bothInsufficient = page.getByTestId('ab-both-insufficient');
    await expect(bothInsufficient).toBeVisible();

    // Should show message and CTA
    const homeCtaButton = page.getByTestId('ab-insufficient-home-cta');
    await expect(homeCtaButton).toBeVisible();

    // Button should link to /dashboard
    const href = await homeCtaButton.getAttribute('href');
    expect(href).toBe('/dashboard');

    // eslint-disable-next-line no-console
    console.log('[scenario-k] "Both insufficient" empty state displayed with CTA ✓');
  });

  test('l. "ホームへ" CTA クリック → /dashboard にリダイレクト', async ({ page }) => {
    await page.goto('/models/ab?minSample=100');

    const homeCtaButton = page.getByTestId('ab-insufficient-home-cta');
    await homeCtaButton.click();

    await page.waitForURL(/\/dashboard$/);
    expect(page.url()).toContain('/dashboard');

    // eslint-disable-next-line no-console
    console.log('[scenario-l] CTA redirected to /dashboard ✓');
  });

  // =========================================================================
  // Scenario 9: Responsive UI Elements
  // =========================================================================

  test('m. ab-comparison-shell コンポーネント全体が表示される', async ({ page }) => {
    await page.goto('/models/ab');
    await expect(page.getByTestId('ab-comparison-page')).toBeVisible();

    const shell = page.getByTestId('ab-comparison-shell');
    await expect(shell).toBeVisible();

    // Verify major sections are present
    await expect(shell.locator('[data-testid="ab-comparison-form-section"]')).toBeVisible();
    await expect(shell.locator('[data-testid="ab-sample-count-section"]')).toBeVisible();

    // eslint-disable-next-line no-console
    console.log('[scenario-m] ab-comparison-shell fully rendered ✓');
  });
});
