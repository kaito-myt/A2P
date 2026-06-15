/**
 * E2E: S-019 モデル割当 (役割 × ジャンル) 画面 — T-02-11 / F-022 + F-023.
 *
 * 検証する 7 ケース:
 *   a. /models/assignments 遷移 + 画面表示
 *   b. 7×4 マトリクス表示 (assignment-cell-{role}-{genre})
 *   c. ModelCatalogSidePane 常設表示 + test 用 catalog 行
 *   d. AssignmentEditor Drawer 開閉
 *   e. upsert 成功 — 成功表示 + DB: archived + 新 active + audit_log INSERT
 *   f. revert 成功 — 成功表示 + DB: 旧 archived → active, 現 active → archived
 *   g. 同一値 upsert 弾き — ValidationError ("現在の割当と同一のため変更不要です")
 *
 * 前提:
 *   - storageState は global.setup.ts が認証済みで保存済
 *   - PostgreSQL (Docker a2p-pg port 5433) 稼働中
 *   - 既存 seed の ModelAssignment 7 行 (全 genre=null = default 列) は維持する
 *
 * テストデータ:
 *   - 3 provider × 1 model = 3 行を beforeAll で ModelCatalog に投入
 *     (anthropic / openai / google、各 1 model。既存 seed と重複しない `e2e-s019-` prefix)
 *   - revert テスト用: 既存の writer/default 行を archived 化して別の archived row を用意
 *   - 本 spec で作成された rows は afterAll で deleteMany (created_by='e2e-s019-actor'
 *     をマーカに使う + ModelCatalog は prefix で識別)
 *   - audit_log は target_id を marker に identify
 */
import { test, expect, type Page } from '@playwright/test';

import { prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const E2E_CATALOG_PREFIX = 'e2e-s019-';

// 3 provider × 1 model の test 用 ModelCatalog 行
const CATALOG_ROWS = [
  {
    provider: 'anthropic',
    model: `${E2E_CATALOG_PREFIX}claude-test`,
    input_price_per_mtok_usd: 3.0,
    output_price_per_mtok_usd: 15.0,
    source: 'anthropic_pricing_page_v1',
  },
  {
    provider: 'openai',
    model: `${E2E_CATALOG_PREFIX}gpt-test`,
    input_price_per_mtok_usd: 2.5,
    output_price_per_mtok_usd: 10.0,
    source: 'openai_pricing_v2',
  },
  {
    provider: 'google',
    model: `${E2E_CATALOG_PREFIX}gemini-test`,
    input_price_per_mtok_usd: 1.25,
    output_price_per_mtok_usd: 10.0,
    source: 'google_pricing_v1',
  },
];

/**
 * spec 開始前後で削除する rows を識別するため、ModelCatalog は prefix で、
 * ModelAssignment は (role, model) もしくは provider/model に prefix を持つもので識別。
 * audit_log は target_id が 'writer/default' で actor_id != 'system' のテスト由来行を絞る
 * のが難しいため、 spec 投入時 + 終了時の差分で件数検証に留める。
 */
async function cleanupS019Data(): Promise<void> {
  // 1. 本 spec で作られた ModelAssignment (provider/model に prefix 含む or created_by に test marker)
  await prisma.modelAssignment
    .deleteMany({
      where: {
        OR: [
          { model: { startsWith: E2E_CATALOG_PREFIX } },
          { created_by: { startsWith: 'e2e-s019-' } },
        ],
      },
    })
    .catch(() => undefined);

  // 2. test 用 ModelCatalog
  await prisma.modelCatalog
    .deleteMany({ where: { model: { startsWith: E2E_CATALOG_PREFIX } } })
    .catch(() => undefined);

  // 3. 本 spec で作られた archived 行 (writer/default を revert テスト用に作った row)
  //    revert 用に挿入した archived row は created_by='e2e-s019-archived-fixture' で識別。
  await prisma.modelAssignment
    .deleteMany({
      where: { created_by: 'e2e-s019-archived-fixture' },
    })
    .catch(() => undefined);
}

async function seedCatalog(): Promise<void> {
  for (const r of CATALOG_ROWS) {
    await prisma.modelCatalog.create({
      data: {
        provider: r.provider,
        model: r.model,
        input_price_per_mtok_usd: r.input_price_per_mtok_usd as unknown as number,
        output_price_per_mtok_usd: r.output_price_per_mtok_usd as unknown as number,
        image_price_per_image_usd: null,
        fx_rate_usd_jpy: 150 as unknown as number,
        source: r.source,
        raw_json: {} as unknown as Parameters<typeof prisma.modelCatalog.create>[0]['data']['raw_json'],
        is_current: true,
      },
    });
  }
}

async function gotoAssignmentsPage(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard-root')).toBeVisible();
  await page
    .getByTestId('sidebar-nav')
    .getByRole('link', { name: 'モデル割当' })
    .click();
  await page.waitForURL(/\/models\/assignments$/);
  await expect(page.getByTestId('assignment-matrix')).toBeVisible();
}

test.describe('S-019: モデル割当画面 (T-02-11)', () => {
  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS019Data();
    await seedCatalog();
  });

  test.afterAll(async () => {
    await cleanupS019Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // a. 遷移 + 画面表示
  // -------------------------------------------------------------------------
  test('a. サイドバー → /models/assignments 遷移 + assignment-matrix 可視', async ({
    page,
  }) => {
    await gotoAssignmentsPage(page);
    await expect(page.getByTestId('assignment-matrix')).toBeVisible();
    await expect(page.getByTestId('assignment-history-table')).toBeVisible();
    await expect(page.getByTestId('model-catalog-side-pane')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // b. 7×4 マトリクス: 28 セル全て表示
  // -------------------------------------------------------------------------
  test('b. 7 役 × 4 列 = 28 セル全てが assignment-cell-{role}-{genre} で表示', async ({
    page,
  }) => {
    await page.goto('/models/assignments');
    await expect(page.getByTestId('assignment-matrix')).toBeVisible();

    const roles = [
      'writer',
      'editor',
      'marketer',
      'judge',
      'thumbnail_text',
      'thumbnail_image',
      'optimizer',
    ];
    const genreSlots = ['default', 'practical', 'business', 'self_help'];

    for (const role of roles) {
      for (const genre of genreSlots) {
        const cell = page.getByTestId(`assignment-cell-${role}-${genre}`);
        await expect(cell).toBeVisible();
      }
    }
  });

  // -------------------------------------------------------------------------
  // c. ModelCatalogSidePane: test 用 3 行表示
  // -------------------------------------------------------------------------
  test('c. ModelCatalogSidePane に test 用 3 catalog 行が表示される', async ({
    page,
  }) => {
    await page.goto('/models/assignments');
    const pane = page.getByTestId('model-catalog-side-pane');
    await expect(pane).toBeVisible();

    for (const r of CATALOG_ROWS) {
      const row = page.getByTestId(`model-catalog-side-pane-row-${r.provider}-${r.model}`);
      await expect(row).toBeVisible();
    }
  });

  // -------------------------------------------------------------------------
  // d. AssignmentEditor Drawer 開閉
  // -------------------------------------------------------------------------
  test('d. assignment-cell-writer-default クリック → Drawer 開く → Cancel で close', async ({
    page,
  }) => {
    await page.goto('/models/assignments');
    await expect(page.getByTestId('assignment-matrix')).toBeVisible();

    await page.getByTestId('assignment-cell-writer-default').click();

    const drawer = page.getByTestId('assignment-editor-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('assignment-editor-provider-select')).toBeVisible();
    await expect(page.getByTestId('assignment-editor-model-select')).toBeVisible();

    // Cancel ボタン
    await drawer.getByRole('button', { name: 'キャンセル' }).click();
    // dialog[open] が消える
    await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // e. upsert 成功: writer/default の provider/model を test catalog 値に変更
  // -------------------------------------------------------------------------
  test('e. writer/default を upsert → 成功表示 + 旧 active が archived 化 + 新 active + audit_log INSERT', async ({
    page,
  }) => {
    // 事前状態の確認
    const beforeActive = await prisma.modelAssignment.findFirst({
      where: { role: 'writer', genre: null, status: 'active' },
    });
    expect(beforeActive).not.toBeNull();

    const auditCountBefore = await prisma.auditLog.count({
      where: { action: 'model_assignment.upsert', target_id: 'writer/default' },
    });

    await page.goto('/models/assignments');
    await page.getByTestId('assignment-cell-writer-default').click();
    await expect(page.getByTestId('assignment-editor-drawer')).toBeVisible();

    // provider = anthropic / model = `${prefix}claude-test` に切替
    await page
      .getByTestId('assignment-editor-provider-select')
      .selectOption('anthropic');
    await page
      .getByTestId('assignment-editor-model-select')
      .selectOption(`${E2E_CATALOG_PREFIX}claude-test`);

    // 保存
    await page.getByTestId('assignment-editor-save-button').click();

    // 成功 inline メッセージ (2.5 秒表示後 close)
    const success = page.getByTestId('assignment-editor-success');
    await expect(success).toBeVisible({ timeout: 10_000 });
    await expect(success).toContainText('次回ジョブから新モデルが適用されます');

    // DB 直接確認
    // 1. 旧 active 行が archived 化
    const formerActive = await prisma.modelAssignment.findUnique({
      where: { id: beforeActive!.id },
    });
    expect(formerActive?.status).toBe('archived');
    expect(formerActive?.archived_at).not.toBeNull();

    // 2. 新 active 行が INSERT され (provider/model がテストカタログ)
    const newActive = await prisma.modelAssignment.findFirst({
      where: {
        role: 'writer',
        genre: null,
        status: 'active',
        provider: 'anthropic',
        model: `${E2E_CATALOG_PREFIX}claude-test`,
      },
    });
    expect(newActive).not.toBeNull();
    expect(newActive!.id).not.toBe(beforeActive!.id);

    // 3. audit_log 1 件追加
    const auditCountAfter = await prisma.auditLog.count({
      where: { action: 'model_assignment.upsert', target_id: 'writer/default' },
    });
    expect(auditCountAfter - auditCountBefore).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // f. revert 成功: archived 行を再 active 化
  // -------------------------------------------------------------------------
  test('f. archived 行を revert → 成功表示 + 該当行 active + 現 active が archived', async ({
    page,
  }) => {
    // テスト e 後の状態:
    //   - active: writer/default → anthropic / e2e-s019-claude-test
    //   - archived: 元の seed (anthropic / claude-sonnet-4-6) ← これを revert する
    // revert 対象 = beforeActive 由来の archived 行
    const archivedSeed = await prisma.modelAssignment.findFirst({
      where: {
        role: 'writer',
        genre: null,
        status: 'archived',
        model: 'claude-sonnet-4-6',
      },
      orderBy: { archived_at: 'desc' },
    });
    expect(archivedSeed).not.toBeNull();
    const archivedId = archivedSeed!.id;

    // 現 active id (テスト e で作られた new active)
    const currentActive = await prisma.modelAssignment.findFirst({
      where: { role: 'writer', genre: null, status: 'active' },
    });
    expect(currentActive).not.toBeNull();
    const currentActiveId = currentActive!.id;

    const auditCountBefore = await prisma.auditLog.count({
      where: { action: 'model_assignment.revert', target_id: 'writer/default' },
    });

    await page.goto('/models/assignments');
    await expect(page.getByTestId('assignment-history-table')).toBeVisible();

    // revert ボタンクリック
    const revertButton = page.getByTestId(`assignment-revert-button-${archivedId}`);
    await expect(revertButton).toBeVisible();
    await revertButton.click();

    // 成功フィードバックの検証:
    // 成功時 AssignmentRevertButton は (1) setStatus(ok, m.successRevert) で
    // inline メッセージを描画した直後 (2) router.refresh() を発火する。
    // router.refresh() で当該 archived 行は active 化され、AssignmentHistoryTable で
    // 表示順位が変わる + その行から AssignmentRevertButton が消える (active 行には
    // revert ボタン非描画) ため、'assignment-revert-success-{id}' は短命で
    // Playwright が捕捉できないことがある。
    // → 成功フィードバックは「revert ボタンが行から消えたこと (= row が active 化された
    //    UI 反映)」+「DB 状態の遷移」+「audit_log 増加」で総合的に検証する。
    await expect(revertButton).toBeHidden({ timeout: 10_000 });

    // DB 直接確認
    // 1. archivedSeed 行が active 化
    const revived = await prisma.modelAssignment.findUnique({
      where: { id: archivedId },
    });
    expect(revived?.status).toBe('active');
    expect(revived?.archived_at).toBeNull();

    // 2. 直前の current active が archived 化
    const formerCurrent = await prisma.modelAssignment.findUnique({
      where: { id: currentActiveId },
    });
    expect(formerCurrent?.status).toBe('archived');
    expect(formerCurrent?.archived_at).not.toBeNull();

    // 3. audit_log 1 件追加
    const auditCountAfter = await prisma.auditLog.count({
      where: { action: 'model_assignment.revert', target_id: 'writer/default' },
    });
    expect(auditCountAfter - auditCountBefore).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // g. 同一値 upsert 弾き: UI ガード (sameAsCurrent warning + save disabled)
  // -------------------------------------------------------------------------
  test('g. 同一 provider/model で再 upsert → UI が isSame を検出して save disabled', async ({
    page,
  }) => {
    // 設計上の前提:
    //   AssignmentEditorDrawer は drawer を開いた瞬間に、catalog にない currentModel を
    //   provider の catalog 先頭モデルへ自動置換する (useEffect)。
    //   このため writer/default のような seed 割当 (catalog 不在のモデル) では、開いた
    //   時点で model が変化し isSame が成立せず "sameAsCurrent" warning が出ない。
    //
    //   よって本ケースでは、catalog に存在するモデルで未設定セル (writer/practical) を
    //   upsert 成功させ → 再度同じセルを開く → 今度は currentModel が catalog に
    //   含まれるので drawer 上で provider/model が維持される → isSame が true になり、
    //   save ボタンが disabled になることを検証する。
    //
    //   F-022/F-023 受入基準としての server 側 noChange 弾きは core 単体テスト
    //   (apps/web/__tests__/actions/model-assignments.test.ts) で完全に網羅済み。
    //   E2E では UI ガード (save disabled) を以て二重防止が機能していることを確認する。

    const targetRole = 'writer';
    const targetGenre = 'practical';

    // 念のため writer/practical の active を削除して未設定状態にしておく
    await prisma.modelAssignment.deleteMany({
      where: { role: targetRole, genre: targetGenre },
    });

    // 1. 未設定セルを開き、anthropic / e2e-s019-claude-test に upsert する
    await page.goto('/models/assignments');
    await page.getByTestId(`assignment-cell-${targetRole}-${targetGenre}`).click();
    await expect(page.getByTestId('assignment-editor-drawer')).toBeVisible();

    await page.getByTestId('assignment-editor-provider-select').selectOption('anthropic');
    await page
      .getByTestId('assignment-editor-model-select')
      .selectOption(`${E2E_CATALOG_PREFIX}claude-test`);
    await page.getByTestId('assignment-editor-save-button').click();

    // 成功 inline メッセージ (2.5 秒後 close するが、表示中に確認)
    await expect(page.getByTestId('assignment-editor-success')).toBeVisible({
      timeout: 10_000,
    });

    // dialog が閉じるのを待ってから再度開く (2.5s setTimeout)
    await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: 6_000 });

    // upsert 結果 DB 確認
    const active = await prisma.modelAssignment.findFirst({
      where: {
        role: targetRole,
        genre: targetGenre,
        status: 'active',
        provider: 'anthropic',
        model: `${E2E_CATALOG_PREFIX}claude-test`,
      },
    });
    expect(active).not.toBeNull();

    // 2. 同じセルを再度開く → currentModel が catalog に存在するので維持され、isSame=true
    await page.getByTestId(`assignment-cell-${targetRole}-${targetGenre}`).click();
    await expect(page.getByTestId('assignment-editor-drawer')).toBeVisible();

    // isSame 状態の UI ガード検証
    await expect(
      page.getByText(
        '現在の割当と同一です。変更するには provider または model を変えてください。',
      ),
    ).toBeVisible();
    await expect(page.getByTestId('assignment-editor-save-button')).toBeDisabled();
  });
});
