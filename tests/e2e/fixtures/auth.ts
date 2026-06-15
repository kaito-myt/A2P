/**
 * 認証関連 E2E ヘルパ (T-02-14)
 *
 * - getE2ECredentials: AUTH_USERNAME (env) + E2E_AUTH_PASSWORD (env / .env.local) を返す
 * - createUnauthContext: storageState を持たない fresh な BrowserContext を生成
 *   (未認証アクセスやログアウト挙動の検証用)
 */
import type { Browser, BrowserContext } from '@playwright/test';

export interface E2ECredentials {
  username: string;
  password: string;
}

/**
 * E2E テスト用の credentials を env から取得。
 * - E2E_AUTH_PASSWORD は CI / .env.local で平文を渡す
 *   (本番 AUTH_PASSWORD_HASH の元になった平文と一致する必要あり)
 * - 既定値はローカル開発 seed と同じ「Miyata11」(.env.local の hash と整合済み)
 */
export function getE2ECredentials(): E2ECredentials {
  const username = process.env.AUTH_USERNAME ?? 'operator';
  const password = process.env.E2E_AUTH_PASSWORD ?? 'Miyata11';
  if (!username || !password) {
    throw new Error(
      '[e2e/auth] AUTH_USERNAME / E2E_AUTH_PASSWORD を .env.local または CI 環境変数で設定してください',
    );
  }
  return { username, password };
}

/**
 * storageState を持たない新規 BrowserContext を生成。
 * 未認証フローのテスト (リダイレクト / ロックアウト連打) 用。
 */
export async function createUnauthContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}
