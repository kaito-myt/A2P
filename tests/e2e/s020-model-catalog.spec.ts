/**
 * E2E: S-020 モデル単価カタログ画面 (T-02-10 / F-024 + F-025)
 *
 * 検証する 7 ケース:
 *   a. /models/catalog 遷移 + 画面表示
 *   b. テーブルに seed 行表示 + 列順序
 *   c. provider フィルタ動作 (anthropic 選択 → openai/google 行非表示)
 *   d. CSV エクスポートボタン → ダウンロード発火 + ファイル名 + 内容検証
 *   e. 手動更新ボタン → SA 成功トースト + graphile_worker.jobs に catalog.fetch INSERT
 *   f. 編集 Drawer → 単価編集 → 保存 → トーストと値反映
 *   g. 価格変動履歴セクション表示
 *
 * 前提:
 *   - storageState は global.setup.ts が認証済みで保存済
 *   - PostgreSQL (Docker a2p-pg port 5433) 稼働中
 *   - apps/worker は起動していない (= enqueue 後ジョブは graphile_worker._private_jobs に滞留)
 *
 * テストデータ:
 *   - 3 provider × 2 model = 6 行を beforeAll で投入し、afterAll で清掃
 *   - 既存 (本番 seed) の ModelCatalog 行は触らない: model 名に `e2e-s020-` prefix を付与
 *   - Alert は `kind=catalog_price_change` で「テスト印」を payload に埋め、afterAll で削除
 */
import { test, expect, type Page } from '@playwright/test';

import { prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const E2E_MODEL_PREFIX = 'e2e-s020-';

// 投入する 6 行 (provider × 2 model)
const SEED_ROWS = [
  {
    provider: 'anthropic',
    model: `${E2E_MODEL_PREFIX}claude-opus-foo`,
    input_price_per_mtok_usd: 15.0,
    output_price_per_mtok_usd: 75.0,
    image_price_per_image_usd: null as number | null,
    source: 'anthropic_pricing_page_v1',
  },
  {
    provider: 'anthropic',
    model: `${E2E_MODEL_PREFIX}claude-sonnet-foo`,
    input_price_per_mtok_usd: 3.0,
    output_price_per_mtok_usd: 15.0,
    image_price_per_image_usd: null,
    source: 'anthropic_pricing_page_v1',
  },
  {
    provider: 'openai',
    model: `${E2E_MODEL_PREFIX}gpt-foo`,
    input_price_per_mtok_usd: 2.5,
    output_price_per_mtok_usd: 10.0,
    image_price_per_image_usd: null,
    source: 'openai_pricing_v2',
  },
  {
    provider: 'openai',
    model: `${E2E_MODEL_PREFIX}gpt-img-foo`,
    input_price_per_mtok_usd: 0,
    output_price_per_mtok_usd: 0,
    image_price_per_image_usd: 0.04,
    source: 'openai_pricing_v2',
  },
  {
    provider: 'google',
    model: `${E2E_MODEL_PREFIX}gemini-foo`,
    input_price_per_mtok_usd: 1.25,
    output_price_per_mtok_usd: 10.0,
    image_price_per_image_usd: null,
    source: 'google_pricing_v1',
  },
  {
    provider: 'google',
    model: `${E2E_MODEL_PREFIX}gemini-flash-foo`,
    input_price_per_mtok_usd: 0.35,
    output_price_per_mtok_usd: 1.05,
    image_price_per_image_usd: null,
    source: 'google_pricing_v1',
  },
];

// 履歴セクション検証用 Alert (payload は PriceChangeHistory の zod schema 準拠)
const HISTORY_ALERT_PAYLOAD = {
  provider: 'anthropic',
  model: `${E2E_MODEL_PREFIX}claude-opus-foo`,
  before: {
    input_price_per_mtok_usd: 15.0,
    output_price_per_mtok_usd: 75.0,
  },
  after: {
    input_price_per_mtok_usd: 17.25, // +15%
    output_price_per_mtok_usd: 75.0,
  },
  delta_pct: {
    input: 15.0,
    output: 0,
  },
  _e2e_marker: 's020-spec',
} as const;

async function cleanupS020Data(): Promise<void> {
  await prisma.modelCatalog
    .deleteMany({ where: { model: { startsWith: E2E_MODEL_PREFIX } } })
    .catch(() => undefined);

  // テストが投入した Alert (_e2e_marker で見分け)
  await prisma.alert
    .deleteMany({
      where: {
        kind: 'catalog_price_change',
        payload_json: { path: ['_e2e_marker'], equals: 's020-spec' },
      },
    })
    .catch(() => undefined);

  // 手動更新ボタンの SA が enqueue した graphile-worker ジョブを掃除
  // graphile-worker のテーブルは _private_jobs (0.16+)。失敗しても致命ではない。
  await prisma
    .$executeRawUnsafe(
      "DELETE FROM graphile_worker._private_jobs WHERE task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = 'catalog.fetch')",
    )
    .catch(() => undefined);
}

async function seedCatalog(): Promise<void> {
  for (const r of SEED_ROWS) {
    await prisma.modelCatalog.create({
      data: {
        provider: r.provider,
        model: r.model,
        input_price_per_mtok_usd: r.input_price_per_mtok_usd as unknown as number,
        output_price_per_mtok_usd: r.output_price_per_mtok_usd as unknown as number,
        image_price_per_image_usd:
          r.image_price_per_image_usd === null
            ? null
            : (r.image_price_per_image_usd as unknown as number),
        fx_rate_usd_jpy: 150 as unknown as number,
        source: r.source,
        raw_json: {} as unknown as Record<string, unknown>,
        is_current: true,
      },
    });
  }

  await prisma.alert.create({
    data: {
      kind: 'catalog_price_change',
      severity: 'warning',
      payload_json: HISTORY_ALERT_PAYLOAD as unknown as Record<string, unknown>,
    },
  });
}

async function countCatalogFetchJobs(): Promise<number> {
  // _private_jobs にあるか確認 (worker 起動していないので enqueue 後は滞留する)
  const rows = await prisma
    .$queryRawUnsafe<{ c: bigint }[]>(
      "SELECT count(*)::bigint AS c FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'catalog.fetch'",
    )
    .catch(() => [] as { c: bigint }[]);
  if (rows.length === 0) return 0;
  return Number(rows[0]!.c);
}

async function gotoCatalogPage(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard-root')).toBeVisible();
  // サイドバーから「モデルカタログ」リンクをクリック
  await page.getByTestId('sidebar-nav').getByRole('link', { name: 'モデルカタログ' }).click();
  await page.waitForURL(/\/models\/catalog$/);
  await expect(page.getByTestId('catalog-table').first()).toBeVisible();
}

test.describe('S-020: モデル単価カタログ画面 (T-02-10)', () => {
  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS020Data();
    await seedCatalog();
  });

  test.afterAll(async () => {
    await cleanupS020Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // a. 遷移 + 画面表示
  // -------------------------------------------------------------------------
  test('a. サイドバー → /models/catalog 遷移 + catalog-table 可視', async ({ page }) => {
    await gotoCatalogPage(page);
    // テーブル + 履歴セクションが共に可視
    await expect(page.getByTestId('catalog-table').first()).toBeVisible();
    await expect(page.getByTestId('price-change-history')).toBeVisible();
    // 主要ボタンの存在
    await expect(page.getByTestId('catalog-csv-export')).toBeVisible();
    await expect(page.getByTestId('catalog-refresh-button')).toBeVisible();
    await expect(page.getByTestId('catalog-provider-filter')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // b. seed 行表示 + 列順序確認
  // -------------------------------------------------------------------------
  test('b. seed 投入した 6 行が catalog-row-{provider}-{model} で表示される', async ({ page }) => {
    await page.goto('/models/catalog');
    await expect(page.getByTestId('catalog-table').first()).toBeVisible();

    for (const r of SEED_ROWS) {
      const row = page.getByTestId(`catalog-row-${r.provider}-${r.model}`);
      await expect(row).toBeVisible();
    }

    // ヘッダー列順序: provider, model, 入力, 出力, 1冊予測, 更新日時, ソース, 前回比, アクション
    const headers = await page
      .locator('thead tr th')
      .first()
      .locator('xpath=..')
      .locator('th')
      .allTextContents();
    // 1 行目のヘッダー (テーブルは複数 thead があり得ないが先頭を採用)
    expect(headers[0]).toContain('プロバイダ');
    expect(headers[1]).toContain('モデル');
    expect(headers[2]).toContain('入力単価');
    expect(headers[3]).toContain('出力単価');
    expect(headers[4]).toContain('1 冊予測コスト');
    expect(headers[5]).toContain('更新日時');
    expect(headers[6]).toContain('ソース');
    expect(headers[7]).toContain('前回比');
    expect(headers[8]).toContain('アクション');
  });

  // -------------------------------------------------------------------------
  // c. provider フィルタ動作
  // -------------------------------------------------------------------------
  test('c. provider フィルタで anthropic 選択 → openai/google 行非表示', async ({ page }) => {
    await page.goto('/models/catalog');
    await expect(page.getByTestId('catalog-table').first()).toBeVisible();

    // フィルタを anthropic に設定
    await page.getByTestId('catalog-provider-filter').selectOption('anthropic');

    // anthropic 行: 可視
    await expect(
      page.getByTestId(`catalog-row-anthropic-${E2E_MODEL_PREFIX}claude-opus-foo`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`catalog-row-anthropic-${E2E_MODEL_PREFIX}claude-sonnet-foo`),
    ).toBeVisible();

    // openai 行: 非表示 (count === 0)
    await expect(
      page.getByTestId(`catalog-row-openai-${E2E_MODEL_PREFIX}gpt-foo`),
    ).toHaveCount(0);
    await expect(
      page.getByTestId(`catalog-row-google-${E2E_MODEL_PREFIX}gemini-foo`),
    ).toHaveCount(0);

    // 全て に戻すと再表示
    await page.getByTestId('catalog-provider-filter').selectOption('all');
    await expect(
      page.getByTestId(`catalog-row-openai-${E2E_MODEL_PREFIX}gpt-foo`),
    ).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // d. CSV エクスポート
  // -------------------------------------------------------------------------
  test('d. CSV エクスポートボタン → ダウンロード発火 + ファイル名 + 列順序 + BOM', async ({
    page,
  }) => {
    await page.goto('/models/catalog');
    await expect(page.getByTestId('catalog-table').first()).toBeVisible();

    // CsvExportButton は window.location.href を書き換える実装。
    // ファイル download 自体は Playwright が捕捉してくれる (Content-Disposition: attachment 付与)。
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('catalog-csv-export').click(),
    ]);

    // ファイル名: model-catalog-YYYY-MM-DD.csv
    expect(download.suggestedFilename()).toMatch(/^model-catalog-\d{4}-\d{2}-\d{2}\.csv$/);

    // 中身を読む
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);

    // UTF-8 BOM (EF BB BF)
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);

    const text = buf.toString('utf-8');
    // BOM を除去した残りの先頭行 = ヘッダー
    const noBom = text.replace(/^﻿/, '');
    const firstLine = noBom.split('\r\n')[0];
    expect(firstLine).toBe(
      'provider,model,input_price_usd,output_price_usd,image_price_usd,fx_rate,fetched_at,source',
    );

    // 我々が投入した anthropic 行が含まれる
    expect(noBom).toContain(`anthropic,${E2E_MODEL_PREFIX}claude-opus-foo,`);
    expect(noBom).toContain(`openai,${E2E_MODEL_PREFIX}gpt-foo,`);
    expect(noBom).toContain(`google,${E2E_MODEL_PREFIX}gemini-foo,`);

    // CRLF 行終端
    expect(noBom).toContain('\r\n');
  });

  // -------------------------------------------------------------------------
  // e. 手動更新ボタン
  // -------------------------------------------------------------------------
  test('e. 手動更新ボタン → 成功表示 + graphile_worker.jobs に catalog.fetch ジョブ INSERT', async ({
    page,
  }) => {
    // 事前: 既存の catalog.fetch ジョブをクリーン
    await prisma
      .$executeRawUnsafe(
        "DELETE FROM graphile_worker._private_jobs WHERE task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = 'catalog.fetch')",
      )
      .catch(() => undefined);
    const before = await countCatalogFetchJobs();

    await page.goto('/models/catalog');
    await expect(page.getByTestId('catalog-refresh-button')).toBeVisible();

    await page.getByTestId('catalog-refresh-button').click();

    // SA が成功すると inline メッセージで「カタログ取得を開始しました...」
    // 注: ページ全体には他にも role="status" を持つ要素 (Header の CostMeter) があるため、
    // refresh-button と同じ親 (flex flex-col items-end) 内の <p role="status"> に限定する。
    const refreshContainer = page.getByTestId('catalog-refresh-button').locator('..');
    const status = refreshContainer.getByRole('status');
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status).toContainText('カタログ取得を開始しました');

    // graphile_worker に enqueue されているか確認
    const after = await countCatalogFetchJobs();
    expect(after - before).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // f. 編集 Drawer
  // -------------------------------------------------------------------------
  test('f. 編集 Drawer → 入力単価変更 → 保存 → 値反映 + source が manual_edit_v1', async ({
    page,
  }) => {
    await page.goto('/models/catalog');
    await expect(page.getByTestId('catalog-table').first()).toBeVisible();

    // 編集対象: gpt-foo 行
    const targetProvider = 'openai';
    const targetModel = `${E2E_MODEL_PREFIX}gpt-foo`;

    // 編集ボタンの testid は `catalog-edit-button-{id}` (id は DB 上の cuid)。
    // 該当行の中で editButton を探す (testid は動的なので "catalog-edit-button-" prefix で正規表現マッチ)。
    const row = page.getByTestId(`catalog-row-${targetProvider}-${targetModel}`);
    await expect(row).toBeVisible();
    const editButton = row.locator('[data-testid^="catalog-edit-button-"]');
    await expect(editButton).toBeVisible();
    await editButton.click();

    // Drawer = native <dialog>。Playwright の dialog ロケータが効くが、ID で input を直接掴むのが堅い。
    // EditCatalogDrawer の input id は `input-{row.id}`、`output-{row.id}` の形。
    // → name 属性は無いので、開いた dialog 内の type=number 入力を順序で掴む。
    const numberInputs = page.locator('dialog[open] input[type="number"]');
    await expect(numberInputs.first()).toBeVisible();
    // 入力単価フィールド (1 つ目) を新値に変更
    await numberInputs.nth(0).fill('5');
    // 出力単価 (2 つ目) は据え置きでも OK だが、フォーカスを当てて値が読まれることを確認
    await numberInputs.nth(1).fill('12');

    // 保存ボタン (dialog 内、type=submit)
    await page.locator('dialog[open] button[type="submit"]').click();

    // 保存後 dialog は close(), router.refresh() が走り RSC 再評価
    await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 10_000 });

    // DB 直接確認: source が manual_edit_v1 / input_price = 5 / output_price = 12
    const updated = await prisma.modelCatalog.findFirst({
      where: { provider: targetProvider, model: targetModel, is_current: true },
    });
    expect(updated).not.toBeNull();
    expect(updated!.source).toBe('manual_edit_v1');
    expect(Number(updated!.input_price_per_mtok_usd.toString())).toBe(5);
    expect(Number(updated!.output_price_per_mtok_usd.toString())).toBe(12);

    // 画面再評価後にテーブル内の数値が反映 (入力単価: pricePer1k 表示 = $0.0050)
    // テーブルは router.refresh() で再フェッチされるが、Playwright は server action 後の
    // partial revalidation を待ってくれないことがある。明示的に再ロード。
    await page.reload();
    await expect(page.getByTestId('catalog-table').first()).toBeVisible();
    const updatedRow = page.getByTestId(`catalog-row-${targetProvider}-${targetModel}`);
    await expect(updatedRow).toContainText('$0.0050');
    await expect(updatedRow).toContainText('manual_edit_v1');
  });

  // -------------------------------------------------------------------------
  // g. 価格変動履歴セクション
  // -------------------------------------------------------------------------
  test('g. price-change-history セクションに seed Alert (+15%) が表示される', async ({
    page,
  }) => {
    await page.goto('/models/catalog');
    const history = page.getByTestId('price-change-history');
    await expect(history).toBeVisible();

    // 履歴テーブルが描画されている (空メッセージではない)
    await expect(history.locator('table')).toBeVisible();

    // seed した anthropic 行が表示されている (provider 列 = "anthropic", model 列 = e2e prefix)
    await expect(history).toContainText('anthropic');
    await expect(history).toContainText(`${E2E_MODEL_PREFIX}claude-opus-foo`);
    // 変動率 +15.0% (input 15 → 17.25)
    await expect(history).toContainText('+15.0%');
  });
});
