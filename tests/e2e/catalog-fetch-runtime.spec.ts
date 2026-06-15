/**
 * Runtime verification spec for T-02-09 — catalog.fetch (3 provider 単価カタログ取得 + 変動アラート)
 *
 * SP-02 段階では catalog.fetch を呼び出す UI 画面 (Settings 画面のモデル単価表示等) は
 * まだ配線されていない (T-02-09 のスコープは Worker タスク + DB スキーマ + cron 登録)。
 * 通常の Playwright (ブラウザ操作 → DOM 検証) では catalog.fetch の docs/05 §5.3.12
 * セマンティクスを検証できない。代わりに以下を Node ランタイム上で実 PostgreSQL +
 * mock 注入 fetcher に対して直接呼び出して検証する:
 *
 *   1. 初回実行 (existing なし) → ModelCatalog に N 行 INSERT、is_current=true、
 *      `catalog_price_change` Alert 0 件 (初回は比較対象なし)
 *   2. 2 回目実行 (既存 is_current=true 行あり、価格 +15%) → 旧行 is_current=false、
 *      新行 is_current=true、`catalog_price_change` Alert 1 件 INSERT
 *   3. クリーンアップ: テスト用 ModelCatalog + Alert 行を deleteMany
 *   4. Worker cron 登録確認: buildTaskList() (21 件、catalog.fetch + pipeline.theme.generate
 *      [SP-03 T-03-06] 含む) / buildParsedCronItems() (4 件、catalog-fetch-daily 含む)
 *
 * mock 注入 fetcher を使うため:
 *   - cheerio / 実 SDK / 実 HTTP は一切呼ばれない
 *   - コスト ゼロ、ネットワーク 不要 (DB は localhost:5433)
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner
 *     として借用し、@a2p/db / apps/worker のタスクを直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (DATABASE_URL) が前提。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import {
  buildTaskList,
} from '../../apps/worker/src/runner.js';
import {
  buildParsedCronItems,
  CRON_ITEMS,
} from '../../apps/worker/src/crontab.js';
import {
  CATALOG_FETCH_TASK_NAME,
  runCatalogFetch,
  type Provider,
  type ProviderFetcher,
  type ProviderPricingEntry,
} from '../../apps/worker/src/tasks/catalog-fetch.js';

// テスト用に隔離されたモデル ID (本物の claude-opus-4-7 等とは別空間)。
// クリーンアップは provider + model prefix で行うため、prefix が衝突しないこと。
const TEST_MODEL_PREFIX = 'e2e-test-';
const TEST_ANTHROPIC_MODEL = `${TEST_MODEL_PREFIX}claude-opus-foo`;
const TEST_OPENAI_MODEL = `${TEST_MODEL_PREFIX}gpt-foo`;
const TEST_GOOGLE_MODEL = `${TEST_MODEL_PREFIX}gemini-foo`;

/** mock fetcher: 与えられた pricing をそのまま返す。 */
function makeMockFetcher(
  provider: Provider,
  pricing: ProviderPricingEntry[],
): ProviderFetcher {
  return async () => ({
    provider,
    ok: true,
    pricing,
    modelIdsFromSdk: pricing.map((p) => p.model),
    source: defaultSource(provider),
  });
}

function defaultSource(provider: Provider): string {
  switch (provider) {
    case 'anthropic':
      return 'anthropic_pricing_page_v1';
    case 'openai':
      return 'openai_pricing_v2';
    case 'google':
      return 'google_pricing_v1';
  }
}

async function cleanupTestRows(): Promise<void> {
  // ModelCatalog: e2e-test-* prefix モデルを全削除
  await prisma.modelCatalog
    .deleteMany({
      where: {
        model: { startsWith: TEST_MODEL_PREFIX },
      },
    })
    .catch(() => undefined);

  // Alert: payload_json.model が e2e-test-* で始まる catalog_price_change / catalog_fetch_failed を削除
  // payload_json は JSON path クエリで filter
  for (const model of [TEST_ANTHROPIC_MODEL, TEST_OPENAI_MODEL, TEST_GOOGLE_MODEL]) {
    await prisma.alert
      .deleteMany({
        where: {
          kind: 'catalog_price_change',
          payload_json: { path: ['model'], equals: model },
        },
      })
      .catch(() => undefined);
  }
}

test.describe('runtime: catalog.fetch (T-02-09)', () => {
  // 実 DB I/O が走るが mock fetcher なので 30s で十分
  test.setTimeout(30_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. 初回実行: ModelCatalog INSERT のみ、Alert 0 件
  // -------------------------------------------------------------------------
  test('first run: 3 provider の mock pricing → ModelCatalog 3 行 INSERT (is_current=true), price_change Alert 0 件', async () => {
    const firstRunDeps = {
      getApiKeyImpl: async () => 'sk-e2e-mock',
      providerFetchers: {
        anthropic: makeMockFetcher('anthropic', [
          {
            model: TEST_ANTHROPIC_MODEL,
            input_price_per_mtok_usd: 15.0,
            output_price_per_mtok_usd: 75.0,
          },
        ]),
        openai: makeMockFetcher('openai', [
          {
            model: TEST_OPENAI_MODEL,
            input_price_per_mtok_usd: 2.5,
            output_price_per_mtok_usd: 10.0,
          },
        ]),
        google: makeMockFetcher('google', [
          {
            model: TEST_GOOGLE_MODEL,
            input_price_per_mtok_usd: 1.25,
            output_price_per_mtok_usd: 10.0,
          },
        ]),
      },
    };

    const result = await runCatalogFetch(firstRunDeps);

    expect(result.ok).toBe(true);
    expect(result.providers.anthropic.ok).toBe(true);
    expect(result.providers.openai.ok).toBe(true);
    expect(result.providers.google.ok).toBe(true);
    // 初回は alert 0 件
    expect(result.providers.anthropic.priceChangeAlertCount).toBe(0);
    expect(result.providers.openai.priceChangeAlertCount).toBe(0);
    expect(result.providers.google.priceChangeAlertCount).toBe(0);

    // DB 検証: 3 行 INSERT (is_current=true)
    const rows = await prisma.modelCatalog.findMany({
      where: { model: { startsWith: TEST_MODEL_PREFIX } },
    });
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.is_current).toBe(true);
      // fx_rate は AppSettings 値 (or fallback 150) — どちらにせよ正の Decimal
      expect(Number(r.fx_rate_usd_jpy.toString())).toBeGreaterThan(0);
    }

    // anthropic 行の単価が初回値であること
    const anth = rows.find((r) => r.model === TEST_ANTHROPIC_MODEL);
    expect(anth).toBeDefined();
    expect(Number(anth!.input_price_per_mtok_usd.toString())).toBe(15.0);
    expect(Number(anth!.output_price_per_mtok_usd.toString())).toBe(75.0);

    // 初回 alert 0 件 (catalog_price_change kind で test model 対象のもの)
    for (const model of [TEST_ANTHROPIC_MODEL, TEST_OPENAI_MODEL, TEST_GOOGLE_MODEL]) {
      const alerts = await prisma.alert.findMany({
        where: {
          kind: 'catalog_price_change',
          payload_json: { path: ['model'], equals: model },
        },
      });
      expect(alerts.length).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // 2. 2 回目実行: +15% で alert 発火
  // -------------------------------------------------------------------------
  test('second run: anthropic 価格 +15% → 旧行 is_current=false, 新行 is_current=true, catalog_price_change Alert 1 件', async () => {
    // sendEmail を mock (テスト中に実 Resend を叩かないため)
    const sendEmailMock = (async () => ({ id: 'mock-mail-id' })) as unknown as
      Parameters<typeof runCatalogFetch>[0] extends infer T
        ? T extends { sendEmailImpl?: infer S }
          ? S
          : never
        : never;

    const secondRunDeps = {
      getApiKeyImpl: async () => 'sk-e2e-mock',
      sendEmailImpl: sendEmailMock,
      providerFetchers: {
        // anthropic: input +15% (15.0 → 17.25), output 据え置き
        anthropic: makeMockFetcher('anthropic', [
          {
            model: TEST_ANTHROPIC_MODEL,
            input_price_per_mtok_usd: 17.25, // +15%
            output_price_per_mtok_usd: 75.0,
          },
        ]),
        // openai / google は同価格 → alert 発火しない
        openai: makeMockFetcher('openai', [
          {
            model: TEST_OPENAI_MODEL,
            input_price_per_mtok_usd: 2.5,
            output_price_per_mtok_usd: 10.0,
          },
        ]),
        google: makeMockFetcher('google', [
          {
            model: TEST_GOOGLE_MODEL,
            input_price_per_mtok_usd: 1.25,
            output_price_per_mtok_usd: 10.0,
          },
        ]),
      },
    };

    const result = await runCatalogFetch(secondRunDeps);

    expect(result.ok).toBe(true);
    expect(result.providers.anthropic.priceChangeAlertCount).toBe(1);
    expect(result.providers.openai.priceChangeAlertCount).toBe(0);
    expect(result.providers.google.priceChangeAlertCount).toBe(0);

    // DB 検証: anthropic test model の行は 2 行 (旧 is_current=false + 新 is_current=true)
    const anthRows = await prisma.modelCatalog.findMany({
      where: { model: TEST_ANTHROPIC_MODEL },
      orderBy: { fetched_at: 'asc' },
    });
    expect(anthRows.length).toBe(2);
    expect(anthRows[0]!.is_current).toBe(false);
    expect(Number(anthRows[0]!.input_price_per_mtok_usd.toString())).toBe(15.0);
    expect(anthRows[1]!.is_current).toBe(true);
    expect(Number(anthRows[1]!.input_price_per_mtok_usd.toString())).toBe(17.25);

    // openai / google は同価格でも upsert (history 取りのため) → 2 行ずつ
    const oaiRows = await prisma.modelCatalog.findMany({
      where: { model: TEST_OPENAI_MODEL },
    });
    expect(oaiRows.length).toBe(2);
    const oaiCurrentCount = oaiRows.filter((r) => r.is_current).length;
    expect(oaiCurrentCount).toBe(1); // 必ず最新のみ is_current

    // alert: anthropic 用 catalog_price_change が 1 件 INSERT
    const alerts = await prisma.alert.findMany({
      where: {
        kind: 'catalog_price_change',
        payload_json: { path: ['model'], equals: TEST_ANTHROPIC_MODEL },
      },
    });
    expect(alerts.length).toBe(1);
    const a = alerts[0]!;
    expect(a.severity).toBe('warning');
    const payload = a.payload_json as Record<string, unknown>;
    expect(payload.provider).toBe('anthropic');
    expect(payload.model).toBe(TEST_ANTHROPIC_MODEL);
    const before = payload.before as Record<string, number>;
    const after = payload.after as Record<string, number>;
    expect(before.input_price_per_mtok_usd).toBe(15.0);
    expect(after.input_price_per_mtok_usd).toBe(17.25);
    const deltaPct = payload.delta_pct as Record<string, number>;
    // input +15% (14 < x < 16 の範囲)
    expect(deltaPct.input).toBeGreaterThan(14);
    expect(deltaPct.input).toBeLessThan(16);

    // 他 2 provider 用 alert は無い
    for (const model of [TEST_OPENAI_MODEL, TEST_GOOGLE_MODEL]) {
      const others = await prisma.alert.findMany({
        where: {
          kind: 'catalog_price_change',
          payload_json: { path: ['model'], equals: model },
        },
      });
      expect(others.length).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Worker 登録確認: buildTaskList / buildParsedCronItems
  // -------------------------------------------------------------------------
  test('worker: buildTaskList に catalog.fetch を含む 23 タスクが登録されている', () => {
    const tasks = buildTaskList();
    const taskNames = Object.keys(tasks);
    // 23 件 (docs/05 §2 の 19 件 + locks.sweep [SP-02 T-02-07] +
    // pipeline.theme.generate [SP-03 T-03-06] + batch_plan.dispatcher [SP-03 T-03-10] +
    // pipeline.book.writer.chapters.dispatch [SP-04 T-04-05])
    expect(taskNames.length).toBe(23);
    expect(taskNames).toContain(CATALOG_FETCH_TASK_NAME);
    expect(taskNames).toContain('pipeline.book.writer.chapters.dispatch');
    expect(CATALOG_FETCH_TASK_NAME).toBe('catalog.fetch');
  });

  test('worker: buildParsedCronItems に catalog-fetch-daily を含む 6 件の cron が登録されている', () => {
    const parsed = buildParsedCronItems();
    // SP-09 T-09-04 で archive-jobs-weekly が追加され 6 件
    //   (T-07-11 で standalone locks-sweep-hourly は削除済み)。
    expect(parsed.length).toBe(6);

    const identifiers = CRON_ITEMS.map((c) => c.identifier);
    expect(identifiers).toEqual(
      expect.arrayContaining([
        'archive-db-backup-weekly',
        'fx-fetch-daily',
        'catalog-fetch-daily',
        'batch-plan-dispatcher-minute',
        'alert-cost-check-hourly',
        'archive-jobs-weekly',
      ]),
    );

    const catalogItem = CRON_ITEMS.find((c) => c.identifier === 'catalog-fetch-daily');
    expect(catalogItem).toBeDefined();
    expect(catalogItem!.task).toBe(CATALOG_FETCH_TASK_NAME);
    // env MODEL_CATALOG_FETCH_CRON (既定 0 19 * * *) で resolve される
    expect(typeof catalogItem!.match).toBe('string');
    expect((catalogItem!.match as string).trim().length).toBeGreaterThan(0);
    expect(catalogItem!.payload).toEqual({ trigger: 'cron' });
  });
});
