/**
 * E2E: S-014 修正一括反映 進捗・diff レビュー UI -- T-06-09 / F-050.
 *
 * /revision-runs/[id] 詳細ページ (RunHeader + GlobalProgressBar +
 * BookProgressCardList + DiffReviewer + CostRecordTable + ActionBar) と
 * /revision-runs リストページのブラウザ表示をフルパスで検証する。
 *
 * revision-runs-runtime.spec.ts は SA core 層 (createRevisionRunCore) を
 * 直接呼ぶ統合検証で UI を介さない。本 spec は **ブラウザ描画 + SSR -> Client
 * Component hydration** のフルパスを検証する。
 *
 * 検証する 4 ケース:
 *   1. ページ表示 -- ログイン -> /revision-runs/[id] -> RunHeader + GlobalProgressBar +
 *      BookProgressCardList が表示
 *   2. 完了 run の diff 表示 -- status='done' の RevisionRun -> DiffReviewer タブで
 *      章本文 diff が表示
 *   3. リストページ -- /revision-runs -> 最近の run がリスト表示
 *   4. 存在しない ID -- /revision-runs/nonexistent -> 404
 *
 * 注:
 *   - 外部 LLM/API は呼ばれない (表示系のみ)。
 *   - dev server は playwright.config の webServer が reuseExistingServer で管理。
 *   - Postgres は Docker a2p-pg port 5433。
 *
 * 仕様根拠:
 *   - docs/02 F-050 修正コメントの一括適用 (進捗/diff 表示)
 *   - docs/04 S-014 修正一括反映 実行・進捗・diff レビュー
 *   - docs/sprints/SP-06 T-06-09
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-s014-revision-runs-ui';

// ---------------------------------------------------------------------------
// User ID resolution (audit_log FK / RevisionRun.triggered_by)
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

const insertedRunIds: string[] = [];

async function cleanupS014Data(): Promise<void> {
  // Clear run_id on comments pointing to our runs before deleting runs
  if (insertedRunIds.length > 0) {
    await prisma.revisionComment
      .updateMany({
        where: { run_id: { in: insertedRunIds } },
        data: { run_id: null },
      })
      .catch(() => undefined);
    await prisma.revisionRun
      .deleteMany({ where: { id: { in: insertedRunIds } } })
      .catch(() => undefined);
    insertedRunIds.length = 0;
  }

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

  // Account cascade => Book => Chapter => ChapterRevision, RevisionComment
  await prisma.account
    .deleteMany({ where: { id: { in: accountIds } } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeededContext {
  accountId: string;
  themeId: string;
  bookId: string;
  bookTitle: string;
  chapterIds: string[];
  commentIds: string[];
  runId: string;
}

/**
 * Seed a full RevisionRun scenario for UI testing.
 * Creates: Account -> Theme -> Book -> Chapters -> ChapterRevisions ->
 * RevisionRun -> RevisionComments (linked to run).
 */
async function seedRevisionRunScenario(
  label: string,
  opts: {
    runStatus: string;
    commentStatuses: Array<{
      status: string;
      targetKind: string;
      body: string;
      priority: string;
      applicationResult?: Record<string, unknown> | null;
    }>;
    /** If true, creates chapter + chapterRevision for diff display. */
    withChapterDiff?: boolean;
    finishedAt?: Date | null;
  },
): Promise<SeededContext> {
  const userId = await resolveRealUserId();
  const ts = Date.now();

  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${label}-${ts}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-${label}-session-${ts}`,
      genre: 'business',
      title: `S-014 ${label} test theme`,
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const bookTitle = `S-014 ${label} テスト書籍`;
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

  // Create chapters if needed for diff display
  const chapterIds: string[] = [];
  if (opts.withChapterDiff) {
    const chapter = await prisma.chapter.create({
      data: {
        book_id: book.id,
        index: 1,
        heading: '第1章 テスト章',
        body_md: 'これは修正後の章本文です。\n改善されたテキストが入っています。',
        status: 'done',
        char_count: 30,
        version: 2,
      },
      select: { id: true },
    });
    chapterIds.push(chapter.id);
  }

  // Create the RevisionRun first (before comments, so we can link them)
  const triggeredAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
  const run = await prisma.revisionRun.create({
    data: {
      triggered_by: userId,
      triggered_at: triggeredAt,
      started_at: new Date(triggeredAt.getTime() + 1000),
      finished_at: opts.finishedAt !== undefined
        ? opts.finishedAt
        : opts.runStatus === 'done' || opts.runStatus === 'partial' || opts.runStatus === 'failed'
          ? new Date()
          : null,
      status: opts.runStatus,
      book_ids_json: [book.id] as unknown as Prisma.InputJsonValue,
      comment_ids_json: [] as unknown as Prisma.InputJsonValue, // will update after creating comments
      result_summary_json: {
        applied: opts.commentStatuses.filter((c) => c.status === 'applied').length,
        not_applicable: opts.commentStatuses.filter((c) => c.status === 'not_applicable').length,
        failed: 0,
        cost_jpy: 0,
        blocked_books: [],
      } as unknown as Prisma.InputJsonValue,
      error: opts.runStatus === 'failed' ? 'Test error message' : null,
    },
    select: { id: true },
  });
  insertedRunIds.push(run.id);

  // Create comments linked to the run
  const commentIds: string[] = [];
  for (let i = 0; i < opts.commentStatuses.length; i++) {
    const spec = opts.commentStatuses[i]!;
    const targetId = spec.targetKind === 'chapter' && chapterIds.length > 0
      ? chapterIds[0]!
      : `target_${label}_${i}_${ts}`;

    const comment = await prisma.revisionComment.create({
      data: {
        book_id: book.id,
        target_kind: spec.targetKind,
        target_id: targetId,
        body: spec.body,
        priority: spec.priority,
        status: spec.status,
        run_id: run.id,
        created_by: userId,
        applied_at: spec.status === 'applied' ? new Date() : null,
        application_result_json: spec.applicationResult
          ? (spec.applicationResult as unknown as Prisma.InputJsonValue)
          : null,
      },
      select: { id: true },
    });
    commentIds.push(comment.id);
  }

  // Update run with comment IDs
  await prisma.revisionRun.update({
    where: { id: run.id },
    data: {
      comment_ids_json: commentIds as unknown as Prisma.InputJsonValue,
    },
  });

  // Create ChapterRevision for diff (old version) if needed
  if (opts.withChapterDiff && chapterIds.length > 0) {
    await prisma.chapterRevision.create({
      data: {
        chapter_id: chapterIds[0]!,
        book_id: book.id,
        version: 1,
        body_md: 'これは修正前の章本文です。\n元のテキストが入っています。',
        reason: `revision_run:${run.id}`,
      },
    });
  }

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    bookTitle,
    chapterIds,
    commentIds,
    runId: run.id,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

test.describe('S-014: 修正一括反映 進捗・diff レビュー UI (T-06-09, F-050)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS014Data();
  });

  test.afterAll(async () => {
    await cleanupS014Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. ページ表示 -- RunHeader + GlobalProgressBar + BookProgressCardList
  // -------------------------------------------------------------------------
  test('1. /revision-runs/[id] で RunHeader + GlobalProgressBar + BookProgressCardList が表示される', async ({
    page,
  }) => {
    const seeded = await seedRevisionRunScenario('page-display', {
      runStatus: 'running',
      commentStatuses: [
        { status: 'applied', targetKind: 'chapter', body: '適用済みコメント1', priority: 'must' },
        { status: 'pending', targetKind: 'chapter', body: '未処理コメント2', priority: 'should' },
        { status: 'pending', targetKind: 'outline', body: '未処理コメント3', priority: 'may' },
      ],
    });

    await page.goto(`/revision-runs/${seeded.runId}`);

    // revision-run-page wrapper
    await expect(page.getByTestId('revision-run-page')).toBeVisible();

    // RevisionRunShell
    await expect(page.getByTestId('revision-run-shell')).toBeVisible();

    // RunHeader
    const header = page.getByTestId('run-header');
    await expect(header).toBeVisible();
    // Contains the truncated run ID
    await expect(header).toContainText(seeded.runId.slice(0, 12));

    // Header meta
    const meta = page.getByTestId('run-header-meta');
    await expect(meta).toBeVisible();
    // Books count
    await expect(meta).toContainText('1');
    // Comments count
    await expect(meta).toContainText('3');
    // Status badge (running = 実行中)
    const badge = page.getByTestId('run-status-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('実行中');

    // GlobalProgressBar
    const progressBar = page.getByTestId('global-progress-bar');
    await expect(progressBar).toBeVisible();
    // 1 applied out of 3 => "1 / 3 コメント処理済"
    await expect(progressBar).toContainText('1 / 3');

    // BookProgressCardList
    const cardList = page.getByTestId('book-progress-card-list');
    await expect(cardList).toBeVisible();
    const cards = page.getByTestId('book-progress-card');
    await expect(cards).toHaveCount(1);
    // Card shows book title
    await expect(cards.first()).toContainText(seeded.bookTitle);

    // ActionBar is visible
    await expect(page.getByTestId('action-bar')).toBeVisible();
    // "追加コメント記入" button always visible
    await expect(page.getByTestId('action-add-comment')).toBeVisible();
    // "書籍詳細へ" button (firstBookId is set)
    await expect(page.getByTestId('action-book-detail')).toBeVisible();

    // Status is 'running' -> no tabs (diff/cost only shown when complete)
    await expect(page.getByTestId('revision-run-tabs')).toHaveCount(0);
    // Status is 'running' -> no approve/rollback buttons
    await expect(page.getByTestId('action-approve')).toHaveCount(0);
    await expect(page.getByTestId('action-rollback')).toHaveCount(0);

    // Breadcrumb navigation
    const breadcrumb = page.locator('nav[aria-label="breadcrumb"]');
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toContainText('ホーム');
    await expect(breadcrumb).toContainText('書籍');
    await expect(breadcrumb).toContainText('修正コメント');
  });

  // -------------------------------------------------------------------------
  // 2. 完了した run の diff 表示
  // -------------------------------------------------------------------------
  test('2. status=done の RevisionRun で DiffReviewer タブが表示され章本文 diff を確認できる', async ({
    page,
  }) => {
    const seeded = await seedRevisionRunScenario('diff-display', {
      runStatus: 'done',
      withChapterDiff: true,
      commentStatuses: [
        {
          status: 'applied',
          targetKind: 'chapter',
          body: '章の内容を改善してください',
          priority: 'must',
        },
        {
          status: 'not_applicable',
          targetKind: 'metadata',
          body: 'メタデータ修正不要',
          priority: 'should',
          applicationResult: { reason: 'メタデータに変更対象が見つかりませんでした' },
        },
      ],
    });

    await page.goto(`/revision-runs/${seeded.runId}`);

    // Shell visible
    await expect(page.getByTestId('revision-run-shell')).toBeVisible();

    // Status badge shows 完了
    await expect(page.getByTestId('run-status-badge')).toContainText('完了');

    // Progress bar: 2/2 processed (1 applied + 1 not_applicable)
    const progressBar = page.getByTestId('global-progress-bar');
    await expect(progressBar).toContainText('2 / 2');
    // "完了" label shown for done/partial status
    await expect(progressBar).toContainText('完了');

    // Tabs should be visible (status = done)
    await expect(page.getByTestId('revision-run-tabs')).toBeVisible();

    // Diff tab is selected by default
    const diffTab = page.getByTestId('tab-diff');
    await expect(diffTab).toBeVisible();

    // DiffReviewer renders
    await expect(page.getByTestId('diff-reviewer')).toBeVisible();

    // Comment list inside DiffReviewer
    const commentList = page.getByTestId('diff-comment-list');
    await expect(commentList).toBeVisible();
    const commentItems = page.getByTestId('diff-comment-item');
    await expect(commentItems).toHaveCount(2);

    // First comment (chapter, applied) shows chapter diff
    await commentItems.first().click();
    const diffView = page.getByTestId('comment-diff-view');
    await expect(diffView).toBeVisible();
    // The chapter diff content should show
    const chapterDiff = page.getByTestId('chapter-diff');
    await expect(chapterDiff).toBeVisible();
    // Diff shows chapter heading
    await expect(chapterDiff).toContainText('第1章');
    await expect(chapterDiff).toContainText('テスト章');

    // Diff lines should be present (old = removed, new = added)
    // The revision body_md = "これは修正前の章本文です。\n元のテキストが入っています。"
    // The current body_md = "これは修正後の章本文です。\n改善されたテキストが入っています。"
    const removedLines = page.getByTestId('diff-line-removed');
    const addedLines = page.getByTestId('diff-line-added');
    await expect(removedLines.first()).toBeVisible();
    await expect(addedLines.first()).toBeVisible();

    // Second comment (metadata, not_applicable) shows placeholder
    await commentItems.nth(1).click();
    // Wait for the diff view to update
    await expect(page.getByTestId('comment-diff-view')).toContainText(
      'メタデータ修正不要',
    );
    // Metadata shows JSON diff placeholder
    await expect(page.getByTestId('diff-placeholder')).toBeVisible();

    // Complete status -> approve + rollback buttons visible
    await expect(page.getByTestId('action-approve')).toBeVisible();
    await expect(page.getByTestId('action-rollback')).toBeVisible();

    // Cost tab
    const costTab = page.getByTestId('tab-cost');
    await expect(costTab).toBeVisible();
    await costTab.click();
    // No token_usage rows seeded -> empty state
    await expect(page.getByTestId('cost-record-empty')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 3. リストページ
  // -------------------------------------------------------------------------
  test('3. /revision-runs にリストが表示される', async ({ page }) => {
    // Clean and reseed with 2 runs
    await cleanupS014Data();
    await cleanupTransientData();

    const run1 = await seedRevisionRunScenario('list-1', {
      runStatus: 'done',
      commentStatuses: [
        { status: 'applied', targetKind: 'chapter', body: 'リスト表示テスト1', priority: 'must' },
      ],
    });

    const run2 = await seedRevisionRunScenario('list-2', {
      runStatus: 'queued',
      commentStatuses: [
        { status: 'pending', targetKind: 'chapter', body: 'リスト表示テスト2', priority: 'should' },
        { status: 'pending', targetKind: 'outline', body: 'リスト表示テスト3', priority: 'may' },
      ],
    });

    await page.goto('/revision-runs');

    // List page wrapper
    await expect(page.getByTestId('revision-runs-list-page')).toBeVisible();

    // Table is visible (not empty state)
    const table = page.getByTestId('revision-runs-table');
    await expect(table).toBeVisible();
    await expect(page.getByTestId('revision-runs-empty-state')).toHaveCount(0);

    // Both runs appear as table rows with links
    // Run 1 link
    const run1Link = table.locator(`a[href="/revision-runs/${run1.runId}"]`);
    await expect(run1Link).toBeVisible();
    await expect(run1Link).toContainText(run1.runId.slice(0, 12));

    // Run 2 link
    const run2Link = table.locator(`a[href="/revision-runs/${run2.runId}"]`);
    await expect(run2Link).toBeVisible();
    await expect(run2Link).toContainText(run2.runId.slice(0, 12));

    // Table header columns
    await expect(table).toContainText('ステータス');
    await expect(table).toContainText('コメント');

    // Page title
    await expect(
      page.locator('h1'),
    ).toContainText('修正一括反映');

    // Click run1 link -> navigates to detail
    await run1Link.click();
    await page.waitForURL(new RegExp(`/revision-runs/${run1.runId}`));
    await expect(page.getByTestId('revision-run-page')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 4. 存在しない ID -> 404
  // -------------------------------------------------------------------------
  test('4. /revision-runs/nonexistent で 404 ページが表示される', async ({ page }) => {
    const response = await page.goto('/revision-runs/nonexistent-id-12345');
    // Next.js notFound() returns 404
    expect(response?.status()).toBe(404);
  });
});
