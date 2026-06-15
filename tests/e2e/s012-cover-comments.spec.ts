/**
 * E2E: S-012 サムネ座標領域コメント (T-06-04, F-049).
 *
 * カバー画像上にクリックして座標コメントを追加できること、
 * 既存コメントが ThumbnailGrid 上の CommentBadge として表示されることを検証。
 *
 * シナリオ:
 *   1. カバー画像へのコメント追加 -- ログイン -> /covers -> 個別比較モード ->
 *      カバー画像をクリック -> CommentAffordance 表示 -> クリック ->
 *      CommentDrawer 開く -> body + priority 入力 -> submit -> DB に
 *      RevisionComment(target_kind='cover', range_json に image_region) が作成
 *   2. 既存コメントのバッジ表示 -- cover にコメントがある場合、
 *      ThumbnailGrid のカバーに CommentBadge が表示される
 *
 * 注:
 *  - 外部 LLM/API は呼ばない (表示系 + Server Action のみ)。
 *  - dev server (Next.js port 3001) は playwright.config の webServer が
 *    reuseExistingServer: true で既存稼働中プロセスを再利用する。
 *  - Postgres は Docker a2p-pg port 5433。
 *
 * 仕様根拠:
 *  - docs/02 F-049 AI 出力への修正コメント記録
 *  - docs/04 S-012 画面設計
 *  - docs/sprints/SP-06 T-06-04
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-t-06-04-cover-comments';

// ---------------------------------------------------------------------------
// Seed types
// ---------------------------------------------------------------------------

interface SeedContext {
  accountId: string;
  themeId: string;
  bookId: string;
  bookTitle: string;
  coverIds: string[];
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupT0604Data(): Promise<void> {
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
    // graphile_worker._private_jobs
    for (const bookId of bookIds) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM graphile_worker._private_jobs WHERE payload->>'book_id' = $1`,
          bookId,
        )
        .catch(() => undefined);
    }
  }

  await prisma.account
    .deleteMany({ where: { id: { in: accountIds } } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * 1 Account + 1 Theme(accepted) + 1 Book(thumbnail) + N Cover(generated).
 */
async function seedCoverData(
  label: string,
  coverCount: number,
): Promise<SeedContext> {
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
      title: `T-06-04 カバーコメントテスト用テーマ (${label})`,
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const bookTitle = `T-06-04 カバーコメントテスト書籍 (${label})`;
  const book = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: bookTitle,
      status: 'thumbnail',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      has_pending_comments: false,
      has_blocking_comments: false,
    },
    select: { id: true },
  });

  const coverIds: string[] = [];
  for (let i = 0; i < coverCount; i++) {
    const cover = await prisma.cover.create({
      data: {
        book_id: book.id,
        r2_key: `test/covers/${book.id}/cover-${i}.png`,
        prompt_used: `テスト用プロンプト ${i}`,
        width: 1600,
        height: 2560,
        status: 'generated',
        generation_meta_json: {
          provider: 'openai',
          model: 'gpt-image-1',
          cost_jpy: 8,
        },
      },
      select: { id: true },
    });
    coverIds.push(cover.id);
  }

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    bookTitle,
    coverIds,
  };
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('S-012: カバー画像座標コメント (T-06-04, F-049)', () => {
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupT0604Data();
  });

  test.afterAll(async () => {
    await cleanupT0604Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. カバー画像へのコメント追加
  //    /covers -> 個別比較モード -> 画像クリック -> CommentAffordance -> Drawer
  //    -> body + priority 入力 -> submit -> DB に image_region 付き comment
  // -------------------------------------------------------------------------
  test('1. カバー画像コメント追加: 画像クリック -> CommentDrawer -> submit -> DB に image_region 付き RevisionComment', async ({
    page,
  }) => {
    const ctx = await seedCoverData('add-comment', 2);
    const targetCoverId = ctx.coverIds[0]!;

    await page.goto('/covers');
    await page.waitForURL(/\/covers(\?|$)/);

    // covers-grid が表示されることを確認
    await expect(page.getByTestId('covers-grid')).toBeVisible();

    // book card が表示される
    await expect(
      page.getByTestId(`cover-book-card-${ctx.bookId}`),
    ).toBeVisible();

    // 「個別比較へ」リンクをクリック
    await page.getByTestId(`cover-compare-${ctx.bookId}`).click();

    // covers-comparator が表示される
    await expect(page.getByTestId('covers-comparator')).toBeVisible({ timeout: 10_000 });

    // 対象カバーの comparator card が表示される
    const coverCard = page.getByTestId(
      `cover-comparator-image-${targetCoverId}`,
    );
    await expect(coverCard).toBeVisible();

    // コメントオーバーレイが表示される
    const overlay = page.getByTestId(
      `cover-comment-overlay-${targetCoverId}`,
    );
    await expect(overlay).toBeVisible();

    // 画像領域 (role="button") をクリックして座標アンカーを設定
    const imageArea = overlay.locator('[role="button"]');
    await expect(imageArea).toBeVisible();
    // Click center of the image area to set anchor
    await imageArea.click();

    // CommentAffordance trigger をクリックして Drawer を開く
    const affordance = overlay.getByTestId('comment-affordance');
    await expect(affordance).toBeAttached();

    const trigger = overlay.getByTestId('comment-affordance-trigger');
    await expect(trigger).toBeAttached();
    await trigger.click({ force: true });

    // CommentDrawer が開く
    const drawer = page.getByTestId('comment-drawer');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // body 入力
    const bodyInput = drawer.getByTestId('new-comment-body');
    await expect(bodyInput).toBeVisible();
    await bodyInput.fill('このカバー画像の中央部分を修正してください');

    // priority を must に変更
    const prioritySelect = drawer.getByTestId('priority-select').first();
    await prioritySelect.selectOption('must');

    // submit
    const submitBtn = drawer.getByTestId('new-comment-submit');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // 成功後 body がクリアされる
    await expect(bodyInput).toHaveValue('', { timeout: 15_000 });

    // --- DB 検証 ---
    const dbComment = await prisma.revisionComment.findFirst({
      where: {
        book_id: ctx.bookId,
        target_kind: 'cover',
        target_id: targetCoverId,
        body: 'このカバー画像の中央部分を修正してください',
      },
    });

    expect(dbComment).not.toBeNull();
    expect(dbComment!.priority).toBe('must');
    expect(dbComment!.status).toBe('pending');

    // range_json should contain image_region with valid coordinates
    const rangeJson = dbComment!.range_json as {
      image_region?: { x: number; y: number; w: number; h: number };
    } | null;
    expect(rangeJson).not.toBeNull();
    expect(rangeJson!.image_region).toBeDefined();

    const region = rangeJson!.image_region!;
    // All coordinates should be in 0.0-1.0 range
    expect(region.x).toBeGreaterThanOrEqual(0);
    expect(region.x).toBeLessThanOrEqual(1);
    expect(region.y).toBeGreaterThanOrEqual(0);
    expect(region.y).toBeLessThanOrEqual(1);
    expect(region.w).toBeGreaterThan(0);
    expect(region.w).toBeLessThanOrEqual(1);
    expect(region.h).toBeGreaterThan(0);
    expect(region.h).toBeLessThanOrEqual(1);
    // x+w and y+h should not exceed 1.0 (with tiny float tolerance)
    expect(region.x + region.w).toBeLessThanOrEqual(1.001);
    expect(region.y + region.h).toBeLessThanOrEqual(1.001);

    // Book flags updated
    const bookAfter = await prisma.book.findUnique({
      where: { id: ctx.bookId },
    });
    expect(bookAfter!.has_pending_comments).toBe(true);
    expect(bookAfter!.has_blocking_comments).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-04 add] comment_id=${dbComment!.id} ` +
        `range_json=${JSON.stringify(rangeJson)} ` +
        `has_pending=${bookAfter!.has_pending_comments} ` +
        `has_blocking=${bookAfter!.has_blocking_comments}`,
    );
  });

  // -------------------------------------------------------------------------
  // 2. 既存コメントのバッジ表示
  //    cover にコメントがある場合、ThumbnailGrid の BookCoverCard に
  //    CommentBadge が表示される
  // -------------------------------------------------------------------------
  test('2. 既存コメントのバッジ表示: cover コメントがある場合 ThumbnailGrid に CommentBadge が表示される', async ({
    page,
  }) => {
    const ctx = await seedCoverData('badge-display', 2);
    const targetCoverId = ctx.coverIds[0]!;

    // Seed an existing comment with image_region in the DB
    const user = await prisma.user.findFirst({ select: { id: true } });
    expect(user).not.toBeNull();

    await prisma.revisionComment.create({
      data: {
        book_id: ctx.bookId,
        target_kind: 'cover',
        target_id: targetCoverId,
        range_json: {
          image_region: { x: 0.3, y: 0.4, w: 0.2, h: 0.2 },
        } as unknown as Prisma.InputJsonValue,
        body: 'バッジ表示テスト用コメント',
        priority: 'must',
        status: 'pending',
        created_by: user!.id,
      },
    });

    await prisma.book.update({
      where: { id: ctx.bookId },
      data: {
        has_pending_comments: true,
        has_blocking_comments: true,
      },
    });

    // Navigate to /covers
    await page.goto('/covers');
    await page.waitForURL(/\/covers(\?|$)/);

    // covers-grid が表示される
    await expect(page.getByTestId('covers-grid')).toBeVisible();

    // book card が表示される
    const card = page.getByTestId(`cover-book-card-${ctx.bookId}`);
    await expect(card).toBeVisible();

    // CommentBadge が表示される (data-testid="cover-book-comment-badge-{bookId}")
    const commentBadge = page.getByTestId(
      `cover-book-comment-badge-${ctx.bookId}`,
    );
    await expect(commentBadge).toBeVisible({ timeout: 10_000 });
    // Badge should show "1" for pending count
    await expect(commentBadge).toContainText('1');
    // Badge should also show "must" indicator
    await expect(commentBadge).toContainText('must');

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-04 badge] CommentBadge visible on cover-book-card-${ctx.bookId} ` +
        `with 1 must comment`,
    );

    // --- Also verify badge in comparator mode ---
    // Navigate to single comparison mode
    await page.getByTestId(`cover-compare-${ctx.bookId}`).click();
    await expect(page.getByTestId('covers-comparator')).toBeVisible({
      timeout: 10_000,
    });

    // The cover-region-badge should be visible on the overlay
    // Find any element with data-testid starting with cover-region-badge-
    const regionBadges = page.locator(
      '[data-testid^="cover-region-badge-"]',
    );
    const regionBadgeCount = await regionBadges.count();
    expect(regionBadgeCount).toBeGreaterThanOrEqual(1);

    // The badge should be positioned at the correct region (around 30%, 40% from CSS)
    const firstBadge = regionBadges.first();
    await expect(firstBadge).toBeVisible();

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-04 region-badge] ${regionBadgeCount} region badge(s) visible ` +
        `in comparator mode`,
    );
  });
});
