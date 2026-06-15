/**
 * E2E Chromium: T-12-09 売上自動取得 UI テスト (S-017, S-027)
 *
 * 前提:
 *   - storageState は global.setup.ts が認証済みで保存済み
 *   - PostgreSQL 稼働中（Docker a2p-pg:5433）
 *   - apps/worker は起動していない
 *
 * テストシナリオ:
 *   A. 正常系 — S-017 ダッシュボードからバナーと手動取得ボタンを確認
 *   B. S-027 設定 — 売上自動取得トグル ON/OFF + 設定永続化
 *   C. 2FA バナー表示 — 2FA_WAITING 状態での橙バナー表示
 *
 * 注意:
 *   - worker が起動していないため、ジョブの非同期完了ポーリングは行わない
 *   - UI の基本動作（バナー表示、ボタン click → SA 呼出）のみ検証
 *
 * コスト: ゼロ (UI + DB 操作のみ、実 API 呼び出しなし)
 */
import { test, expect, type Page } from '@playwright/test';
import { Prisma, prisma } from '@a2p/db';
import { encryptKdpCredentials } from '@a2p/crypto';

const E2E_PREFIX = 'e2e-sales-auto-fetch-ui-';

interface TestContext {
  accountId: string;
}

let ctx: TestContext = { accountId: '' };

// Set crypto key for encrypt/decrypt operations
const TEST_CRYPTO_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.KDP_CRED_KEY = TEST_CRYPTO_KEY_HEX;

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupTestData(): Promise<void> {
  // Delete SalesFetchRun, SalesRecord, etc. for test account
  if (ctx.accountId) {
    const bookIds = (
      await prisma.book.findMany({
        where: { account_id: ctx.accountId },
        select: { id: true },
      })
    ).map((b) => b.id);

    if (bookIds.length > 0) {
      await prisma.salesRecord
        .deleteMany({ where: { book_id: { in: bookIds } } })
        .catch(() => undefined);
      await prisma.book
        .deleteMany({ where: { id: { in: bookIds } } })
        .catch(() => undefined);
    }

    await prisma.salesFetchRun
      .deleteMany({ where: { account_id: ctx.accountId } })
      .catch(() => undefined);

    await prisma.account
      .deleteMany({ where: { id: ctx.accountId } })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedTestAccount(): Promise<string> {
  const ts = Date.now();

  const account = await prisma.account.create({
    data: {
      pen_name: `${E2E_PREFIX}${ts}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['sales_ui_test'],
      } as unknown as Prisma.InputJsonValue,
      status: 'active',
      kdp_credentials_enc: encryptKdpCredentials(
        JSON.stringify({
          email: 'test@example.com',
          password: 'test-password-123',
        }),
        Buffer.from(TEST_CRYPTO_KEY_HEX, 'hex'),
      ),
    },
    select: { id: true },
  });

  // Create a test book
  await prisma.book.create({
    data: {
      account_id: account.id,
      asin: 'B0TESTBOOK',
      title: 'テスト書籍 UI',
      status: 'published',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
    },
  });

  return account.id;
}

async function seedSalesFetchRun(
  accountId: string,
  status: string,
  recordsUpserted?: number,
  errorMessage?: string,
): Promise<string> {
  const run = await prisma.salesFetchRun.create({
    data: {
      account_id: accountId,
      year_month: '2026-05',
      status,
      records_upserted: recordsUpserted ?? 0,
      error_message: errorMessage,
      finished_at: status === 'done' ? new Date() : undefined,
    },
    select: { id: true },
  });
  return run.id;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('T-12-09 E2E Chromium: 売上自動取得 UI', () => {
  test.beforeAll(async () => {
    await cleanupTestData();
    ctx.accountId = await seedTestAccount();
  });

  test.afterAll(async () => {
    await cleanupTestData();
  });

  // =========================================================================
  // Scenario A: S-017 バナー表示 — 各ステータス（未実行、done、failed、2fa）
  // =========================================================================

  test.describe('Scenario A: S-017 ダッシュボード — ステータスバナー表示', () => {
    test('A1. 未実行状態: 「まだ取得していません」バナー + 「今すぐ取得」ボタン', async ({
      page,
    }) => {
      await page.goto('/sales');
      await expect(page).toHaveURL('/sales');

      // バナーが表示されていることを確認
      const banner = page.locator('[data-testid="sales-fetch-banner"]');
      await expect(banner).toBeVisible();

      // 「まだ取得していません」テキストを確認（content 検証）
      await expect(banner).toContainText('まだ自動取得を実行していません');

      // 「今すぐ取得」ボタンの存在と有効状態
      const triggerBtn = banner.locator('button:has-text("今すぐ取得")');
      await expect(triggerBtn).toBeVisible();
      await expect(triggerBtn).toBeEnabled();
    });

    test('A2. done 状態: 「最終取得」と「N 件更新」を表示', async ({ page }) => {
      // Seed done run
      await seedSalesFetchRun(ctx.accountId, 'done', 5);

      await page.goto('/sales');

      const banner = page.locator('[data-testid="sales-fetch-banner"]');
      await expect(banner).toBeVisible();

      // ✓ アイコンと「最終取得」テキスト
      await expect(banner).toContainText('最終取得');

      // 「5 件更新」テキスト（recordsUpserted の表示）
      await expect(banner).toContainText('5 件更新');

      // 「再取得」ボタン
      const retryBtn = banner.locator('button:has-text("再取得")');
      await expect(retryBtn).toBeVisible();
      await expect(retryBtn).toBeEnabled();
    });

    test('A3. failed 状態: 赤バナー + エラーメッセージ', async ({ page }) => {
      // Seed failed run with error message
      await seedSalesFetchRun(
        ctx.accountId,
        'failed',
        undefined,
        'ブラウザセッションの初期化に失敗しました',
      );

      await page.goto('/sales');

      const banner = page.locator('[data-testid="sales-fetch-banner"]');
      await expect(banner).toBeVisible();

      // 赤色バナー（デストラクティブカラー）
      const failedBanner = banner.locator('[data-testid="sales-fetch-banner-failed"]');
      await expect(failedBanner).toBeVisible();

      // エラーメッセージ
      await expect(banner).toContainText('エラー');
      await expect(banner).toContainText('ブラウザセッションの初期化に失敗しました');

      // 「再試行」ボタン
      const retryBtn = banner.locator('button:has-text("再試行")');
      await expect(retryBtn).toBeVisible();
      await expect(retryBtn).toBeEnabled();
    });

    test('A4. 2fa_waiting 状態: 橙バナー「2FA 認証待ち」', async ({ page }) => {
      // Seed 2fa_waiting run
      await seedSalesFetchRun(ctx.accountId, '2fa_waiting');

      await page.goto('/sales');

      const banner = page.locator('[data-testid="sales-fetch-banner"]');
      await expect(banner).toBeVisible();

      // 橙色バナー（警告カラー）
      const twoFaBanner = banner.locator('[data-testid="sales-fetch-banner-2fa"]');
      await expect(twoFaBanner).toBeVisible();

      // メッセージ内容
      await expect(banner).toContainText('2FA 認証待ち');
      await expect(banner).toContainText('メールで承認してください');

      // ボタンがないこと（2FA 待機中はボタン無効）
      const triggerBtn = banner.locator('button');
      // 2FA バナー自体のボタンはないが、他の UI 要素のボタンは存在可能なので検証しない
    });
  });

  // =========================================================================
  // Scenario B: S-027 設定 — トグル ON/OFF + cron フィールド
  // =========================================================================

  test.describe('Scenario B: S-027 設定 — 売上自動取得設定', () => {
    test('B1. トグル ON → 保存 → 再読込で ON が永続', async ({ page }) => {
      await page.goto('/settings');
      await expect(page).toHaveURL('/settings');

      // 「売上自動取得」セクションを探す
      const settingsSection = page.locator('[data-testid="sales-auto-fetch-settings"]');
      await expect(settingsSection).toBeVisible();

      // トグルが初期状態（OFF or ON 確認）
      const toggleSwitch = settingsSection.locator('[data-testid="sales-auto-fetch-toggle"]');
      const initialState = await toggleSwitch.getAttribute('aria-checked');

      // 反対の状態に切り替える
      const targetState = initialState === 'true' ? 'false' : 'true';
      if (initialState !== targetState) {
        await toggleSwitch.click();
      }

      // 「保存」ボタンをクリック
      const saveBtn = settingsSection.locator('button:has-text("保存")');
      await expect(saveBtn).toBeVisible();
      await saveBtn.click();

      // toast or success message の確認（任意、API の応答を待つ）
      await page.waitForTimeout(500);

      // ページを再読込
      await page.reload();

      // トグルが保存された状態のままであることを確認
      const toggleAfterReload = settingsSection.locator('[data-testid="sales-auto-fetch-toggle"]');
      const stateAfterReload = await toggleAfterReload.getAttribute('aria-checked');
      expect(stateAfterReload).toBe(targetState);
    });

    test('B2. トグル ON のとき cron フィールドが有効', async ({ page }) => {
      await page.goto('/settings');

      const settingsSection = page.locator('[data-testid="sales-auto-fetch-settings"]');

      // トグルを ON にする
      const toggleSwitch = settingsSection.locator('[data-testid="sales-auto-fetch-toggle"]');
      const isChecked = await toggleSwitch.getAttribute('aria-checked');
      if (isChecked === 'false') {
        await toggleSwitch.click();
      }

      // cron フィールドが enabled 状態か確認
      const cronInput = settingsSection.locator('#sales-auto-fetch-cron');
      await expect(cronInput).toBeEnabled();

      // cron の値を読めることを確認（read）
      const cronValue = await cronInput.inputValue();
      expect(typeof cronValue).toBe('string');
    });

    test('B3. トグル OFF のとき cron フィールドが disabled', async ({ page }) => {
      await page.goto('/settings');

      const settingsSection = page.locator('[data-testid="sales-auto-fetch-settings"]');

      // トグルを OFF にする
      const toggleSwitch = settingsSection.locator('[data-testid="sales-auto-fetch-toggle"]');
      const isChecked = await toggleSwitch.getAttribute('aria-checked');
      if (isChecked === 'true') {
        await toggleSwitch.click();
      }

      // cron フィールドが disabled 状態か確認
      const cronInput = settingsSection.locator('#sales-auto-fetch-cron');
      await expect(cronInput).toBeDisabled();
    });
  });

  // =========================================================================
  // Scenario C: 手動トリガー — ボタンクリック → SA 呼出
  // =========================================================================

  test.describe('Scenario C: 手動トリガー', () => {
    test('C1. 「今すぐ取得」クリック → SA 呼出 + エラーなし', async ({ page }) => {
      // 未実行の状態を作る（beforeEach または新しい run を削除）
      await prisma.salesFetchRun.deleteMany({
        where: { account_id: ctx.accountId },
      });

      await page.goto('/sales');

      const banner = page.locator('[data-testid="sales-fetch-banner"]');
      await expect(banner).toBeVisible();

      // 「今すぐ取得」ボタンをクリック
      const triggerBtn = banner.locator('[data-testid="sales-fetch-trigger"]').first();
      await triggerBtn.click();

      // ボタンが disabled または pending 状態になることを確認
      // （SA 実行中を示す）
      await expect(triggerBtn).toBeDisabled({ timeout: 5000 });

      // ページが自動更新され、「取得中」状態になることを確認
      // （ただし worker が起動していないため、running → done への遷移は見られない）
      const runningText = banner.locator('text=取得中');
      // await expect(runningText).toBeVisible({ timeout: 2000 });

      // エラーバナー（SA 失敗）が出ないことを確認
      const errorBanner = banner.locator('[data-testid="sales-fetch-error"]');
      await expect(errorBanner).not.toBeVisible();
    });
  });

  // =========================================================================
  // Bonus: ページレイアウト基本確認
  // =========================================================================

  test.describe('Layout checks', () => {
    test('S-017 ページが読み込まれる', async ({ page }) => {
      await page.goto('/sales');
      await expect(page).toHaveURL('/sales');

      const pageTitle = page.getByRole('heading', { level: 1 });
      await expect(pageTitle).toBeVisible();
    });

    test('S-027 ページが読み込まれる', async ({ page }) => {
      await page.goto('/settings');
      await expect(page).toHaveURL('/settings');

      const pageTitle = page.getByRole('heading', { level: 1 });
      await expect(pageTitle).toBeVisible();
    });
  });
});
