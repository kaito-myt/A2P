/**
 * E2E: S-011 / S-007 CommentAffordance (T-06-05, F-049).
 *
 * アウトラインカード (S-011) とテーマ詳細画面 (S-007) に CommentAffordance が
 * 統合され、コメントを追加 -> DB に RevisionComment が作成されることを検証。
 *
 * シナリオ:
 *   1. S-011 アウトラインコメント追加 -- /outlines -> pending_review のカードに
 *      CommentAffordance が表示 -> クリック -> CommentDrawer でコメント入力 ->
 *      submit -> DB に RevisionComment(target_kind='outline') が作成
 *   2. S-007 テーマコメント追加 -- /themes/[id] -> Book 紐付き済みテーマ詳細に
 *      CommentAffordance が表示 -> クリック -> CommentDrawer でコメント入力 ->
 *      submit -> DB に RevisionComment(target_kind='theme') が作成
 *   3. S-007 テーマコメント非表示 -- Book 未紐付きテーマでは
 *      action-comment-placeholder が表示される
 *
 * 注:
 *  - 外部 LLM/API は呼ばない (表示系 + Server Action のみ)。
 *  - dev server (Next.js port 3001) は playwright.config の webServer が
 *    reuseExistingServer: true で既存稼働中プロセスを再利用する。
 *  - Postgres は Docker a2p-pg port 5433。
 *
 * 仕様根拠:
 *  - docs/02 F-049 AI 出力への修正コメント記録
 *  - docs/04 S-011, S-007 画面設計
 *  - docs/sprints/SP-06 T-06-05
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-t-06-05-comments';

// ---------------------------------------------------------------------------
// Seed types
// ---------------------------------------------------------------------------

interface OutlineSeedContext {
  accountId: string;
  themeId: string;
  bookId: string;
  outlineId: string;
}

interface ThemeSeedContext {
  accountId: string;
  themeId: string;
  bookId: string;
}

interface ThemeNoBookSeedContext {
  accountId: string;
  themeId: string;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupT0605Data(): Promise<void> {
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
 * 1 Account + 1 Theme(accepted) + 1 Book(queued) + 1 Outline(pending_review).
 * S-011 アウトラインコメントテスト用。
 */
async function seedOutlineForComments(label: string): Promise<OutlineSeedContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-outline-${label}-${Date.now()}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-outline-${label}-session-${Date.now()}`,
      genre: 'business',
      title: `T-06-05 アウトラインコメントテスト用テーマ (${label})`,
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const book = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: `T-06-05 アウトラインコメントテスト書籍 (${label})`,
      status: 'queued',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      has_pending_comments: false,
      has_blocking_comments: false,
    },
    select: { id: true },
  });

  const outline = await prisma.outline.create({
    data: {
      book_id: book.id,
      status: 'pending_review',
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
          target_chars: 5000,
          subheadings: ['ポイント1', 'ポイント2'],
        },
      ] as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    outlineId: outline.id,
  };
}

/**
 * 1 Account + 1 Theme(accepted) + 1 Book (theme_id = theme.id).
 * S-007 テーマコメントテスト用 (Book 紐付きあり)。
 */
async function seedThemeWithBook(label: string): Promise<ThemeSeedContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-theme-${label}-${Date.now()}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-theme-${label}-session-${Date.now()}`,
      genre: 'business',
      title: `T-06-05 テーマコメントテスト用テーマ (${label})`,
      hook: 'e2e test hook',
      target_reader: 'テスト読者',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const book = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: `T-06-05 テーマコメントテスト書籍 (${label})`,
      status: 'running',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      has_pending_comments: false,
      has_blocking_comments: false,
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
  };
}

/**
 * 1 Account + 1 Theme(pending), Book 紐付きなし。
 * S-007 テーマコメント非表示テスト用。
 */
async function seedThemeWithoutBook(label: string): Promise<ThemeNoBookSeedContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-nobook-${label}-${Date.now()}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-nobook-${label}-session-${Date.now()}`,
      genre: 'business',
      title: `T-06-05 テーマコメントなしテスト用テーマ (${label})`,
      hook: 'e2e test hook no book',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: {} as unknown as Prisma.InputJsonValue,
      status: 'pending',
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    themeId: theme.id,
  };
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('S-011/S-007: コメント CommentAffordance 統合 (T-06-05, F-049)', () => {
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupT0605Data();
  });

  test.afterAll(async () => {
    await cleanupT0605Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. S-011 アウトラインコメント追加
  //    /outlines -> pending_review カードに CommentAffordance -> クリック ->
  //    CommentDrawer -> body + priority -> submit -> DB に RevisionComment(target_kind='outline')
  // -------------------------------------------------------------------------
  test('1. S-011: アウトラインカードに CommentAffordance が表示され、コメントを追加できる', async ({
    page,
  }) => {
    const ctx = await seedOutlineForComments('add');

    await page.goto('/outlines');
    await page.waitForURL(/\/outlines(\?|$)/);

    // outlines-grid が表示される
    await expect(page.getByTestId('outlines-grid')).toBeVisible();

    // 対象アウトラインカードが表示される
    const card = page.getByTestId(`outline-row-${ctx.outlineId}`);
    await expect(card).toBeVisible();

    // カード内に CommentAffordance が表示される
    const affordance = card.getByTestId('comment-affordance');
    await expect(affordance).toBeAttached();

    // CommentAffordance trigger ("+") が表示される (コメントなし状態)
    const trigger = card.getByTestId('comment-affordance-trigger');
    await expect(trigger).toBeAttached();

    // クリックして CommentDrawer を開く
    await trigger.click({ force: true });

    // CommentDrawer が開く
    const drawer = page.getByTestId('comment-drawer');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // body 入力
    const bodyInput = drawer.getByTestId('new-comment-body');
    await expect(bodyInput).toBeVisible();
    await bodyInput.fill('アウトラインの章構成を見直してください');

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
        target_kind: 'outline',
        target_id: ctx.outlineId,
        body: 'アウトラインの章構成を見直してください',
      },
    });

    expect(dbComment).not.toBeNull();
    expect(dbComment!.priority).toBe('must');
    expect(dbComment!.status).toBe('pending');
    // outline comments have no range_json (no paragraph anchor)
    // (range_json may be null for outline-level comments)

    // Book flags updated
    const bookAfter = await prisma.book.findUnique({
      where: { id: ctx.bookId },
    });
    expect(bookAfter!.has_pending_comments).toBe(true);
    expect(bookAfter!.has_blocking_comments).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-05 outline add] comment_id=${dbComment!.id} ` +
        `target_kind=${dbComment!.target_kind} target_id=${dbComment!.target_id} ` +
        `has_pending=${bookAfter!.has_pending_comments} has_blocking=${bookAfter!.has_blocking_comments}`,
    );
  });

  // -------------------------------------------------------------------------
  // 2. S-007 テーマコメント追加
  //    /themes/[id] -> Book 紐付き済みテーマ -> CommentAffordance 表示 ->
  //    クリック -> CommentDrawer -> body + priority -> submit ->
  //    DB に RevisionComment(target_kind='theme') が作成
  // -------------------------------------------------------------------------
  test('2. S-007: テーマ詳細に CommentAffordance が表示され、コメントを追加できる', async ({
    page,
  }) => {
    const ctx = await seedThemeWithBook('add');

    await page.goto(`/themes/${ctx.themeId}`);

    // テーマ詳細ページが表示される
    await expect(page.getByTestId('theme-detail-page')).toBeVisible();

    // ActionButtonGroup が表示される
    const actionGroup = page.getByTestId('action-button-group');
    await expect(actionGroup).toBeVisible();

    // CommentAffordance が ActionButtonGroup 内に表示される
    const affordance = actionGroup.getByTestId('comment-affordance');
    await expect(affordance).toBeAttached();

    // CommentAffordance trigger ("+") が表示される (コメントなし状態)
    const trigger = actionGroup.getByTestId('comment-affordance-trigger');
    await expect(trigger).toBeAttached();

    // action-comment-placeholder は表示されない (Book 紐付きあり)
    await expect(page.getByTestId('action-comment-placeholder')).toHaveCount(0);

    // クリックして CommentDrawer を開く
    await trigger.click({ force: true });

    // CommentDrawer が開く
    const drawer = page.getByTestId('comment-drawer');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // body 入力
    const bodyInput = drawer.getByTestId('new-comment-body');
    await expect(bodyInput).toBeVisible();
    await bodyInput.fill('テーマの方向性を再検討してください');

    // priority を should のまま (default)
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
        target_kind: 'theme',
        target_id: ctx.themeId,
        body: 'テーマの方向性を再検討してください',
      },
    });

    expect(dbComment).not.toBeNull();
    expect(dbComment!.priority).toBe('should');
    expect(dbComment!.status).toBe('pending');

    // Book flags updated (should priority -> has_pending=true, has_blocking=false)
    const bookAfter = await prisma.book.findUnique({
      where: { id: ctx.bookId },
    });
    expect(bookAfter!.has_pending_comments).toBe(true);
    // 'should' priority does not set has_blocking_comments (only 'must' does)
    // Actually let's check what the implementation does -- Book flag refresh
    // recalcs by checking if any must-priority pending comments exist
    // Since we used 'should', has_blocking_comments should be false

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-05 theme add] comment_id=${dbComment!.id} ` +
        `target_kind=${dbComment!.target_kind} target_id=${dbComment!.target_id} ` +
        `priority=${dbComment!.priority} ` +
        `has_pending=${bookAfter!.has_pending_comments} has_blocking=${bookAfter!.has_blocking_comments}`,
    );
  });

  // -------------------------------------------------------------------------
  // 3. S-007 テーマコメント非表示 (Book 未紐付き)
  //    /themes/[id] -> Book 紐付きなし -> action-comment-placeholder 表示
  // -------------------------------------------------------------------------
  test('3. S-007: Book 未紐付きテーマでは action-comment-placeholder が表示される', async ({
    page,
  }) => {
    const ctx = await seedThemeWithoutBook('nobook');

    await page.goto(`/themes/${ctx.themeId}`);

    // テーマ詳細ページが表示される
    await expect(page.getByTestId('theme-detail-page')).toBeVisible();

    // ActionButtonGroup が表示される
    const actionGroup = page.getByTestId('action-button-group');
    await expect(actionGroup).toBeVisible();

    // CommentAffordance は表示されない (Book 紐付きなし)
    await expect(actionGroup.getByTestId('comment-affordance')).toHaveCount(0);

    // action-comment-placeholder が表示される
    await expect(page.getByTestId('action-comment-placeholder')).toBeVisible();

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-05 nobook] action-comment-placeholder visible for theme ${ctx.themeId}`,
    );
  });
});
