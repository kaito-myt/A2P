/**
 * E2E: S-010 章 Markdown ビューア + コスト内訳タブ (T-04-10).
 *
 * 検証する 4 ケース:
 *   1. 章タブ: 章切替 — ログイン済み -> /books/[id] -> 「章本文」タブ ->
 *      body_md がある章を選択 -> Markdown がレンダリング -> 別の章に切替 -> 内容が変わる
 *   2. 章タブ: 章なし — 章がない書籍で「章本文」タブ -> 空メッセージ表示
 *   3. コスト内訳タブ: データあり — token_usage レコードがある書籍 ->
 *      「コスト内訳」タブ -> テーブルに provider, model, role 列 + 合計行が表示
 *   4. コスト内訳タブ: データなし — token_usage レコードがない書籍 ->
 *      「コスト内訳」タブ -> 空メッセージ表示
 *
 * 注:
 *  - 外部 LLM/API は呼ばない (表示系のみの検証)。
 *  - dev server (Next.js port 3001) は既に稼働中前提。
 *  - Postgres は Docker a2p-pg port 5433。
 *
 * 仕様根拠:
 *  - docs/02 F-033 コスト集計
 *  - docs/04 S-010 書籍詳細画面
 *  - docs/sprints/SP-04 T-04-10
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-s010-ch-cost';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeedContext {
  accountId: string;
  themeId: string;
  bookId: string;
  bookTitle: string;
}

/**
 * 本 spec で投入した行を Account の pen_name 前方一致で識別して削除。
 */
async function cleanupTestData(): Promise<void> {
  const accounts = await prisma.account.findMany({
    where: { pen_name: { startsWith: TEST_PEN_PREFIX } },
    select: { id: true },
  });
  if (accounts.length === 0) return;
  const accountIds = accounts.map((a) => a.id);

  const books = await prisma.book.findMany({
    where: { account_id: { in: accountIds } },
    select: { id: true },
  });
  const bookIds = books.map((b) => b.id);

  if (bookIds.length > 0) {
    // tokenUsage has SetNull on book FK, delete explicitly
    await prisma.tokenUsage
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
    await prisma.job
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
    await prisma.bookLock
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
  }

  await prisma.account
    .deleteMany({ where: { id: { in: accountIds } } })
    .catch(() => undefined);
}

/**
 * 1 Account + 1 ThemeCandidate + 1 Book を作成。
 */
async function seedBase(label: string): Promise<SeedContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${label}-${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['remote_work'],
      } as unknown as Prisma.InputJsonValue,
      status: 'archived',
    },
    select: { id: true },
  });

  const theme = await prisma.themeCandidate.create({
    data: {
      account_id: account.id,
      theme_session_id: `${TEST_PEN_PREFIX}-${label}-session-${Date.now()}`,
      genre: 'business',
      title: `T-04-10 ${label} テスト用テーマ`,
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const bookTitle = `T-04-10 ${label} テスト書籍`;
  const book = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: bookTitle,
      status: 'running',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    bookTitle,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('S-010: 章 Markdown ビューア + コスト内訳タブ (T-04-10)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupTestData();
  });

  test.afterAll(async () => {
    await cleanupTestData();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. 章タブ: 章切替
  // -------------------------------------------------------------------------
  test('1. 章タブ: body_md がある章を選択して Markdown レンダリングされ、別の章に切替えると内容が変わる', async ({
    page,
  }) => {
    const ctx = await seedBase('ch-switch');

    // Create 3 chapters with body_md
    await prisma.chapter.createMany({
      data: [
        {
          book_id: ctx.bookId,
          index: 1,
          heading: 'はじめに',
          body_md: '# はじめに\n\nこの章ではリモートワークの背景を解説します。',
          status: 'done',
          char_count: 5000,
          version: 1,
        },
        {
          book_id: ctx.bookId,
          index: 2,
          heading: '本論',
          body_md: '# 本論\n\nリモートワークのメリットとデメリットを論じます。',
          status: 'done',
          char_count: 8000,
          version: 1,
        },
        {
          book_id: ctx.bookId,
          index: 3,
          heading: 'まとめ',
          body_md: '# まとめ\n\n結論と今後の展望を述べます。',
          status: 'done',
          char_count: 4000,
          version: 1,
        },
      ],
    });

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // Click chapters tab
    await page.getByTestId('tab-chapters').click();

    // chapters-tab should be visible (not empty)
    await expect(page.getByTestId('chapters-tab')).toBeVisible();

    // Chapter summary list should show all 3 chapters
    await expect(page.getByTestId('chapter-summary-1')).toBeVisible();
    await expect(page.getByTestId('chapter-summary-1')).toContainText('はじめに');
    await expect(page.getByTestId('chapter-summary-2')).toBeVisible();
    await expect(page.getByTestId('chapter-summary-2')).toContainText('本論');
    await expect(page.getByTestId('chapter-summary-3')).toBeVisible();
    await expect(page.getByTestId('chapter-summary-3')).toContainText('まとめ');

    // Markdown viewer should be visible
    await expect(page.getByTestId('chapter-markdown-viewer')).toBeVisible();

    // Chapter selector should be present
    await expect(page.getByTestId('chapter-selector')).toBeVisible();

    // Default: first chapter is displayed
    const markdownBody = page.getByTestId('chapter-markdown-body');
    await expect(markdownBody).toBeVisible();
    await expect(markdownBody).toContainText('リモートワークの背景を解説');

    // Switch to chapter 2 via selector
    await page.getByTestId('chapter-selector').selectOption({ index: 1 });

    // Content should change to chapter 2
    await expect(markdownBody).toContainText('メリットとデメリットを論じ');
    // Chapter 1 content should no longer be visible
    await expect(markdownBody).not.toContainText('リモートワークの背景を解説');

    // Switch to chapter 3
    await page.getByTestId('chapter-selector').selectOption({ index: 2 });

    // Content should change to chapter 3
    await expect(markdownBody).toContainText('結論と今後の展望');
    await expect(markdownBody).not.toContainText('メリットとデメリットを論じ');
  });

  // -------------------------------------------------------------------------
  // 2. 章タブ: 章なし
  // -------------------------------------------------------------------------
  test('2. 章タブ: 章がない書籍で「章本文」タブに切替えると空メッセージが表示される', async ({
    page,
  }) => {
    const ctx = await seedBase('ch-empty');

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // Click chapters tab
    await page.getByTestId('tab-chapters').click();

    // Empty state
    await expect(page.getByTestId('chapters-tab-empty')).toBeVisible();
    // Since bookStatus is 'running', it should show writerInProgress message
    await expect(page.getByTestId('chapters-tab-empty')).toContainText(
      'Writer ジョブ進行中',
    );

    // Markdown viewer should NOT be present
    await expect(page.getByTestId('chapter-markdown-viewer')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 3. コスト内訳タブ: データあり
  // -------------------------------------------------------------------------
  test('3. コスト内訳タブ: token_usage レコードがある書籍でテーブルに provider/model/role 列 + 合計行が表示される', async ({
    page,
  }) => {
    const ctx = await seedBase('cost-data');

    // Create token_usage records with various provider x model x role combos
    await prisma.tokenUsage.createMany({
      data: [
        {
          book_id: ctx.bookId,
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          role: 'writer',
          input_tokens: 15000,
          output_tokens: 8000,
          cached_input_tokens: 2000,
          image_count: 0,
          unit_price_snapshot: {
            input_per_mtok_usd: 3.0,
            output_per_mtok_usd: 15.0,
            fx_rate_usd_jpy: 155.0,
          } as unknown as Prisma.InputJsonValue,
          cost_jpy: 25.575,
        },
        {
          book_id: ctx.bookId,
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          role: 'editor',
          input_tokens: 10000,
          output_tokens: 5000,
          cached_input_tokens: 1000,
          image_count: 0,
          unit_price_snapshot: {
            input_per_mtok_usd: 3.0,
            output_per_mtok_usd: 15.0,
            fx_rate_usd_jpy: 155.0,
          } as unknown as Prisma.InputJsonValue,
          cost_jpy: 16.275,
        },
        {
          book_id: ctx.bookId,
          provider: 'openai',
          model: 'gpt-image-1',
          role: 'thumbnail_image',
          input_tokens: 0,
          output_tokens: 0,
          cached_input_tokens: 0,
          image_count: 1,
          unit_price_snapshot: {
            image_per_image_usd: 0.04,
            fx_rate_usd_jpy: 155.0,
          } as unknown as Prisma.InputJsonValue,
          cost_jpy: 6.2,
        },
      ],
    });

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // Switch to cost tab
    await page.getByTestId('tab-cost').click();

    // cost-tab should be visible (not empty)
    await expect(page.getByTestId('cost-tab')).toBeVisible();

    // cost-breakdown-table should be visible
    const table = page.getByTestId('cost-breakdown-table');
    await expect(table).toBeVisible();

    // Table header columns: provider, model, role
    await expect(table).toContainText('プロバイダ');
    await expect(table).toContainText('モデル');
    await expect(table).toContainText('役割');
    await expect(table).toContainText('入力トークン');
    await expect(table).toContainText('出力トークン');
    await expect(table).toContainText('コスト (円)');
    await expect(table).toContainText('呼出回数');

    // There should be 3 cost breakdown rows
    const rows = page.getByTestId('cost-breakdown-row');
    await expect(rows).toHaveCount(3);

    // Provider names should be displayed (capitalized)
    await expect(table).toContainText('Anthropic');
    await expect(table).toContainText('Openai');

    // Model names should be displayed
    await expect(table).toContainText('claude-sonnet-4-20250514');
    await expect(table).toContainText('gpt-image-1');

    // Roles should be displayed (localized)
    await expect(table).toContainText('Writer');
    await expect(table).toContainText('Editor');

    // Total row should be present
    await expect(table).toContainText('合計');
  });

  // -------------------------------------------------------------------------
  // 4. コスト内訳タブ: データなし
  // -------------------------------------------------------------------------
  test('4. コスト内訳タブ: token_usage レコードがない書籍で「コスト内訳」タブに空メッセージが表示される', async ({
    page,
  }) => {
    const ctx = await seedBase('cost-empty');

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // Switch to cost tab
    await page.getByTestId('tab-cost').click();

    // Empty state
    await expect(page.getByTestId('cost-tab-empty')).toBeVisible();
    await expect(page.getByTestId('cost-tab-empty')).toContainText(
      'コスト記録はまだありません',
    );

    // Table should NOT be present
    await expect(page.getByTestId('cost-breakdown-table')).toHaveCount(0);
  });
});
