/**
 * Smoke E2E: ログイン → ダッシュボード (T-02-14)
 *
 * 検証する 4 ケース:
 *   1. ハッピーパス: 正規認証情報でログイン → /dashboard に dashboard-root が可視
 *   2. エラーパス: 不正パスワード → login-error にエラー文言が表示
 *   3. ロックアウト: 5 連続失敗 → ロック中エラー表示
 *   4. リダイレクト: 未認証で /dashboard → /login へリダイレクト
 *
 * 共通: storageState は global.setup.ts が `tests/e2e/.auth/user.json` に保存。
 * chromium プロジェクトの test は認証済み状態で開始するが、本 spec の
 * ケース 2〜4 は意図的に未認証コンテキストを生成して挙動を検証する。
 */
import { test, expect } from '@playwright/test';
import { createUnauthContext, getE2ECredentials } from './fixtures/auth';
import { cleanupTransientData, ensureSeededAuthUser, resetAuthLockout } from './fixtures/db';

test.describe('smoke: login & dashboard', () => {
  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
  });

  test.afterEach(async () => {
    // ロックアウト spec 終了後に他テストへ影響を残さない
    const { username } = getE2ECredentials();
    await resetAuthLockout(username);
  });

  test('happy path: 正規認証情報でダッシュボード遷移', async ({ page }) => {
    // 既にログイン済みの storageState で開始 → / は /dashboard へ redirect
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('dashboard-root')).toBeVisible();
    await expect(page.getByTestId('sidebar-nav')).toBeVisible();
  });

  test('error path: 不正パスワードでエラー表示', async ({ browser }) => {
    const context = await createUnauthContext(browser);
    const page = await context.newPage();
    try {
      await page.goto('/login');
      await page.getByTestId('login-username').fill('operator');
      await page.getByTestId('login-password').fill('wrong-password-xyz');
      await page.getByTestId('login-submit').click();

      const error = page.getByTestId('login-error');
      await expect(error).toBeVisible();
      await expect(error).toContainText('ユーザー名またはパスワードが正しくありません');
      // /login に留まる (redirect されない)
      await expect(page).toHaveURL(/\/login(\?|$)/);
    } finally {
      await context.close();
    }
  });

  test('lockout: 5 連続失敗で 15 分ロック表示', async ({ browser }) => {
    const context = await createUnauthContext(browser);
    const page = await context.newPage();
    try {
      await page.goto('/login');
      // 5 回連続で誤パスワード送信
      for (let attempt = 1; attempt <= 5; attempt++) {
        await page.getByTestId('login-username').fill('operator');
        await page.getByTestId('login-password').fill(`bad-pwd-${attempt}`);
        await page.getByTestId('login-submit').click();
        // 各送信ごとにエラー要素が更新される (再 visible 化を待つ)
        await expect(page.getByTestId('login-error')).toBeVisible();
      }

      // 6 回目: ロック中 → 正しいパスワードでも拒否されるはず
      const { password } = getE2ECredentials();
      await page.getByTestId('login-username').fill('operator');
      await page.getByTestId('login-password').fill(password);
      await page.getByTestId('login-submit').click();

      const error = page.getByTestId('login-error');
      await expect(error).toBeVisible();
      // 「ロック中」or 「15 分」を含む文言 (messages.login.errors.locked)
      await expect(error).toContainText(/ロック/);
      await expect(page).toHaveURL(/\/login(\?|$)/);
    } finally {
      await context.close();
    }
  });

  test('redirect: 未認証で /dashboard アクセス → /login', async ({ browser }) => {
    const context = await createUnauthContext(browser);
    const page = await context.newPage();
    try {
      await page.goto('/dashboard');
      // middleware が /login へ redirect (callbackUrl 付き)
      await expect(page).toHaveURL(/\/login(\?|$)/);
      await expect(page.getByTestId('login-submit')).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
