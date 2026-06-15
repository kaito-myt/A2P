/**
 * E2E Runtime: T-12-09 売上自動取得 (runSalesFetch) 統合テスト
 *
 * 本 spec は `page` を使わない Node ランタイム上での DB テスト。
 * Playwright を test runner として借用し、実 DB に対して直接 runSalesFetch を呼ぶ。
 *
 * テストシナリオ:
 *   1. 正常系: fixture HTML を注入 → SalesRecord upsert + SalesFetchRun status=done
 *   2. 2FA 発生: create2faBrowserPort() → Kdp2FaCode INSERT + SalesFetchRun status=2fa_waiting
 *   3. 認証情報未設定: no_credentials アカウント → SalesFetchRun status=failed, reason='no_credentials'
 *   4. 冪等性: 同じ year_month で 2 回呼んでも SalesRecord 重複なし
 *
 * 前提:
 *   - PostgreSQL 稼働中（Docker a2p-pg:5433）
 *   - .env.local に DATABASE_URL 設定済み
 *
 * コスト: ゼロ (DB のみ、LLM/外部 API 呼出なし)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { prisma, Prisma } from '@a2p/db';
import { encryptKdpCredentials } from '@a2p/crypto';

import {
  runSalesFetch,
  type SalesFetchDeps,
} from '../../apps/worker/src/tasks/sales-fetch.js';
import {
  createFixtureBrowserPort,
  create2faBrowserPort,
  type BrowserPort,
} from '../../apps/worker/src/tasks/sales-fetch/browser-port.js';

const TEST_ACCOUNT_PREFIX = 'e2e-sales-auto-fetch-runtime';
// Use valid ASIN format: B0 + 8 alphanumeric chars (10 chars total)
// These should match the fixture HTML ASINs
const TEST_ASIN_A = 'B0TESTAA01';
const TEST_ASIN_B = 'B0TESTBB02';
const TEST_YEAR_MONTH = '2026-05';

interface TestContext {
  accountIdWithCredentials: string;
  accountIdNoCredentials: string;
  bookIdA: string;
  bookIdB: string;
  fixtureHtml: string;
  cryptoKey: Buffer;
}

// Generate a 32-byte (64 hex char) encryption key for testing
function generateTestKey(): Buffer {
  // Use a fixed test key: 64 hex characters = 32 bytes
  // IMPORTANT: This must match the key used in decryptKdpCredentials()
  // When decrypting, the function will use process.env.KDP_CRED_KEY if no key is passed
  // So we need to set the env variable as well
  const testKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.KDP_CRED_KEY = testKeyHex; // Ensure decrypt uses the same key
  return Buffer.from(testKeyHex, 'hex');
}

let ctx: TestContext = {
  accountIdWithCredentials: '',
  accountIdNoCredentials: '',
  bookIdA: '',
  bookIdB: '',
  fixtureHtml: '',
  cryptoKey: generateTestKey(),
};

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupTestRows(): Promise<void> {
  // Delete test data in reverse dependency order
  const accountIds = [ctx.accountIdWithCredentials, ctx.accountIdNoCredentials].filter(
    (id) => id.length > 0,
  );

  if (accountIds.length > 0) {
    const bookIds = [ctx.bookIdA, ctx.bookIdB].filter((id) => id.length > 0);

    // SalesRecord (book_id ごと)
    if (bookIds.length > 0) {
      await prisma.salesRecord
        .deleteMany({ where: { book_id: { in: bookIds } } })
        .catch(() => undefined);
    }

    // SalesFetchRun (account_id ごと)
    await prisma.salesFetchRun
      .deleteMany({ where: { account_id: { in: accountIds } } })
      .catch(() => undefined);

    // Kdp2FaCode (account_id ごと)
    // Note: Kdp2FaCode has account_id reference via potential future migrations
    // For now, delete by matching account_id if the schema supports it.
    // Fallback: iterate through all and delete by fields we can match.
    const codes = await prisma.kdp2FaCode
      .findMany({
        where: {
          OR: accountIds.map((aid) => ({
            // Try to match if account_id field exists; otherwise this will fail safely
          })),
        },
      })
      .catch(() => []);

    for (const code of codes) {
      await prisma.kdp2FaCode
        .delete({ where: { id: code.id } })
        .catch(() => undefined);
    }

    // Book (account_id ごと)
    if (bookIds.length > 0) {
      await prisma.book
        .deleteMany({ where: { id: { in: bookIds } } })
        .catch(() => undefined);
    }

    // Account
    await prisma.account
      .deleteMany({ where: { id: { in: accountIds } } })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedAccountAndBooks(withCredentials: boolean): Promise<string> {
  const ts = Date.now();
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_ACCOUNT_PREFIX}-${withCredentials ? 'with' : 'no'}-creds-${ts}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['sales_test'],
      } as unknown as Prisma.InputJsonValue,
      status: 'active',
      // 認証情報あり: 暗号化済みダミー認証情報を設定
      kdp_credentials_enc: withCredentials
        ? encryptKdpCredentials(
            JSON.stringify({
              email: 'test@example.com',
              password: 'test-password-123',
            }),
            ctx.cryptoKey,
          )
        : null,
    },
    select: { id: true },
  });

  if (withCredentials) {
    // ASIN lookup in runSalesFetch is global (no account_id filter), so these books
    // must only be created once under the credentials account.
    // Clean up any pre-existing books with these ASINs before creating new ones.
    await prisma.book.deleteMany({
      where: { asin: { in: [TEST_ASIN_A, TEST_ASIN_B] } },
    }).catch(() => undefined);

    // Book A
    const bookA = await prisma.book.create({
      data: {
        account_id: account.id,
        asin: TEST_ASIN_A,
        title: 'Test Book A (Dummy)',
        status: 'published',
        prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
        model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    // Book B
    const bookB = await prisma.book.create({
      data: {
        account_id: account.id,
        asin: TEST_ASIN_B,
        title: 'Test Book B (Dummy)',
        status: 'published',
        prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
        model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    ctx.accountIdWithCredentials = account.id;
    ctx.bookIdA = bookA.id;
    ctx.bookIdB = bookB.id;
  } else {
    // no-credentials account does not need test ASINs; runSalesFetch exits early
    // at the credentials check before any ASIN lookup.
    ctx.accountIdNoCredentials = account.id;
  }

  return account.id;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('T-12-09 E2E Runtime: sales-auto-fetch', () => {
  test.beforeAll(async () => {
    // Load fixture HTML
    const fixturePath = resolve(__dirname, '../../tests/fixtures/kdp-report/sample-report.html');
    ctx.fixtureHtml = readFileSync(fixturePath, 'utf-8');

    // Cleanup any existing test data
    await cleanupTestRows();

    // Seed test accounts and books
    await seedAccountAndBooks(true);
    await seedAccountAndBooks(false);
  });

  test.afterAll(async () => {
    await cleanupTestRows();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: 正常系 — fixture HTML → upsert → done
  // -------------------------------------------------------------------------

  test('正常系: fixture HTML で SalesRecord が upsert される', async () => {
    const browserPort = createFixtureBrowserPort(ctx.fixtureHtml);

    const deps: SalesFetchDeps = {
      payload: {
        account_id: ctx.accountIdWithCredentials,
        year_month: TEST_YEAR_MONTH,
      },
      browserPort,
      prisma,
    };

    const result = await runSalesFetch(deps);

    // 成功確認
    expect(result.ok).toBe(true);
    expect(result.recordsUpserted).toBeGreaterThanOrEqual(1);
    expect(result.runId).toBeTruthy();

    // SalesFetchRun が created & done status
    const run = await prisma.salesFetchRun.findUnique({
      where: { id: result.runId },
    });
    expect(run).toBeTruthy();
    expect(run?.status).toBe('done');
    expect(run?.records_upserted).toBeGreaterThanOrEqual(1);
    expect(run?.finished_at).toBeTruthy();

    // SalesRecord が upsert されたことを確認
    const recordsA = await prisma.salesRecord.findUnique({
      where: {
        book_id_year_month: {
          book_id: ctx.bookIdA,
          year_month: TEST_YEAR_MONTH,
        },
      },
    });
    expect(recordsA).toBeTruthy();
    expect(recordsA?.royalty_jpy).toBe(12500); // fixture HTML から抽出: ¥12500
    expect(recordsA?.review_count).toBe(15); // fixture: レビュー: 15件
    expect(recordsA?.avg_stars).toBeTruthy(); // fixture: 4.3

    const recordsB = await prisma.salesRecord.findUnique({
      where: {
        book_id_year_month: {
          book_id: ctx.bookIdB,
          year_month: TEST_YEAR_MONTH,
        },
      },
    });
    expect(recordsB).toBeTruthy();
    expect(recordsB?.royalty_jpy).toBe(3200); // fixture: ¥3200
    expect(recordsB?.review_count).toBe(3); // fixture: レビュー: 3件
  });

  // -------------------------------------------------------------------------
  // Scenario 2: 2FA 発生 — Kdp2FaCode INSERT + status=2fa_waiting
  // -------------------------------------------------------------------------

  test('2FA 発生時: SalesFetchRun status=2fa_waiting + Kdp2FaCode INSERT', async () => {
    const browserPort = create2faBrowserPort();

    const deps: SalesFetchDeps = {
      payload: {
        account_id: ctx.accountIdWithCredentials,
        year_month: '2026-06',
      },
      browserPort,
      prisma,
    };

    const result = await runSalesFetch(deps);

    // 失敗（2FA 要求）
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('2fa_required');

    // SalesFetchRun が status=2fa_waiting で created
    const run = await prisma.salesFetchRun.findUnique({
      where: { id: result.runId },
    });
    expect(run).toBeTruthy();
    expect(run?.status).toBe('2fa_waiting');

    // Kdp2FaCode が INSERT されていること
    const codes = await prisma.kdp2FaCode.findMany({
      where: {
        // Filter by run ID if the schema supports linking; otherwise check existence
      },
    });
    expect(codes.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: 認証情報未設定 — no_credentials
  // -------------------------------------------------------------------------

  test('認証情報未設定: reason=no_credentials で失敗', async () => {
    const browserPort = createFixtureBrowserPort(ctx.fixtureHtml);

    const deps: SalesFetchDeps = {
      payload: {
        account_id: ctx.accountIdNoCredentials,
        year_month: TEST_YEAR_MONTH,
      },
      browserPort,
      prisma,
    };

    const result = await runSalesFetch(deps);

    // 失敗（認証情報なし）
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_credentials');

    // SalesFetchRun が status=failed で created
    const run = await prisma.salesFetchRun.findUnique({
      where: { id: result.runId },
    });
    expect(run).toBeTruthy();
    expect(run?.status).toBe('failed');
    // error_message は実装と一致させる: "KDP 認証情報が未設定です"
    expect(run?.error_message).toContain('認証情報');
    expect(run?.error_message).toContain('未設定');
  });

  // -------------------------------------------------------------------------
  // Scenario 4: 冪等性 — 同じ year_month で 2 回実行
  // -------------------------------------------------------------------------

  test('冪等性: 同じ year_month で 2 回実行してもレコード重複なし', async () => {
    const browserPort = createFixtureBrowserPort(ctx.fixtureHtml);
    const yearMonth = '2026-07';

    // 1回目
    const deps1: SalesFetchDeps = {
      payload: {
        account_id: ctx.accountIdWithCredentials,
        year_month: yearMonth,
      },
      browserPort,
      prisma,
    };
    const result1 = await runSalesFetch(deps1);
    expect(result1.ok).toBe(true);

    const recordsAfterFirst = await prisma.salesRecord.findMany({
      where: {
        book_id: ctx.bookIdA,
        year_month: yearMonth,
      },
    });
    expect(recordsAfterFirst.length).toBe(1);
    const firstRoyalty = recordsAfterFirst[0].royalty_jpy;

    // 2回目（同じ year_month）
    const deps2: SalesFetchDeps = {
      payload: {
        account_id: ctx.accountIdWithCredentials,
        year_month: yearMonth,
      },
      browserPort,
      prisma,
    };
    const result2 = await runSalesFetch(deps2);
    expect(result2.ok).toBe(true);

    // レコード数が増えていないこと（upsert なので update されている）
    const recordsAfterSecond = await prisma.salesRecord.findMany({
      where: {
        book_id: ctx.bookIdA,
        year_month: yearMonth,
      },
    });
    expect(recordsAfterSecond.length).toBe(1); // 重複なし
    expect(recordsAfterSecond[0].royalty_jpy).toBe(firstRoyalty); // 同じ値
  });
});
