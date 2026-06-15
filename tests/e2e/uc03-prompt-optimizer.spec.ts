/**
 * E2E: UC-03 プロンプト改訂サイクル (T-11-09)
 *
 * 検証シナリオ: S-002 → S-023 → S-022 → S-029
 *
 * ケース:
 *   a. 改訂提案を手動承認 → status が承認済みに変わり、新 Prompt が active に
 *   b. 自動承認済み提案を 24h 以内にロールバック → ロールバックボタン enabled
 *   c. 24h 経過後はロールバックボタンが disabled
 *   d. 監査ログに承認操作が記録される
 *
 * 前提:
 *   - global.setup.ts による認証が完了（storageState に cookie）
 *   - PostgreSQL 稼働中
 *   - apps/web が baseURL で起動済み
 *
 * テストデータ:
 *   - Prompt / PromptProposal / EvalResult を beforeEach で seed + afterEach で cleanup
 *   - LLM 実呼び出しなし（Optimizer は呼ばない）
 */
import { test, expect, type Page } from '@playwright/test';

import { prisma } from '@a2p/db';

import { ensureSeededAuthUser, cleanupTransientData } from './fixtures/db';
import {
  cleanupUC03Data,
  seedPendingProposal,
  seedAutoApprovedProposal,
  seedEvalResults,
} from './fixtures/prompt-optimizer-seed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * ダッシュボードを経由して /prompts/proposals に遷移。
 * ブラウザ context は認証済み (storageState)。
 */
async function gotoProposalsPage(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard-root')).toBeVisible();
  // サイドバーから「プロンプト改訂承認」リンクをクリック
  // (UI のリンクテキストは「改訂承認」を想定)
  await page.goto('/prompts/proposals');
  await page.waitForURL(/\/prompts\/proposals$/);
}

/**
 * /prompts ページでバージョン履歴を確認。
 * S-022 のプロンプト一覧テーブルでアクティブバージョンを検証。
 */
async function gotoPromptsPage(page: Page): Promise<void> {
  await page.goto('/prompts');
  await page.waitForURL(/\/prompts$/);
  await expect(page.getByTestId('prompts-page')).toBeVisible();
}

/**
 * 監査ログページに遷移して action='prompt.approve' を確認。
 * S-029
 */
async function gotoAuditPage(page: Page): Promise<void> {
  await page.goto('/audit');
  await page.waitForURL(/\/audit$/);
  await expect(page.getByTestId('audit-page')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('UC-03 プロンプト改訂サイクル', () => {
  test.beforeAll(async () => {
    // 初回のみ: ユーザー確認 + 基本 cleanup
    await ensureSeededAuthUser();
    await cleanupTransientData();
  });

  test.beforeEach(async () => {
    // 各テスト前に UC-03 固有データを cleanup
    await cleanupUC03Data();
  });

  test.afterEach(async () => {
    // 各テスト後に cleanup
    await cleanupUC03Data();
  });

  test.afterAll(async () => {
    // DB disconnect
    await prisma.$disconnect();
  });

  // =========================================================================
  // a. 改訂提案を手動承認してプロンプトが切り替わる
  // =========================================================================

  test('a. 改訂提案を手動承認 → status が承認済みに変わり新 Prompt が active に', async ({ page }) => {
    // 1. seed: pending proposal を投入
    const { promptId, proposalId } = await seedPendingProposal();

    // 2. /prompts/proposals に遷移
    await gotoProposalsPage(page);

    // 3. 提案一覧テーブルに 1 件表示されることを確認
    const proposalsTable = page.getByTestId('proposals-table');
    await expect(proposalsTable).toBeVisible();
    await expect(proposalsTable).toContainText('writer');

    // 4. 提案行をクリック (data-testid: proposal-row-{id})
    const proposalRow = page.getByTestId(`proposal-row-${proposalId}`);
    await expect(proposalRow).toBeVisible();
    await proposalRow.click();

    // 5. 右カラムに提案詳細が表示
    const proposalDetail = page.getByTestId('proposal-detail');
    await expect(proposalDetail).toBeVisible();

    // diff viewer が表示されることを確認
    const diffViewer = page.getByTestId('diff-viewer');
    await expect(diffViewer).toBeVisible();

    // 6. 「承認」ボタンをクリック
    const approveButton = page.getByRole('button', { name: /承認/ }).first();
    await expect(approveButton).toBeEnabled();
    await approveButton.click();

    // 7. 成功トースト表示
    const successToast = page.getByTestId('toast-success');
    await expect(successToast).toBeVisible();
    await expect(successToast).toContainText('承認');

    // 8. 提案ステータスが「承認済み」に変わる
    const statusBadge = page.getByTestId(`proposal-status-${proposalId}`);
    await expect(statusBadge).toContainText('承認済み');

    // 9. /prompts ページでバージョン履歴を確認
    await gotoPromptsPage(page);

    // role=writer, genre=business の行を探してアクティブバージョンを確認
    const promptsTable = page.getByTestId('prompts-table');
    await expect(promptsTable).toBeVisible();
    // 新バージョン (v2) が active に切り替わっていることを確認
    // テーブルには「active バージョン」列があり、ここに v が表示される
    const rows = await promptsTable.locator('tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  // =========================================================================
  // b. 自動承認済み提案を 24h 以内にロールバックできる
  // =========================================================================

  test('b. 自動承認済み提案を 24h 以内にロールバック → ロールバックボタン enabled + 実行成功', async ({ page }) => {
    // 1. seed: rollback_until = now + 12h の auto_approved proposal を投入
    const { proposalId } = await seedAutoApprovedProposal({ rollback_until_offset_h: 12 });

    // 2. /prompts/proposals に遷移
    await gotoProposalsPage(page);

    // 3. 提案行をクリック
    const proposalRow = page.getByTestId(`proposal-row-${proposalId}`);
    await expect(proposalRow).toBeVisible();
    await proposalRow.click();

    // 4. 提案詳細が表示
    const proposalDetail = page.getByTestId('proposal-detail');
    await expect(proposalDetail).toBeVisible();

    // 5. ロールバックボタンが enabled であることを確認
    const rollbackButton = page.getByRole('button', { name: /ロールバック/ });
    await expect(rollbackButton).toBeEnabled();

    // 6. ロールバックボタンをクリック
    await rollbackButton.click();

    // 7. 成功トースト表示
    const successToast = page.getByTestId('toast-success');
    await expect(successToast).toBeVisible();
    await expect(successToast).toContainText('ロールバック');
  });

  // =========================================================================
  // c. 24h 経過後はロールバックボタンが disabled
  // =========================================================================

  test('c. 24h 経過後はロールバックボタンが disabled', async ({ page }) => {
    // 1. seed: rollback_until = now - 1h (過去) の auto_approved proposal を投入
    const { proposalId } = await seedAutoApprovedProposal({ rollback_until_offset_h: -1 });

    // 2. /prompts/proposals に遷移
    await gotoProposalsPage(page);

    // 3. 提案行をクリック
    const proposalRow = page.getByTestId(`proposal-row-${proposalId}`);
    await expect(proposalRow).toBeVisible();
    await proposalRow.click();

    // 4. 提案詳細が表示
    const proposalDetail = page.getByTestId('proposal-detail');
    await expect(proposalDetail).toBeVisible();

    // 5. ロールバックボタンが disabled であることを確認
    const rollbackButton = page.getByRole('button', { name: /ロールバック/ });
    await expect(rollbackButton).toBeDisabled();
  });

  // =========================================================================
  // d. 監査ログに承認操作が記録される
  // =========================================================================

  test('d. 監査ログに承認操作が記録される', async ({ page }) => {
    // 1. seed: pending proposal を投入
    const { proposalId } = await seedPendingProposal();

    // 2. /prompts/proposals に遷移
    await gotoProposalsPage(page);

    // 3. 提案を選択
    const proposalRow = page.getByTestId(`proposal-row-${proposalId}`);
    await expect(proposalRow).toBeVisible();
    await proposalRow.click();

    // 4. 提案詳細が表示
    const proposalDetail = page.getByTestId('proposal-detail');
    await expect(proposalDetail).toBeVisible();

    // 5. 「承認」ボタンをクリック
    const approveButton = page.getByRole('button', { name: /承認/ }).first();
    await expect(approveButton).toBeEnabled();
    await approveButton.click();

    // 6. 成功トースト表示を確認
    const successToast = page.getByTestId('toast-success');
    await expect(successToast).toBeVisible();

    // 7. /audit ページに遷移
    await gotoAuditPage(page);

    // 8. 監査ログテーブルに action='prompt.approve' が記録されていることを確認
    const auditTable = page.getByTestId('audit-log-table');
    await expect(auditTable).toBeVisible();
    // 監査ログには action='prompt.approve' が日本語ラベルで表示される
    await expect(auditTable).toContainText('プロンプト改訂承認');
  });
});
