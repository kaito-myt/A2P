/**
 * Global setup project (T-02-14)
 *
 * Playwright 起動時に 1 度だけ実行され、認証 cookie を
 * `tests/e2e/.auth/user.json` に保存する。以降の `chromium` プロジェクトは
 * この storageState を読み込んでログイン済み状態でテストを開始する。
 *
 * 前提:
 *   - apps/web が baseURL で起動済み (Playwright の webServer が担保)
 *   - User レコードが seed 投入済み (AUTH_USERNAME / AUTH_PASSWORD_HASH に対応)
 *   - 平文パスワードは E2E_AUTH_PASSWORD で渡す (CI / .env.local)
 */
import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getE2ECredentials } from './fixtures/auth';
import { ensureSeededAuthUser, cleanupTransientData } from './fixtures/db';

const STORAGE_STATE_PATH = path.resolve('tests/e2e/.auth/user.json');

setup('authenticate', async ({ page }) => {
  // 0. tests/e2e/.auth ディレクトリを作成
  mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });

  // 1. DB を E2E 用にクリーンアップ + シードユーザー確認
  await cleanupTransientData();
  await ensureSeededAuthUser();

  // 2. ログインフォーム経由で認証
  const { username, password } = getE2ECredentials();
  await page.goto('/login');
  await expect(page.getByTestId('login-submit')).toBeVisible();
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();

  // 3. ダッシュボードへ遷移完了を待ち、storageState を保存
  await page.waitForURL((url) => url.pathname === '/dashboard' || url.pathname === '/');
  await expect(page.getByTestId('dashboard-root')).toBeVisible();
  await page.context().storageState({ path: STORAGE_STATE_PATH });
});
