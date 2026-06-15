/**
 * E2E: S-010 章本文の段落アンカーコメント (T-06-03, F-049).
 *
 * 書籍詳細画面 (/books/[id]) の「章本文」タブで、段落ごとに
 * CommentAffordance が表示され、コメントを追加できることを検証。
 *
 * シナリオ:
 *   1. 段落コメント追加 — 段落ホバー -> CommentAffordance 表示 -> クリック ->
 *      CommentDrawer 開く -> body + priority 入力 -> submit -> DB に
 *      RevisionComment が range_json = { paragraph_range: [N, N] } で作成される
 *   2. 既存コメント表示 — コメントがある段落に CommentBadge が表示される
 *
 * 注:
 *  - 外部 LLM/API は呼ばない (表示系 + Server Action のみ)。
 *  - dev server (Next.js port 3001) は playwright.config の webServer が
 *    reuseExistingServer: true で既存稼働中プロセスを再利用する。
 *  - Postgres は Docker a2p-pg port 5433。
 *  - paragraph index は react-markdown + React Strict Mode の影響で
 *    連番とならない場合がある (1,3,5 等)。テストでは DOM から実際の
 *    data-paragraph-index を動的に読み取る方式を採用。
 *
 * 仕様根拠:
 *  - docs/02 F-049 AI 出力への修正コメント記録
 *  - docs/04 S-010 書籍詳細画面
 *  - docs/sprints/SP-06 T-06-03
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-t-06-03-para-comments';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeedContext {
  accountId: string;
  themeId: string;
  bookId: string;
  bookTitle: string;
  chapterId: string;
}

/**
 * Cleanup rows created by this spec (Account cascade deletes Book -> Chapter, RevisionComment).
 */
async function cleanupT0603Data(): Promise<void> {
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
 * Seed: 1 Account + 1 Theme + 1 Book + 1 Chapter with multi-paragraph body_md.
 * The body_md has 3 paragraphs separated by blank lines.
 */
async function seedBookWithChapter(label: string): Promise<SeedContext> {
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
      title: `T-06-03 段落コメントテスト用テーマ (${label})`,
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const bookTitle = `T-06-03 段落コメントテスト書籍 (${label})`;
  const book = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: bookTitle,
      status: 'running',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      has_pending_comments: false,
      has_blocking_comments: false,
    },
    select: { id: true },
  });

  // Chapter with 3 paragraphs in body_md (react-markdown renders each as <p>)
  const bodyMd = [
    '第一段落です。ここでは導入部分について述べます。テストのための段落です。',
    '',
    '第二段落です。主要なトピックについて説明します。コメント機能のテスト対象です。',
    '',
    '第三段落です。まとめとして結論を述べます。段落アンカーの検証用です。',
  ].join('\n');

  const chapter = await prisma.chapter.create({
    data: {
      book_id: book.id,
      index: 1,
      heading: '第1章 テスト見出し',
      body_md: bodyMd,
      status: 'done',
      char_count: bodyMd.length,
      version: 1,
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    bookTitle,
    chapterId: chapter.id,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('S-010: 段落アンカーコメント (T-06-03, F-049)', () => {
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupT0603Data();
  });

  test.afterAll(async () => {
    await cleanupT0603Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. 段落コメント追加: hover -> affordance -> drawer -> submit -> DB 確認
  // -------------------------------------------------------------------------
  test('1. 段落コメント追加: CommentAffordance クリック -> CommentDrawer でコメント送信 -> DB に range_json 付きで保存', async ({
    page,
  }) => {
    const ctx = await seedBookWithChapter('add-comment');

    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // Switch to chapters tab
    await page.getByTestId('tab-chapters').click();
    await expect(page.getByTestId('chapters-tab')).toBeVisible();

    // Verify the markdown viewer is rendered
    await expect(page.getByTestId('chapter-markdown-viewer')).toBeVisible();
    const mdBody = page.getByTestId('chapter-markdown-body');
    await expect(mdBody).toBeVisible();

    // Find all paragraph wrapper divs (they have data-testid matching "paragraph-N").
    // The actual index values depend on react-markdown + React Strict Mode and may
    // not be sequential 0,1,2. We discover them dynamically.
    const paragraphDivs = mdBody.locator('[data-testid^="paragraph-"]');
    const paragraphCount = await paragraphDivs.count();
    expect(paragraphCount).toBeGreaterThanOrEqual(3);

    // Get the first paragraph's actual data-paragraph-index
    const firstPara = paragraphDivs.first();
    await expect(firstPara).toBeVisible();
    const firstParaIndex = await firstPara.getAttribute('data-paragraph-index');
    expect(firstParaIndex).not.toBeNull();

    // Verify the first paragraph contains expected text
    await expect(firstPara).toContainText('第一段落です');

    // Each paragraph should have a CommentAffordance
    const affordance = firstPara.getByTestId('comment-affordance');
    await expect(affordance).toBeAttached();

    // Hover over the paragraph to reveal the CommentAffordance trigger
    await firstPara.hover();

    // Click the affordance trigger (force because opacity transition)
    const trigger = firstPara.getByTestId('comment-affordance-trigger');
    await expect(trigger).toBeAttached();
    await trigger.click({ force: true });

    // CommentDrawer should open
    const drawer = page.getByTestId('comment-drawer');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // Fill in comment body
    const bodyInput = drawer.getByTestId('new-comment-body');
    await expect(bodyInput).toBeVisible();
    await bodyInput.fill('この段落に具体的なデータを追加してください');

    // Select priority (default is 'should', change to 'must')
    const prioritySelect = drawer.getByTestId('priority-select').first();
    await prioritySelect.selectOption('must');

    // Submit
    const submitBtn = drawer.getByTestId('new-comment-submit');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Wait for the comment to be created -- the body textarea resets to empty on success
    await expect(bodyInput).toHaveValue('', { timeout: 15_000 });

    // Verify DB: RevisionComment created with correct range_json
    const dbComment = await prisma.revisionComment.findFirst({
      where: {
        book_id: ctx.bookId,
        target_kind: 'chapter',
        target_id: ctx.chapterId,
        body: 'この段落に具体的なデータを追加してください',
      },
    });

    expect(dbComment).not.toBeNull();
    expect(dbComment!.priority).toBe('must');
    expect(dbComment!.status).toBe('pending');

    // range_json should contain paragraph_range tuple matching the actual index
    const rangeJson = dbComment!.range_json as { paragraph_range?: number[] } | null;
    expect(rangeJson).not.toBeNull();
    expect(rangeJson!.paragraph_range).toBeDefined();
    expect(rangeJson!.paragraph_range).toHaveLength(2);
    // Both elements of the tuple should be the same (single paragraph anchor)
    expect(rangeJson!.paragraph_range![0]).toBe(rangeJson!.paragraph_range![1]);
    // The value should match the data-paragraph-index we observed in the DOM
    expect(rangeJson!.paragraph_range![0]).toBe(Number(firstParaIndex));

    // Verify book flags updated
    const bookAfter = await prisma.book.findUnique({ where: { id: ctx.bookId } });
    expect(bookAfter!.has_pending_comments).toBe(true);
    expect(bookAfter!.has_blocking_comments).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-03 add] comment_id=${dbComment!.id} ` +
        `range_json=${JSON.stringify(rangeJson)} ` +
        `has_pending=${bookAfter!.has_pending_comments} has_blocking=${bookAfter!.has_blocking_comments}`,
    );
  });

  // -------------------------------------------------------------------------
  // 2. 既存コメント表示: DB にコメントがある段落に CommentBadge が表示される
  // -------------------------------------------------------------------------
  test('2. 既存コメント表示: コメントがある段落に CommentBadge が表示される', async ({
    page,
  }) => {
    // First, seed a book with a chapter.
    const ctx = await seedBookWithChapter('existing-badge');

    // Navigate to the page to discover the actual paragraph index for the second paragraph.
    // We need the real index to create the DB comment with matching range_json.
    await page.goto(`/books/${ctx.bookId}`);
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    await page.getByTestId('tab-chapters').click();
    await expect(page.getByTestId('chapters-tab')).toBeVisible();
    await expect(page.getByTestId('chapter-markdown-viewer')).toBeVisible();

    const mdBody = page.getByTestId('chapter-markdown-body');
    const paragraphDivs = mdBody.locator('[data-testid^="paragraph-"]');
    const count = await paragraphDivs.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Find the paragraph containing "第二段落"
    let secondParaIndex: number | null = null;
    for (let i = 0; i < count; i++) {
      const el = paragraphDivs.nth(i);
      const text = await el.textContent();
      if (text?.includes('第二段落')) {
        const idx = await el.getAttribute('data-paragraph-index');
        secondParaIndex = Number(idx);
        break;
      }
    }
    expect(secondParaIndex).not.toBeNull();

    // Now seed a comment in the DB with the actual paragraph index
    const user = await prisma.user.findFirst({ select: { id: true } });
    expect(user).not.toBeNull();

    await prisma.revisionComment.create({
      data: {
        book_id: ctx.bookId,
        target_kind: 'chapter',
        target_id: ctx.chapterId,
        range_json: {
          paragraph_range: [secondParaIndex!, secondParaIndex!],
        } as unknown as Prisma.InputJsonValue,
        body: '第二段落の内容を具体例で補強してください',
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

    // Reload the page to pick up the new comment
    await page.reload();
    await expect(page.getByTestId('book-detail-page')).toBeVisible();

    // Switch to chapters tab again
    await page.getByTestId('tab-chapters').click();
    await expect(page.getByTestId('chapters-tab')).toBeVisible();
    await expect(page.getByTestId('chapter-markdown-viewer')).toBeVisible();

    // Find the paragraph with the comment (second paragraph by text content)
    const mdBodyReloaded = page.getByTestId('chapter-markdown-body');
    const secondPara = mdBodyReloaded.locator(
      `[data-testid="paragraph-${secondParaIndex}"]`,
    );
    await expect(secondPara).toBeVisible();

    // The CommentAffordance for this paragraph should show a CommentBadge
    // (not the "+" trigger) because there are pending comments.
    const affordance = secondPara.getByTestId('comment-affordance');
    await expect(affordance).toBeAttached();

    // CommentBadge renders with role="button" when clickable.
    // It should be visible (always shown, not hidden by hover).
    const badge = affordance.locator('[role="button"]');
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toContainText('1');

    // Verify the first paragraph (no comment) still has the "+" trigger.
    // Find by text content since paragraph indices are dynamic.
    const allParas = mdBodyReloaded.locator('[data-testid^="paragraph-"]');
    let firstParaLocator = allParas.first();
    for (let i = 0; i < await allParas.count(); i++) {
      const el = allParas.nth(i);
      const text = await el.textContent();
      if (text?.includes('第一段落')) {
        firstParaLocator = el;
        break;
      }
    }
    const firstAffordanceTrigger = firstParaLocator.getByTestId(
      'comment-affordance-trigger',
    );
    await expect(firstAffordanceTrigger).toBeAttached();

    // Click the badge on the second paragraph to open drawer
    await badge.click();

    const drawer = page.getByTestId('comment-drawer');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // The drawer should show existing comments section with 1 comment
    const existingSection = drawer.getByTestId('existing-comments');
    await expect(existingSection).toBeVisible();

    const commentRow = drawer.getByTestId('comment-row').first();
    await expect(commentRow).toBeVisible();
    await expect(commentRow.getByTestId('comment-body')).toContainText(
      '第二段落の内容を具体例で補強してください',
    );
    await expect(
      commentRow.getByTestId('comment-priority-badge'),
    ).toContainText('must');

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-03 existing] comment badge visible on paragraph index=${secondParaIndex}, drawer shows existing comment`,
    );
  });
});
