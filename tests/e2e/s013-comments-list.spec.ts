/**
 * E2E: S-013 修正コメント一覧（横断） -- T-06-06 / F-049 / F-050.
 *
 * /comments 画面の表示・フィルタ・バルクアクション（優先度変更 / 削除）・
 * 空状態を Playwright でブラウザ経由検証。
 *
 * comments-runtime.spec.ts は SA コア層 (DB) を直接叩く統合検証で UI を介さない。
 * 本 spec は **ブラウザ UI 操作 -> SA -> DB -> router.refresh** のフルパスを検証する。
 *
 * 検証する 4 ケース:
 *   1. ページ表示 + KPI -- ログイン -> /comments -> KPI に pending/must 件数 -> テーブルにコメント行
 *   2. フィルタ -- priority フィルタで 'must' を選択 -> must コメントのみ表示
 *   3. バルク優先度変更 -- コメントを選択 -> 「優先度変更」-> may に変更 -> DB 反映
 *   4. 空状態 -- コメントがない場合の空メッセージ表示
 *
 * 注:
 *  - 外部 LLM/API は呼ばれない (表示系 + SA のみ)。
 *  - dev server (Next.js port 3001) は playwright.config の webServer が
 *    reuseExistingServer: true で既存稼働中プロセスを再利用する。
 *  - Postgres は Docker a2p-pg port 5433。
 *
 * 仕様根拠:
 *  - docs/02 F-049 AI 出力への修正コメント記録 (一覧表示)
 *  - docs/02 F-050 修正コメントの一括適用 (UI 準備)
 *  - docs/04 S-013 修正コメント一覧画面
 *  - docs/sprints/SP-06 T-06-06
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-s013-comments-list';

// ---------------------------------------------------------------------------
// Seed types
// ---------------------------------------------------------------------------

interface SeededComment {
  commentId: string;
  bookId: string;
  priority: string;
  targetKind: string;
  body: string;
}

interface SeededBook {
  bookId: string;
  title: string;
}

interface SeedContext {
  accountId: string;
  themeId: string;
  books: SeededBook[];
  comments: SeededComment[];
}

// ---------------------------------------------------------------------------
// User ID resolution (for created_by FK)
// ---------------------------------------------------------------------------

let realUserId: string | null = null;

async function resolveRealUserId(): Promise<string> {
  if (realUserId) return realUserId;
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    throw new Error(
      'users table empty -- run `pnpm --filter @a2p/db db:seed` first',
    );
  }
  realUserId = user.id;
  return realUserId;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupS013Data(): Promise<void> {
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

  // Account cascade => Book => RevisionComment
  await prisma.account
    .deleteMany({ where: { id: { in: accountIds } } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * Create Account + Theme + Books + RevisionComments.
 */
async function seedCommentsPage(
  label: string,
  bookSpecs: Array<{
    title: string;
    comments: Array<{
      targetKind: string;
      targetId: string;
      body: string;
      priority: string;
      status?: string;
    }>;
  }>,
): Promise<SeedContext> {
  const userId = await resolveRealUserId();

  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${label}-${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['test'],
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
      title: `S-013 ${label} test theme`,
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const allBooks: SeededBook[] = [];
  const allComments: SeededComment[] = [];

  for (const spec of bookSpecs) {
    const book = await prisma.book.create({
      data: {
        account_id: account.id,
        theme_id: theme.id,
        title: spec.title,
        status: 'running',
        prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
        model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
        has_pending_comments: false,
        has_blocking_comments: false,
      },
      select: { id: true },
    });
    allBooks.push({ bookId: book.id, title: spec.title });

    for (const c of spec.comments) {
      const comment = await prisma.revisionComment.create({
        data: {
          book_id: book.id,
          target_kind: c.targetKind,
          target_id: c.targetId,
          body: c.body,
          priority: c.priority,
          status: c.status ?? 'pending',
          created_by: userId,
        },
        select: { id: true },
      });
      allComments.push({
        commentId: comment.id,
        bookId: book.id,
        priority: c.priority,
        targetKind: c.targetKind,
        body: c.body,
      });
    }

    // Update book flags based on seeded comments
    const pendingCount = spec.comments.filter(
      (c) => (c.status ?? 'pending') === 'pending',
    ).length;
    const mustPendingCount = spec.comments.filter(
      (c) => (c.status ?? 'pending') === 'pending' && c.priority === 'must',
    ).length;
    await prisma.book.update({
      where: { id: book.id },
      data: {
        has_pending_comments: pendingCount > 0,
        has_blocking_comments: mustPendingCount > 0,
      },
    });
  }

  return {
    accountId: account.id,
    themeId: theme.id,
    books: allBooks,
    comments: allComments,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

test.describe('S-013: 修正コメント一覧（横断） (T-06-06, F-049/F-050)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS013Data();
  });

  test.afterAll(async () => {
    await cleanupS013Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. ページ表示 + KPI
  // -------------------------------------------------------------------------
  test('1. ページ表示 + KPI: /comments で KPI + テーブルにコメント行が表示される', async ({
    page,
  }) => {
    // Seed: 1 book with 3 comments (2 must, 1 should)
    const seeded = await seedCommentsPage('display', [
      {
        title: 'S-013 表示テスト書籍A',
        comments: [
          {
            targetKind: 'chapter',
            targetId: 'ch_1',
            body: '第1章にデータを追加してください',
            priority: 'must',
          },
          {
            targetKind: 'outline',
            targetId: 'outline_1',
            body: '構成を改善してください',
            priority: 'must',
          },
          {
            targetKind: 'metadata',
            targetId: 'meta_1',
            body: 'タイトル案を再検討',
            priority: 'should',
          },
        ],
      },
    ]);

    await page.goto('/comments');
    await page.waitForURL(/\/comments(\?|$)/);

    // comments-page が見える
    await expect(page.getByTestId('comments-page')).toBeVisible();

    // パンくず
    const breadcrumb = page.locator('nav[aria-label="breadcrumb"]');
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toContainText('ホーム');
    await expect(breadcrumb).toContainText('修正コメント一覧');

    // KPI パネルが見える
    await expect(page.getByTestId('comments-summary-kpi')).toBeVisible();

    // pending count = 3
    const kpiPending = page.getByTestId('kpi-pending');
    await expect(kpiPending).toBeVisible();
    await expect(kpiPending).toContainText('3');

    // must count = 2
    const kpiMust = page.getByTestId('kpi-must');
    await expect(kpiMust).toBeVisible();
    await expect(kpiMust).toContainText('2');

    // affected books = 1
    const kpiBooks = page.getByTestId('kpi-affected-books');
    await expect(kpiBooks).toBeVisible();
    await expect(kpiBooks).toContainText('1');

    // estimated cost = 150 (3 * 50)
    const kpiCost = page.getByTestId('kpi-estimated-cost');
    await expect(kpiCost).toBeVisible();
    await expect(kpiCost).toContainText('150');

    // フィルタバーが見える
    await expect(page.getByTestId('comments-filter-bar')).toBeVisible();

    // テーブルが見える
    await expect(page.getByTestId('comments-table')).toBeVisible();

    // 各コメント行が存在する
    for (const c of seeded.comments) {
      const row = page.getByTestId(`comment-row-${c.commentId}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(c.body.slice(0, 40));
    }

    // 空状態は表示されない
    await expect(page.getByTestId('comments-empty-state')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 2. フィルタ (priority = must)
  // -------------------------------------------------------------------------
  test('2. フィルタ: priority で must を選択すると must コメントのみ表示される', async ({
    page,
  }) => {
    // Clean + reseed to ensure known state
    await cleanupS013Data();
    await cleanupTransientData();

    const seeded = await seedCommentsPage('filter', [
      {
        title: 'S-013 フィルタテスト書籍',
        comments: [
          {
            targetKind: 'chapter',
            targetId: 'ch_filter_1',
            body: 'must コメント1',
            priority: 'must',
          },
          {
            targetKind: 'chapter',
            targetId: 'ch_filter_2',
            body: 'should コメント1',
            priority: 'should',
          },
          {
            targetKind: 'outline',
            targetId: 'outline_filter_1',
            body: 'may コメント1',
            priority: 'may',
          },
        ],
      },
    ]);

    await page.goto('/comments');
    await expect(page.getByTestId('comments-table')).toBeVisible();

    // Initial state: all 3 comments visible
    for (const c of seeded.comments) {
      await expect(
        page.getByTestId(`comment-row-${c.commentId}`),
      ).toBeVisible();
    }

    // KPI shows pending=3
    await expect(page.getByTestId('kpi-pending')).toContainText('3');

    // Select priority = must
    const priorityFilter = page.getByTestId('filter-priority');
    await priorityFilter.selectOption('must');

    // Only must comment visible
    const mustComment = seeded.comments.find((c) => c.priority === 'must')!;
    const shouldComment = seeded.comments.find(
      (c) => c.priority === 'should',
    )!;
    const mayComment = seeded.comments.find((c) => c.priority === 'may')!;

    await expect(
      page.getByTestId(`comment-row-${mustComment.commentId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`comment-row-${shouldComment.commentId}`),
    ).toHaveCount(0);
    await expect(
      page.getByTestId(`comment-row-${mayComment.commentId}`),
    ).toHaveCount(0);

    // KPI updates to reflect filtered view (pending=1, must=1)
    await expect(page.getByTestId('kpi-pending')).toContainText('1');
    await expect(page.getByTestId('kpi-must')).toContainText('1');

    // Reset filter to all
    await priorityFilter.selectOption('');

    // All 3 comments visible again
    for (const c of seeded.comments) {
      await expect(
        page.getByTestId(`comment-row-${c.commentId}`),
      ).toBeVisible();
    }
    await expect(page.getByTestId('kpi-pending')).toContainText('3');
  });

  // -------------------------------------------------------------------------
  // 3. バルク優先度変更 (must -> may)
  // -------------------------------------------------------------------------
  test('3. バルク優先度変更: コメント選択 -> 優先度変更 -> may -> DB 反映', async ({
    page,
  }) => {
    // Clean + reseed
    await cleanupS013Data();
    await cleanupTransientData();

    const seeded = await seedCommentsPage('bulk-priority', [
      {
        title: 'S-013 バルク優先度テスト書籍',
        comments: [
          {
            targetKind: 'chapter',
            targetId: 'ch_bulk_1',
            body: 'バルク変更対象コメント1',
            priority: 'must',
          },
          {
            targetKind: 'chapter',
            targetId: 'ch_bulk_2',
            body: 'バルク変更対象コメント2',
            priority: 'must',
          },
          {
            targetKind: 'outline',
            targetId: 'outline_bulk_1',
            body: 'バルク変更しないコメント',
            priority: 'should',
          },
        ],
      },
    ]);

    await page.goto('/comments');
    await expect(page.getByTestId('comments-table')).toBeVisible();

    // Verify initial KPI: must=2
    await expect(page.getByTestId('kpi-must')).toContainText('2');

    // Select the two must comments
    const mustComments = seeded.comments.filter((c) => c.priority === 'must');
    for (const c of mustComments) {
      await page
        .getByTestId(`comment-checkbox-${c.commentId}`)
        .check();
    }

    // Bulk action bar should appear
    await expect(
      page.getByTestId('comments-bulk-action-bar'),
    ).toBeVisible();
    await expect(
      page.getByTestId('comments-bulk-selection-count'),
    ).toContainText('2');

    // Click "priority change" button
    await page.getByTestId('comments-bulk-priority').click();

    // Priority modal opens
    await expect(
      page.getByTestId('comments-priority-modal'),
    ).toBeVisible();

    // Select "may" in the modal select
    await page.getByTestId('priority-select').selectOption('may');

    // Submit
    await page.getByTestId('priority-submit').click();

    // Wait for router.refresh -> page reloads with updated data.
    // After SA call + router.refresh the priority modal closes
    // and the page re-renders with updated comments.
    // Wait for success info message or the modal to close.
    await expect(
      page.getByTestId('comments-priority-modal'),
    ).toHaveCount(0, { timeout: 15_000 });

    // Verify DB: both comments now have priority='may'
    for (const c of mustComments) {
      const updated = await prisma.revisionComment.findUnique({
        where: { id: c.commentId },
      });
      expect(updated).not.toBeNull();
      expect(updated!.priority).toBe('may');
      expect(updated!.status).toBe('pending');
    }

    // After router.refresh, KPI must count should be 0
    // (page re-rendered from server with updated data)
    await expect(page.getByTestId('kpi-must')).toContainText(
      '0',
      { timeout: 10_000 },
    );
  });

  // -------------------------------------------------------------------------
  // 4. 空状態
  // -------------------------------------------------------------------------
  test('4. 空状態: コメントが 0 件のとき comments-empty-state が表示される', async ({
    page,
  }) => {
    // Clean everything
    await cleanupS013Data();
    await cleanupTransientData();

    await page.goto('/comments');
    await page.waitForURL(/\/comments(\?|$)/);

    // Empty state visible
    await expect(page.getByTestId('comments-empty-state')).toBeVisible();
    await expect(page.getByTestId('comments-empty-state')).toContainText(
      '未消化の修正コメントはありません',
    );

    // CTA link to books
    await expect(page.getByTestId('comments-empty-cta')).toBeVisible();
    await expect(page.getByTestId('comments-empty-cta')).toContainText(
      '書籍ライブラリへ',
    );

    // Table and KPI should not be rendered
    await expect(page.getByTestId('comments-table')).toHaveCount(0);
    await expect(page.getByTestId('comments-summary-kpi')).toHaveCount(0);
  });
});
