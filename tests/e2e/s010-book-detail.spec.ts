/**
 * E2E: S-010 書籍詳細・章エディタ（読取側） — T-04-09.
 *
 * 書籍詳細画面 (/books/[id]) の表示と各タブ切替を Playwright で検証。
 *
 * 検証する 5 ケース:
 *   1. ページ表示: ログイン済み → /books/[id] → BookHeader (タイトル, ステータスバッジ)
 *   2. 全8タブ表示: 8 つのタブがすべて存在し、クリックで切替可能
 *   3. アウトラインタブ: アウトラインデータがある書籍で章リスト表示
 *   4. ジョブ履歴タブ: ジョブデータがある書籍でジョブ行が表示される
 *   5. 存在しないIDで404: /books/nonexistent-id で 404 表示
 *
 * 注:
 *  - 外部 LLM/API は呼ばない (表示系のみの検証)。
 *  - dev server (Next.js port 3001) は playwright.config の webServer が
 *    reuseExistingServer: true で既存稼働中プロセスを再利用する。
 *  - Postgres は Docker a2p-pg port 5433。
 *
 * 仕様根拠:
 *  - docs/02 F-003〜F-005 ライター/エディター関連（読取表示）
 *  - docs/04 S-010 書籍詳細画面
 *  - docs/sprints/SP-04 T-04-09
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-s010-book-detail';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeedContext {
  accountId: string;
  themeId: string;
  bookId: string;
  bookTitle: string;
  outlineId?: string;
  chapterIds?: string[];
  jobIds?: string[];
}

/**
 * 本 spec で投入した行を Account の pen_name 前方一致で識別して削除。
 * Account 削除で cascade により Book / Outline / Chapter が落ちる。
 * Job は book FK が SetNull なので先に消す。
 */
async function cleanupS010Data(): Promise<void> {
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
 * options で outline / chapters / jobs を追加可能。
 */
async function seedBookDetail(
  label: string,
  options: {
    bookStatus?: string;
    withOutline?: boolean;
    outlineStatus?: string;
    withChapters?: number;
    withJobs?: number;
  } = {},
): Promise<SeedContext> {
  const {
    bookStatus = 'queued',
    withOutline = false,
    outlineStatus = 'pending_review',
    withChapters = 0,
    withJobs = 0,
  } = options;

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
      title: `S-010 ${label} テスト用テーマ`,
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const bookTitle = `S-010 ${label} テスト書籍`;
  const book = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: bookTitle,
      status: bookStatus,
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  const ctx: SeedContext = {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    bookTitle,
  };

  // Outline
  if (withOutline) {
    const outline = await prisma.outline.create({
      data: {
        book_id: book.id,
        status: outlineStatus,
        chapters_json: [
          {
            index: 1,
            heading: 'はじめに',
            summary: '導入部分',
            target_chars: 5000,
            subheadings: ['背景', '目的'],
          },
          {
            index: 2,
            heading: '本論',
            summary: '主要トピック',
            target_chars: 8000,
            subheadings: ['ポイント1', 'ポイント2', 'ポイント3'],
          },
          {
            index: 3,
            heading: 'まとめ',
            summary: '結論',
            target_chars: 4000,
            subheadings: ['結論', '次のステップ'],
          },
        ] as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    ctx.outlineId = outline.id;
  }

  // Chapters
  if (withChapters > 0) {
    const chapterIds: string[] = [];
    for (let i = 1; i <= withChapters; i++) {
      const ch = await prisma.chapter.create({
        data: {
          book_id: book.id,
          index: i,
          heading: `第${i}章テスト見出し`,
          body_md: `# 第${i}章\n\nテスト本文です。`,
          status: 'done',
          char_count: 3000 + i * 100,
          version: 1,
        },
        select: { id: true },
      });
      chapterIds.push(ch.id);
    }
    ctx.chapterIds = chapterIds;
  }

  // Jobs
  if (withJobs > 0) {
    const jobIds: string[] = [];
    const jobKinds = [
      'pipeline.book.kickoff',
      'pipeline.book.marketer',
      'pipeline.book.writer.outline',
      'pipeline.book.writer.chapter',
      'pipeline.book.editor',
    ];
    for (let i = 0; i < withJobs; i++) {
      const kind = jobKinds[i % jobKinds.length]!;
      const job = await prisma.job.create({
        data: {
          kind,
          book_id: book.id,
          status: i === 0 ? 'done' : 'queued',
          payload_json: { book_id: book.id } as unknown as Prisma.InputJsonValue,
          started_at: i === 0 ? new Date(Date.now() - 60_000) : null,
          finished_at: i === 0 ? new Date() : null,
          retries: 0,
        },
        select: { id: true },
      });
      jobIds.push(job.id);
    }
    ctx.jobIds = jobIds;
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('S-010: 書籍詳細画面 (T-04-09)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS010Data();
  });

  test.afterAll(async () => {
    await cleanupS010Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. ページ表示 — BookHeader にタイトル + ステータスバッジが見える
  // -------------------------------------------------------------------------
  test('1. ページ表示: /books/[id] で BookHeader にタイトルとステータスバッジが表示される', async ({
    page,
  }) => {
    const ctx = await seedBookDetail('display', {
      bookStatus: 'running',
      withOutline: true,
      outlineStatus: 'approved',
    });

    await page.goto(`/books/${ctx.bookId}`);
    await page.waitForURL(new RegExp(`/books/${ctx.bookId}`));

    // book-detail-page が見える
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // BookHeader が見える
    await expect(page.getByTestId('book-header')).toBeVisible();

    // タイトルが表示されている
    await expect(page.getByTestId('book-header')).toContainText(ctx.bookTitle);

    // ステータスバッジが表示されている (「実行中」= running の日本語表記)
    await expect(page.getByTestId('book-status-badge')).toBeVisible();
    await expect(page.getByTestId('book-status-badge')).toContainText('実行中');

    // コストバーが表示されている
    await expect(page.getByTestId('book-cost-bar')).toBeVisible();

    // パンくずリストにタイトルが含まれている
    const breadcrumb = page.locator('nav[aria-label="breadcrumb"]');
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toContainText('ホーム');
    await expect(breadcrumb).toContainText('書籍ライブラリ');
    await expect(breadcrumb).toContainText(ctx.bookTitle);
  });

  // -------------------------------------------------------------------------
  // 2. 全8タブ表示 — 8つのタブが存在し、クリックで切替可能
  // -------------------------------------------------------------------------
  test('2. 全8タブ: アウトライン/章本文/カバー/メタデータ/評価履歴/コスト内訳/ジョブ履歴/コメント が存在しクリック切替可能', async ({
    page,
  }) => {
    const ctx = await seedBookDetail('tabs', {
      withOutline: true,
      outlineStatus: 'pending_review',
    });

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // タブリストが見える
    await expect(page.getByTestId('book-tabs-list')).toBeVisible();

    // 8 つのタブが全て存在する
    const tabTestIds = [
      'tab-outline',
      'tab-chapters',
      'tab-cover',
      'tab-metadata',
      'tab-evaluation',
      'tab-cost',
      'tab-jobs',
      'tab-comments',
    ] as const;

    for (const testId of tabTestIds) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }

    // デフォルトで outline タブが active (outline-tab が見える)
    await expect(page.getByTestId('outline-tab')).toBeVisible();

    // 各タブをクリックして切替を確認
    // chapters タブ
    await page.getByTestId('tab-chapters').click();
    await expect(page.getByTestId('chapters-tab-empty')).toBeVisible();

    // cover タブ (placeholder)
    await page.getByTestId('tab-cover').click();
    await expect(page.getByTestId('placeholder-tab')).toBeVisible();

    // metadata タブ (placeholder)
    await page.getByTestId('tab-metadata').click();
    await expect(page.getByTestId('placeholder-tab')).toBeVisible();

    // evaluation タブ (placeholder)
    await page.getByTestId('tab-evaluation').click();
    await expect(page.getByTestId('placeholder-tab')).toBeVisible();

    // cost タブ (empty — T-04-10 で CostTab 実装済み)
    await page.getByTestId('tab-cost').click();
    await expect(page.getByTestId('cost-tab-empty')).toBeVisible();

    // jobs タブ (empty)
    await page.getByTestId('tab-jobs').click();
    await expect(page.getByTestId('job-history-tab-empty')).toBeVisible();

    // comments タブ (placeholder)
    await page.getByTestId('tab-comments').click();
    await expect(page.getByTestId('placeholder-tab')).toBeVisible();

    // outline タブに戻る
    await page.getByTestId('tab-outline').click();
    await expect(page.getByTestId('outline-tab')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 3. アウトラインタブ — 章リストが表示される
  // -------------------------------------------------------------------------
  test('3. アウトラインタブ: pending_review のアウトラインで章リスト + 承認/差戻しボタンが表示される', async ({
    page,
  }) => {
    const ctx = await seedBookDetail('outline', {
      withOutline: true,
      outlineStatus: 'pending_review',
    });

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // アウトラインタブが表示されている (デフォルトタブ)
    await expect(page.getByTestId('outline-tab')).toBeVisible();

    // ステータスメタ情報が見える
    await expect(page.getByTestId('outline-meta')).toBeVisible();
    await expect(page.getByTestId('outline-meta')).toContainText('承認待ち');

    // 章リストが表示されている
    await expect(page.getByTestId('outline-chapters-list')).toBeVisible();

    // 3 章分のカードが表示されている
    await expect(page.getByTestId('outline-chapter-1')).toBeVisible();
    await expect(page.getByTestId('outline-chapter-1')).toContainText('はじめに');
    await expect(page.getByTestId('outline-chapter-1')).toContainText('導入部分');

    await expect(page.getByTestId('outline-chapter-2')).toBeVisible();
    await expect(page.getByTestId('outline-chapter-2')).toContainText('本論');

    await expect(page.getByTestId('outline-chapter-3')).toBeVisible();
    await expect(page.getByTestId('outline-chapter-3')).toContainText('まとめ');

    // 承認/差戻しアクションボタンが表示されている (pending_review なので)
    await expect(page.getByTestId('outline-actions')).toBeVisible();
    await expect(page.getByTestId('outline-approve-btn')).toBeVisible();
    await expect(page.getByTestId('outline-reject-btn')).toBeVisible();

    // 小見出しが表示されている
    await expect(page.getByTestId('outline-chapter-1')).toContainText('背景');
    await expect(page.getByTestId('outline-chapter-1')).toContainText('目的');

    // 想定総文字数が表示されている (5000 + 8000 + 4000 = 17,000)
    await expect(page.getByTestId('outline-meta')).toContainText('17,000');
  });

  // -------------------------------------------------------------------------
  // 3b. アウトラインタブ — approved の場合は承認/差戻しボタンが非表示
  // -------------------------------------------------------------------------
  test('3b. アウトラインタブ: approved のアウトラインでは承認/差戻しボタンが非表示', async ({
    page,
  }) => {
    const ctx = await seedBookDetail('outline-approved', {
      bookStatus: 'running',
      withOutline: true,
      outlineStatus: 'approved',
    });

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();
    await expect(page.getByTestId('outline-tab')).toBeVisible();

    // 承認済みステータス
    await expect(page.getByTestId('outline-meta')).toContainText('承認済み');

    // 章リストは表示される
    await expect(page.getByTestId('outline-chapters-list')).toBeVisible();

    // 承認/差戻しボタンは非表示
    await expect(page.getByTestId('outline-actions')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 3c. アウトラインタブ — アウトラインなしの場合は空表示
  // -------------------------------------------------------------------------
  test('3c. アウトラインタブ: アウトラインなしの場合に空メッセージが表示される', async ({
    page,
  }) => {
    const ctx = await seedBookDetail('no-outline', {
      withOutline: false,
    });

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // 空状態メッセージが表示される
    await expect(page.getByTestId('outline-tab-empty')).toBeVisible();
    await expect(page.getByTestId('outline-tab-empty')).toContainText(
      'アウトラインは未生成です',
    );
  });

  // -------------------------------------------------------------------------
  // 4. ジョブ履歴タブ — ジョブ行が表示される
  // -------------------------------------------------------------------------
  test('4. ジョブ履歴タブ: ジョブデータがある書籍でジョブ行が表示される', async ({
    page,
  }) => {
    const ctx = await seedBookDetail('jobs', {
      bookStatus: 'running',
      withOutline: true,
      outlineStatus: 'approved',
      withJobs: 3,
    });

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // ジョブ履歴タブに切替
    await page.getByTestId('tab-jobs').click();

    // ジョブ履歴テーブルが見える
    await expect(page.getByTestId('job-history-tab')).toBeVisible();

    // 3 行のジョブ行が見える
    for (const jobId of ctx.jobIds!) {
      await expect(page.getByTestId(`job-row-${jobId}`)).toBeVisible();
    }

    // テーブルヘッダのカラムが見える
    await expect(page.getByTestId('job-history-tab')).toContainText('種別');
    await expect(page.getByTestId('job-history-tab')).toContainText('ステータス');
  });

  // -------------------------------------------------------------------------
  // 4b. ジョブ履歴タブ — ジョブなしの場合は空表示
  // -------------------------------------------------------------------------
  test('4b. ジョブ履歴タブ: ジョブなしの場合に空メッセージが表示される', async ({
    page,
  }) => {
    const ctx = await seedBookDetail('no-jobs', {
      withOutline: true,
    });

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // ジョブ履歴タブに切替
    await page.getByTestId('tab-jobs').click();

    // 空状態
    await expect(page.getByTestId('job-history-tab-empty')).toBeVisible();
    await expect(page.getByTestId('job-history-tab-empty')).toContainText(
      'ジョブ履歴はまだありません',
    );
  });

  // -------------------------------------------------------------------------
  // 5. 存在しないIDで404
  // -------------------------------------------------------------------------
  test('5. 存在しないIDで404: /books/nonexistent-id で 404 ページが表示される', async ({
    page,
  }) => {
    const response = await page.goto('/books/nonexistent-id-12345');

    // Next.js の notFound() は 404 を返す
    expect(response?.status()).toBe(404);
  });
});
