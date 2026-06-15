/**
 * Playwright E2E configuration (T-02-14)
 *
 * - baseURL: http://localhost:3001 (apps/web の dev/start ともに 3001 に固定済み)
 * - workers: 1 (シングルユーザー前提、認証 storageState を共有するため並列不可)
 * - storageState 戦略:
 *     `setup` プロジェクトが global.setup.ts を 1 回実行 → cookie を
 *     tests/e2e/.auth/user.json に保存。`chromium` プロジェクトは
 *     dependencies で `setup` を待ち、認証済みコンテキストでテストを開始する。
 * - webServer: `pnpm --filter @a2p/web start` を自動起動 (CI/local 共通)。
 *     env-file は `--filter` が継承しないので、ここで dotenv を読み込んで
 *     Playwright プロセスの process.env に流し込み、子プロセス (Next start) に
 *     継承させる。
 */
import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';

// .env.local をルート + apps/web の両方で参照可能にしておく。
// CI では env が GitHub Actions の env で渡される前提なのでファイル不存在は無視。
const envLocal = path.resolve(__dirname, '.env.local');
if (existsSync(envLocal)) {
  dotenv.config({ path: envLocal });
}

const PORT = 3001;
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Vitest spec が誤って拾われないよう拡張子を限定
  testMatch: /.*\.spec\.ts$|global\.setup\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /global\.setup\.ts$/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/e2e/.auth/user.json',
      },
      dependencies: ['setup'],
      // setup spec は chromium プロジェクトで再実行しない
      testIgnore: /global\.setup\.ts$/,
    },
    {
      name: 'runtime',
      testMatch: /.*-runtime\.spec\.ts$/,
      // Runtime テストは setup 不要（DB ダイレクトテスト）
    },
  ],
  webServer: {
    // 既に外部で起動中なら再利用 (ローカル開発時の便利機能)。CI は常に新規起動。
    command: 'pnpm --filter @a2p/web dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // dotenv で読み込んだ env を子プロセス (next dev) に継承
    env: {
      ...process.env,
      PORT: String(PORT),
    } as Record<string, string>,
  },
});
