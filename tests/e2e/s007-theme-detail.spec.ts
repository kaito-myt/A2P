/**
 * E2E: S-007 テーマ候補詳細 UI — T-03-08 / F-001.
 *
 * 検証する 10 ケース:
 *   a. /themes/<不在 id> → Next.js 404 表示 (notFound() 動作)
 *   b. /themes/[id] 正常表示 (theme-detail-header / title / status / market_score)
 *   c. theme-summary-section: hook / target_reader 表示
 *   d. CompetitorsTable: 3 件 競合行 表示 + url ありの行に competitor-link
 *   e. CompetitorsTable empty state (competitors_json=[]) → competitors-empty
 *   f. WebSearchSnippetList: search_keywords が search-keyword-{idx} で表示
 *   g. ActionButtonGroup accept: action-accept-button-{id} クリック →
 *      DB status='accepted' + audit_log 1 行 + UI status badge 反映
 *   h. ActionButtonGroup reject: 別 candidate で action-reject-button-{id} →
 *      DB status='rejected'
 *   i. S-006 → S-007 リンク: /themes 開く → theme-detail-link-{id} で詳細遷移
 *   j. action-comment-placeholder 表示 (書籍未紐付きのためコメント不可)
 *
 * 前提:
 *   - storageState は global.setup.ts が認証済みで保存済
 *   - PostgreSQL (Docker a2p-pg port 5433) 稼働中
 *   - SP-03 までの seed (ModelAssignment / Prompt 等) は維持する
 *
 * テストデータ:
 *   - 一時 Account (`pen_name='e2e-s007-...'`) 1 件
 *   - ThemeCandidate 3 件 (同一 theme_session_id):
 *     - main: pending, competitors_json=[3 件 (うち 1 件は url 欠落)],
 *             signals_json=full (market_score / reasoning / search_keywords / sources)
 *     - reject_target: pending, competitors=[], signals={} → reject テスト用
 *     - empty_competitors: pending, competitors=[], signals={} → empty state テスト用
 *   - 本 spec で作成された行は afterAll で Account 削除 (cascade) + audit_log 後清掃
 *
 * コスト: ゼロ (DB 操作 + UI 操作のみ、LLM/外部 API 呼出なし)
 */
import { test, expect, type Page } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const E2E_PEN_NAME_PREFIX = 'e2e-s007-';
const E2E_SESSION_ID = `e2e-s007-session-${Date.now()}`;

interface SeededTheme {
  id: string;
  title: string;
}

let accountId = '';
let mainTheme: SeededTheme = { id: '', title: '' };
let rejectTarget: SeededTheme = { id: '', title: '' };
let emptyCompetitorsTheme: SeededTheme = { id: '', title: '' };

/**
 * 本 spec で投入したデータをすべて掃除する。
 * - ThemeCandidate / AuditLog は theme_session_id / actor (= seed user) で識別
 * - Account は pen_name 前方一致 (本 spec 由来のみ)
 */
async function cleanupS007Data(): Promise<void> {
  // 1. 本 spec の session に紐づく ThemeCandidate
  await prisma.themeCandidate
    .deleteMany({ where: { theme_session_id: E2E_SESSION_ID } })
    .catch(() => undefined);

  // 2. 本 spec で出力された audit_log
  //    after_json.theme_ids が本 spec の seededThemes に属するもの
  const ids = [mainTheme.id, rejectTarget.id, emptyCompetitorsTheme.id].filter(
    (s) => s.length > 0,
  );
  if (ids.length > 0) {
    for (const id of ids) {
      await prisma.auditLog
        .deleteMany({
          where: {
            target_kind: 'theme_candidate',
            target_id: 'bulk',
            after_json: { path: ['theme_ids'], array_contains: id } as never,
          },
        })
        .catch(() => undefined);
    }
  }

  // 3. 本 spec の Account (cascade で残りの ThemeCandidate も消える)
  await prisma.account
    .deleteMany({ where: { pen_name: { startsWith: E2E_PEN_NAME_PREFIX } } })
    .catch(() => undefined);
}

/**
 * spec 用 Account + 3 件 pending ThemeCandidate を投入。
 */
async function seedS007Data(): Promise<void> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${E2E_PEN_NAME_PREFIX}${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['side_business'],
      } as unknown as Prisma.InputJsonValue,
      status: 'archived', // ダッシュボード一覧に出さない
    },
  });
  accountId = account.id;

  // main: 競合 3 件 + signals 全部入り
  const mainRow = await prisma.themeCandidate.create({
    data: {
      account_id: accountId,
      theme_session_id: E2E_SESSION_ID,
      genre: 'business',
      title: 'E2E-S007 メインテーマ: 副業 × AI で月 5 万円稼ぐ',
      subtitle: '在宅 × 副業ガイド',
      hook: '差別化要素: 30 代会社員でも夜 1 時間で始められる副業ロードマップ',
      target_reader: '30-40 代 副業初心者の会社員',
      competitors_json: [
        {
          asin: 'B0E2E7A1',
          title: '副業マスター A',
          author: '著者 A',
          url: 'https://example.com/competitor-a',
          rank: 120,
          review_summary: '良い',
        },
        {
          asin: 'B0E2E7A2',
          title: '副業マスター B',
          author: '著者 B',
          url: 'https://example.com/competitor-b',
          rank: 250,
        },
        // url 欠落 → competitor-link が出ない行
        {
          asin: 'B0E2E7A3',
          title: '副業マスター C',
          author: '著者 C',
        },
      ] as unknown as Prisma.InputJsonValue,
      signals_json: {
        market_score: 78,
        reasoning: '副業ジャンルは検索ボリュームが多く、競合は中程度。',
        search_keywords: ['副業', 'AI', '在宅'],
        sources: ['https://example.com/source-a', 'https://example.com/source-b'],
        search_volume: 12000,
        rank_estimate: 50,
        predicted_chapters: 8,
      } as unknown as Prisma.InputJsonValue,
      status: 'pending',
    },
  });
  mainTheme = { id: mainRow.id, title: mainRow.title };

  // reject_target: 競合空 + signals 空
  const rejectRow = await prisma.themeCandidate.create({
    data: {
      account_id: accountId,
      theme_session_id: E2E_SESSION_ID,
      genre: 'business',
      title: 'E2E-S007 reject 対象テーマ',
      hook: '差別化要素 (reject 用)',
      target_reader: null,
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: {} as unknown as Prisma.InputJsonValue,
      status: 'pending',
    },
  });
  rejectTarget = { id: rejectRow.id, title: rejectRow.title };

  // empty_competitors: 競合空 + signals 空 (empty state テスト用)
  const emptyRow = await prisma.themeCandidate.create({
    data: {
      account_id: accountId,
      theme_session_id: E2E_SESSION_ID,
      genre: 'business',
      title: 'E2E-S007 competitors 空テーマ',
      hook: '差別化要素 (空状態用)',
      target_reader: null,
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: {} as unknown as Prisma.InputJsonValue,
      status: 'pending',
    },
  });
  emptyCompetitorsTheme = { id: emptyRow.id, title: emptyRow.title };
}

async function gotoDetail(page: Page, id: string): Promise<void> {
  await page.goto(`/themes/${id}`);
}

test.describe('S-007: テーマ候補詳細 UI (T-03-08)', () => {
  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS007Data();
    await seedS007Data();
  });

  test.afterAll(async () => {
    await cleanupS007Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // a. 不在 id → 404
  // -------------------------------------------------------------------------
  test('a. /themes/<不在 id> → Next.js 404 (notFound) が描画される', async ({ page }) => {
    // 形式は valid だが DB に存在しない cuid 文字列
    const missingId = 'c000000000000s007missingid';
    const res = await page.goto(`/themes/${missingId}`);
    // Next.js notFound() は 404 ステータスを返す
    expect(res?.status()).toBe(404);
    // theme-detail-page が描画されないことを確認
    await expect(page.getByTestId('theme-detail-page')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // b. 正常表示: header / title / status / market_score
  // -------------------------------------------------------------------------
  test('b. /themes/[id] 正常表示: header / title / status / market_score', async ({
    page,
  }) => {
    await gotoDetail(page, mainTheme.id);

    await expect(page.getByTestId('theme-detail-page')).toBeVisible();
    await expect(page.getByTestId('theme-detail-header')).toBeVisible();
    await expect(page.getByTestId('theme-detail-title')).toContainText(
      mainTheme.title,
    );
    // status badge は theme-detail-status コンテナ内 + status-badge-{id}
    await expect(page.getByTestId('theme-detail-status')).toBeVisible();
    await expect(page.getByTestId('theme-detail-status')).toContainText('pending');
    // market_score = 78
    await expect(page.getByTestId('theme-detail-market-score')).toContainText('78');
    // session ID 表示
    await expect(page.getByTestId('theme-detail-session-id')).toContainText(
      E2E_SESSION_ID,
    );
  });

  // -------------------------------------------------------------------------
  // c. ThemeSummarySection: hook / target_reader
  // -------------------------------------------------------------------------
  test('c. theme-summary-section: hook / target_reader テキスト表示', async ({ page }) => {
    await gotoDetail(page, mainTheme.id);

    await expect(page.getByTestId('theme-summary-section')).toBeVisible();
    await expect(page.getByTestId('theme-hook')).toContainText(
      '30 代会社員でも夜 1 時間で始められる副業ロードマップ',
    );
    await expect(page.getByTestId('theme-target-reader')).toContainText(
      '30-40 代 副業初心者の会社員',
    );
  });

  // -------------------------------------------------------------------------
  // d. CompetitorsTable: 3 行 + url ありに competitor-link
  // -------------------------------------------------------------------------
  test('d. CompetitorsTable: 3 行表示 + url ありの行に competitor-link', async ({ page }) => {
    await gotoDetail(page, mainTheme.id);

    await expect(page.getByTestId('competitors-table')).toBeVisible();
    // 3 行
    await expect(page.getByTestId('competitor-row-0')).toBeVisible();
    await expect(page.getByTestId('competitor-row-1')).toBeVisible();
    await expect(page.getByTestId('competitor-row-2')).toBeVisible();
    // 3 行目以降は無いはず
    await expect(page.getByTestId('competitor-row-3')).toHaveCount(0);

    // タイトル表示
    await expect(page.getByTestId('competitor-row-0')).toContainText('副業マスター A');

    // url あり 2 行 + url なし 1 行 → competitor-link は 2 個
    await expect(page.getByTestId('competitor-link')).toHaveCount(2);
    // 行内に href があるか確認 (最初の 1 件)
    const firstLink = page.getByTestId('competitor-link').first();
    await expect(firstLink).toHaveAttribute('href', 'https://example.com/competitor-a');
  });

  // -------------------------------------------------------------------------
  // e. CompetitorsTable empty state
  // -------------------------------------------------------------------------
  test('e. competitors_json=[] のテーマ → competitors-empty が可視', async ({ page }) => {
    await gotoDetail(page, emptyCompetitorsTheme.id);

    await expect(page.getByTestId('competitors-table')).toBeVisible();
    await expect(page.getByTestId('competitors-empty')).toBeVisible();
    await expect(page.getByTestId('competitor-row-0')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // f. WebSearchSnippetList: search_keywords 表示
  // -------------------------------------------------------------------------
  test('f. WebSearchSnippetList: search-keyword-{idx} がキーワード分表示される', async ({
    page,
  }) => {
    await gotoDetail(page, mainTheme.id);

    await expect(page.getByTestId('web-search-snippet-list')).toBeVisible();
    // 3 件のキーワード
    await expect(page.getByTestId('search-keyword-0')).toContainText('副業');
    await expect(page.getByTestId('search-keyword-1')).toContainText('AI');
    await expect(page.getByTestId('search-keyword-2')).toContainText('在宅');
    // sources
    await expect(page.getByTestId('search-source-0')).toContainText(
      'https://example.com/source-a',
    );
    // 数値メタ
    await expect(page.getByTestId('theme-signals-search-volume')).toContainText('12000');
    await expect(page.getByTestId('theme-signals-predicted-chapters')).toContainText('8');
  });

  // -------------------------------------------------------------------------
  // g. ActionButtonGroup accept → DB / UI 反映
  // -------------------------------------------------------------------------
  test('g. action-accept-button → DB status=accepted + audit_log + UI 反映', async ({
    page,
  }) => {
    const auditCountBefore = await prisma.auditLog.count({
      where: { action: 'themes.bulk_decide' },
    });

    await gotoDetail(page, mainTheme.id);
    await expect(page.getByTestId('action-button-group')).toBeVisible();
    await expect(page.getByTestId(`action-accept-button-${mainTheme.id}`)).toBeEnabled();

    await page.getByTestId(`action-accept-button-${mainTheme.id}`).click();

    // status badge が accepted へ (router.refresh の再描画待ち)
    await expect(page.getByTestId('theme-detail-status')).toContainText('accepted', {
      timeout: 10_000,
    });

    // DB 反映
    const row = await prisma.themeCandidate.findUnique({ where: { id: mainTheme.id } });
    expect(row?.status).toBe('accepted');
    expect(row?.decided_at).not.toBeNull();

    // audit_log +1
    const auditCountAfter = await prisma.auditLog.count({
      where: { action: 'themes.bulk_decide' },
    });
    expect(auditCountAfter - auditCountBefore).toBe(1);

    // accept/reject ボタンは disabled に
    await expect(page.getByTestId(`action-accept-button-${mainTheme.id}`)).toBeDisabled();
    await expect(page.getByTestId(`action-reject-button-${mainTheme.id}`)).toBeDisabled();
    // hint メッセージ
    await expect(page.getByTestId('action-status-hint')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // h. ActionButtonGroup reject (別 candidate) → DB status=rejected
  // -------------------------------------------------------------------------
  test('h. action-reject-button → DB status=rejected', async ({ page }) => {
    const auditCountBefore = await prisma.auditLog.count({
      where: { action: 'themes.bulk_decide' },
    });

    await gotoDetail(page, rejectTarget.id);
    await expect(page.getByTestId(`action-reject-button-${rejectTarget.id}`)).toBeEnabled();

    await page.getByTestId(`action-reject-button-${rejectTarget.id}`).click();

    await expect(page.getByTestId('theme-detail-status')).toContainText('rejected', {
      timeout: 10_000,
    });

    const row = await prisma.themeCandidate.findUnique({
      where: { id: rejectTarget.id },
    });
    expect(row?.status).toBe('rejected');
    expect(row?.decided_at).not.toBeNull();

    const auditCountAfter = await prisma.auditLog.count({
      where: { action: 'themes.bulk_decide' },
    });
    expect(auditCountAfter - auditCountBefore).toBe(1);
  });

  // -------------------------------------------------------------------------
  // i. S-006 → S-007 リンク
  // -------------------------------------------------------------------------
  test('i. /themes 開く → theme-detail-link-{id} で /themes/{id} に遷移', async ({ page }) => {
    // 一覧で session を絞り込んで本 spec の行のみ出す
    await page.goto(`/themes?theme_session_id=${E2E_SESSION_ID}`);
    await expect(page.getByTestId('themes-table')).toBeVisible();

    // emptyCompetitorsTheme は g/h で accept/reject に変わっていないので使う
    const link = page.getByTestId(`theme-detail-link-${emptyCompetitorsTheme.id}`);
    await expect(link).toBeVisible();
    await link.click();

    await page.waitForURL(`**/themes/${emptyCompetitorsTheme.id}`);
    await expect(page.getByTestId('theme-detail-page')).toBeVisible();
    await expect(page.getByTestId('theme-detail-title')).toContainText(
      emptyCompetitorsTheme.title,
    );
  });

  // -------------------------------------------------------------------------
  // j. action-comment-placeholder 表示 (書籍未紐付き)
  // -------------------------------------------------------------------------
  test('j. action-comment-placeholder (書籍未紐付き) が表示される', async ({ page }) => {
    await gotoDetail(page, emptyCompetitorsTheme.id);
    await expect(page.getByTestId('action-comment-placeholder')).toBeVisible();
    await expect(page.getByTestId('action-comment-placeholder')).toContainText('書籍未紐付けのためコメント不可');
  });
});
