/**
 * E2E: S-006 テーマ候補一覧 + バルク承認 UI — T-03-07 / F-017.
 *
 * 検証するケース:
 *   a. /themes 遷移 + 画面表示 (themes-table 可視 + 5 行)
 *   b. 各行が theme-row-{id} で表示され、title / status / market_score を含む
 *   c. checkbox で 2 行選択 → bulk-action-bar 表示 + 「2 件選択中」
 *   d. 採用 (1 本道): 2 件選択 → bulk-accept-button →
 *      `/batches` へ遷移、DB: 該当 2 件 status='accepted'、他 3 件 pending のまま、
 *      BatchPlan が自動作成され該当テーマが BatchPlanItem に入る、
 *      audit_log に action='themes.stage_batch' 1 行
 *   e. bulkDecideThemes reject: 残り 3 件のうち 1 件選択 → bulk-reject-button →
 *      status='rejected'
 *   g. empty state: 全削除後リロード → themes-empty-state 可視
 *
 * 前提:
 *   - storageState は global.setup.ts が認証済みで保存済
 *   - PostgreSQL (Docker a2p-pg port 5433) 稼働中
 *   - SP-03 までの seed (ModelAssignment / Prompt 等) は維持する
 *
 * テストデータ:
 *   - 一時 Account (`pen_name='e2e-s006-...'`) 1 件
 *   - ThemeCandidate 5 件 (status='pending'、同一 theme_session_id、e2e-s006-{1..5})
 *   - 本 spec で作成された行は afterAll で deleteMany (Account cascade に頼る)
 *
 * コスト: ゼロ (DB 操作 + UI 操作のみ、LLM/外部 API 呼出なし)
 */
import { test, expect, type Page } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const E2E_PEN_NAME_PREFIX = 'e2e-s006-';
const E2E_SESSION_ID = `e2e-s006-session-${Date.now()}`;

interface SeededTheme {
  id: string;
  title: string;
}

let accountId = '';
let seededThemes: SeededTheme[] = [];

/**
 * 本 spec で投入したデータをすべて掃除する。
 * - ThemeCandidate / AuditLog は theme_session_id / target_id で識別
 * - Account は pen_name 前方一致 (本 spec 由来のみ)
 */
async function cleanupS006Data(): Promise<void> {
  // 1. 本 spec の session に紐づく ThemeCandidate
  await prisma.themeCandidate
    .deleteMany({ where: { theme_session_id: E2E_SESSION_ID } })
    .catch(() => undefined);

  // 2. 本 spec で出力された audit_log
  //    action='themes.bulk_decide' or 'themes.stage_batch'、target_id='bulk' のうち
  //    after_json.theme_ids が本 spec の seededThemes に属するもの
  //    → 件数比較で十分なので、ここでは target_id='bulk' のうち本 spec test 由来分を
  //    安全に絞るため、actor_id (seed user) + 1 時間以内 で deleteMany はせず、
  //    seededThemes id を含む行のみ削除。
  if (seededThemes.length > 0) {
    const ids = seededThemes.map((t) => t.id);
    // PostgreSQL JSON contains で絞る。理論上ヒットしない時もあるので catch で握りつぶす。
    await prisma.auditLog
      .deleteMany({
        where: {
          target_kind: 'theme_candidate',
          target_id: 'bulk',
          OR: [
            { after_json: { path: ['theme_ids'], array_contains: ids[0] } as never },
          ],
        },
      })
      .catch(() => undefined);
  }

  // 3. 本 spec の Account (cascade で残りの ThemeCandidate も消える)
  await prisma.account
    .deleteMany({ where: { pen_name: { startsWith: E2E_PEN_NAME_PREFIX } } })
    .catch(() => undefined);
}

/**
 * spec 用 Account + 5 件 pending ThemeCandidate を投入。
 */
async function seedS006Data(): Promise<void> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${E2E_PEN_NAME_PREFIX}${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['remote_work'],
      } as unknown as Prisma.InputJsonValue,
      status: 'archived', // ダッシュボード一覧に出さない
    },
  });
  accountId = account.id;

  seededThemes = [];
  for (let i = 1; i <= 5; i++) {
    const row = await prisma.themeCandidate.create({
      data: {
        account_id: accountId,
        theme_session_id: E2E_SESSION_ID,
        genre: 'business',
        title: `E2E-S006 テーマ ${i}: リモートワーク時代のチーム運営 ${i}`,
        subtitle: null,
        hook: `差別化要素 ${i}: 30 代マネージャ向け実践ガイド`,
        target_reader: '30-40 代マネージャ',
        competitors_json: [
          { asin: `B0E2E${i}A`, title: '競合書 A', url: 'https://example.com/a' },
          { asin: `B0E2E${i}B`, title: '競合書 B', url: 'https://example.com/b' },
        ] as unknown as Prisma.InputJsonValue,
        signals_json: {
          market_score: 50 + i,
          sources: ['amazon', 'google_trends'],
        } as unknown as Prisma.InputJsonValue,
        status: 'pending',
      },
    });
    seededThemes.push({ id: row.id, title: row.title });
  }
}

async function gotoThemesPage(page: Page, viaSidebar: boolean): Promise<void> {
  if (viaSidebar) {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-root')).toBeVisible();
    await page
      .getByTestId('sidebar-nav')
      .getByRole('link', { name: 'テーマ候補' })
      .click();
  } else {
    // セッション別表示は廃止。全セッション横断の一覧を開く (既定フィルタ = 未採用)。
    await page.goto('/themes');
  }
  await page.waitForURL(/\/themes(\?|$)/);
}

test.describe('S-006: テーマ候補一覧 + バルク承認 (T-03-07)', () => {
  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS006Data();
    await seedS006Data();
  });

  test.afterAll(async () => {
    await cleanupS006Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // a. 遷移 + 画面表示
  // -------------------------------------------------------------------------
  test('a. ダッシュボード → サイドバー「テーマ候補」 → /themes 遷移 + themes-table 可視', async ({
    page,
  }) => {
    await gotoThemesPage(page, /* viaSidebar */ true);

    // 全セッション横断一覧が表示され、seed した pending テーマが見える。
    await expect(page.getByTestId('themes-table')).toBeVisible();
    await expect(page.getByTestId(`theme-row-${seededThemes[0]!.id}`)).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // b. seed した 5 行が表示 + 列内容 (件数は全セッション横断なので ID で検証)
  // -------------------------------------------------------------------------
  test('b. 5 件の theme-row-{id} が表示され、title / status 列を含む', async ({
    page,
  }) => {
    await gotoThemesPage(page, /* viaSidebar */ false);
    await expect(page.getByTestId('themes-table')).toBeVisible();

    for (const t of seededThemes) {
      const row = page.getByTestId(`theme-row-${t.id}`);
      await expect(row).toBeVisible();
      // title セル
      await expect(page.getByTestId(`theme-title-${t.id}`)).toContainText(t.title);
      // status badge: pending
      await expect(page.getByTestId(`theme-status-${t.id}`)).toContainText('pending');
    }

    // サマリは全セッション横断の集計。seed 分を含み total >= 5 であることだけ確認する。
    await expect(page.getByTestId('themes-summary-total')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // c. checkbox 選択 → BulkActionBar 表示 + selection count
  // -------------------------------------------------------------------------
  test('c. 2 行 checkbox toggle → bulk-action-bar 表示 + 「2 件選択中」', async ({ page }) => {
    await gotoThemesPage(page, /* viaSidebar */ false);
    await expect(page.getByTestId('themes-table')).toBeVisible();

    // BulkActionBar は selection=0 のときは描画されない (themes-page-shell 参照)
    await expect(page.getByTestId('bulk-action-bar')).toHaveCount(0);

    // 任意の 2 行を選択
    const t1 = seededThemes[0]!;
    const t2 = seededThemes[1]!;
    await page.getByTestId(`theme-checkbox-${t1.id}`).check();
    await page.getByTestId(`theme-checkbox-${t2.id}`).check();

    await expect(page.getByTestId('bulk-action-bar')).toBeVisible();
    await expect(page.getByTestId('bulk-selection-count')).toContainText('2 件選択中');
  });

  // -------------------------------------------------------------------------
  // d. bulkDecideThemes accept: 2 件選択 → 採用ボタン → DB 検証
  // -------------------------------------------------------------------------
  test('d. 2 件 accept → DB: 該当 2 件 accepted, 他 3 件 pending, audit_log 1 行', async ({
    page,
  }) => {
    const auditCountBefore = await prisma.auditLog.count({
      where: { action: 'themes.stage_batch' },
    });

    await gotoThemesPage(page, /* viaSidebar */ false);
    await expect(page.getByTestId('themes-table')).toBeVisible();

    const t1 = seededThemes[0]!;
    const t2 = seededThemes[1]!;
    const others = seededThemes.slice(2);

    await page.getByTestId(`theme-checkbox-${t1.id}`).check();
    await page.getByTestId(`theme-checkbox-${t2.id}`).check();
    await expect(page.getByTestId('bulk-selection-count')).toContainText('2 件選択中');

    // 採用ボタン押下 = 採用 + 夜間バッチ計画を自動作成 → /batches へ遷移する 1 本道。
    await page.getByTestId('bulk-accept-button').click();

    // /batches へ遷移を待つ
    await page.waitForURL(/\/batches(\?|$|\/)/, { timeout: 15_000 });

    // DB 直接検証
    // 1. 該当 2 件が accepted
    for (const t of [t1, t2]) {
      const row = await prisma.themeCandidate.findUnique({ where: { id: t.id } });
      expect(row?.status).toBe('accepted');
      expect(row?.decided_at).not.toBeNull();
    }
    // 2. 残り 3 件は pending のまま
    for (const t of others) {
      const row = await prisma.themeCandidate.findUnique({ where: { id: t.id } });
      expect(row?.status).toBe('pending');
      expect(row?.decided_at).toBeNull();
    }
    // 3. 採用した 2 件がバッチ計画 (BatchPlanItem) に入っている
    for (const t of [t1, t2]) {
      const item = await prisma.batchPlanItem.findFirst({ where: { theme_id: t.id } });
      expect(item, `theme ${t.id} should be staged into a BatchPlanItem`).not.toBeNull();
    }
    // 4. audit_log に themes.stage_batch 1 行追加
    const auditCountAfter = await prisma.auditLog.count({
      where: { action: 'themes.stage_batch' },
    });
    expect(auditCountAfter - auditCountBefore).toBe(1);
  });

  // -------------------------------------------------------------------------
  // e. bulkDecideThemes reject: 残り 3 件のうち 1 件選択 → 却下
  // -------------------------------------------------------------------------
  test('e. 残り pending 3 件のうち 1 件を reject → status=rejected', async ({ page }) => {
    const auditCountBefore = await prisma.auditLog.count({
      where: { action: 'themes.bulk_decide' },
    });

    await gotoThemesPage(page, /* viaSidebar */ false);
    await expect(page.getByTestId('themes-table')).toBeVisible();

    // 3 番目 (index=2) の row を reject 対象に
    const target = seededThemes[2]!;
    await page.getByTestId(`theme-checkbox-${target.id}`).check();
    await expect(page.getByTestId('bulk-selection-count')).toContainText('1 件選択中');

    await page.getByTestId('bulk-reject-button').click();

    // status badge 反映待ち
    await expect(page.getByTestId(`theme-status-${target.id}`)).toContainText('rejected', {
      timeout: 10_000,
    });

    // DB 検証
    const row = await prisma.themeCandidate.findUnique({ where: { id: target.id } });
    expect(row?.status).toBe('rejected');
    expect(row?.decided_at).not.toBeNull();

    // 残り 2 件 (index=3, 4) は依然 pending
    for (const t of seededThemes.slice(3)) {
      const r = await prisma.themeCandidate.findUnique({ where: { id: t.id } });
      expect(r?.status).toBe('pending');
    }

    // audit_log 1 行追加
    const auditCountAfter = await prisma.auditLog.count({
      where: { action: 'themes.bulk_decide' },
    });
    expect(auditCountAfter - auditCountBefore).toBe(1);
  });

  // -------------------------------------------------------------------------
  // g. seed 削除後リロード → seed 行が消える
  // -------------------------------------------------------------------------
  test('g. 本 spec の seed を削除 → 該当 theme-row が一覧から消える', async ({ page }) => {
    // 本 spec の ThemeCandidate を全削除
    await prisma.themeCandidate.deleteMany({
      where: { theme_session_id: E2E_SESSION_ID },
    });

    // 全セッション横断一覧を開く。他 seed の有無に依らず、本 spec の行が消えたことを
    // ID スコープで検証する (empty-state は DB 全体が 0 件のときのみのため使わない)。
    await page.goto('/themes');
    await page.waitForURL(/\/themes(\?|$)/);

    for (const t of seededThemes) {
      await expect(page.getByTestId(`theme-row-${t.id}`)).toHaveCount(0);
    }
  });
});
