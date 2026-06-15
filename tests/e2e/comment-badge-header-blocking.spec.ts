/**
 * E2E: T-06-12 -- Header CommentBadge + BooksTable must blocking badge.
 *
 * F-049 AI output revision comments -- Header badge + blocking badge display.
 * S-009 books library -- has_blocking_comments badge in BooksTable.
 *
 * Scenarios:
 *   1. /api/comments/counts returns correct pending + must counts
 *   2. Header CommentBadgeHeader displays pending/must counts (via API fetch)
 *   3. BooksTable shows "must block" badge for books with has_blocking_comments=true
 *   4. BooksTable does NOT show blocking badge for books without must comments
 *
 * Notes:
 *  - No external LLM/API calls (display + API only).
 *  - dev server (Next.js port 3001) via playwright.config webServer.
 *  - Postgres via Docker a2p-pg port 5433.
 *  - CommentBadgeHeader polls every 30s; tests use API fetch for stability.
 *
 * Spec refs:
 *  - docs/02 F-049 AI revision comments (header badge)
 *  - docs/04 S-009 books library
 *  - docs/sprints/SP-06 T-06-12
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-t-06-12-comment-badge';

// ---------------------------------------------------------------------------
// Seed types
// ---------------------------------------------------------------------------

interface SeededContext {
  accountId: string;
  themeId: string;
  bookWithBlocking: {
    bookId: string;
    title: string;
    commentIds: string[];
  };
  bookWithoutBlocking: {
    bookId: string;
    title: string;
    commentIds: string[];
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupT0612Data(): Promise<void> {
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

  // Account cascade deletes Book -> RevisionComment
  await prisma.account
    .deleteMany({ where: { id: { in: accountIds } } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------

/**
 * Creates:
 *  - 1 Account + 1 Theme
 *  - Book A: has_blocking_comments=true, has_pending_comments=true
 *    with 2 must+pending comments and 1 should+pending comment
 *  - Book B: has_blocking_comments=false, has_pending_comments=true
 *    with 1 should+pending comment (no must)
 */
async function seedCommentBadgeData(): Promise<SeededContext> {
  const userId = await resolveUserId();
  const ts = Date.now();

  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${ts}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-session-${ts}`,
      genre: 'business',
      title: 'T-06-12 CommentBadge test theme',
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  // --- Book A: has must blocking comments ---
  const bookA = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: 'T-06-12 must block test book',
      status: 'running',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      has_pending_comments: true,
      has_blocking_comments: true,
    },
    select: { id: true },
  });

  // must+pending comment 1
  const c1 = await prisma.revisionComment.create({
    data: {
      book_id: bookA.id,
      target_kind: 'chapter',
      target_id: 'ch_test_1',
      body: 'T-06-12: must comment 1',
      priority: 'must',
      status: 'pending',
      created_by: userId,
    },
    select: { id: true },
  });

  // must+pending comment 2
  const c2 = await prisma.revisionComment.create({
    data: {
      book_id: bookA.id,
      target_kind: 'chapter',
      target_id: 'ch_test_2',
      body: 'T-06-12: must comment 2',
      priority: 'must',
      status: 'pending',
      created_by: userId,
    },
    select: { id: true },
  });

  // should+pending comment on book A
  const c3 = await prisma.revisionComment.create({
    data: {
      book_id: bookA.id,
      target_kind: 'outline',
      target_id: 'outline_test_1',
      body: 'T-06-12: should comment on book A',
      priority: 'should',
      status: 'pending',
      created_by: userId,
    },
    select: { id: true },
  });

  // --- Book B: no must comments (has_blocking_comments=false) ---
  const bookB = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: 'T-06-12 no block test book',
      status: 'done',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      has_pending_comments: true,
      has_blocking_comments: false,
    },
    select: { id: true },
  });

  // should+pending comment on book B
  const c4 = await prisma.revisionComment.create({
    data: {
      book_id: bookB.id,
      target_kind: 'metadata',
      target_id: 'meta_test_1',
      body: 'T-06-12: should comment on book B',
      priority: 'should',
      status: 'pending',
      created_by: userId,
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    themeId: theme.id,
    bookWithBlocking: {
      bookId: bookA.id,
      title: 'T-06-12 must block test book',
      commentIds: [c1.id, c2.id, c3.id],
    },
    bookWithoutBlocking: {
      bookId: bookB.id,
      title: 'T-06-12 no block test book',
      commentIds: [c4.id],
    },
  };
}

// ---------------------------------------------------------------------------
// User ID resolution
// ---------------------------------------------------------------------------

let cachedUserId: string | null = null;

async function resolveUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    throw new Error(
      'users table has no users. Run `pnpm --filter @a2p/db db:seed` first.',
    );
  }
  cachedUserId = user.id;
  return cachedUserId;
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('T-06-12: Header CommentBadge + BooksTable blocking badge', () => {
  test.setTimeout(60_000);

  let seeded: SeededContext;

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupT0612Data();
    seeded = await seedCommentBadgeData();
  });

  test.afterAll(async () => {
    await cleanupT0612Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. /api/comments/counts returns correct pending + must counts
  // -------------------------------------------------------------------------
  test('1. API /api/comments/counts returns correct pending + must counts', async ({
    page,
  }) => {
    // Navigate first to establish an authenticated session context
    await page.goto('/dashboard');
    await page.waitForURL(/\/(dashboard|$)/);

    // Call the API directly via the authenticated page context
    const response = await page.evaluate(async () => {
      const res = await fetch('/api/comments/counts');
      if (!res.ok) return { error: res.status };
      return res.json();
    });

    // Seeded data: 4 pending comments total, 2 must comments
    expect(response).toHaveProperty('pending');
    expect(response).toHaveProperty('must');
    expect(typeof response.pending).toBe('number');
    expect(typeof response.must).toBe('number');
    // At minimum our seeded data contributes 4 pending / 2 must
    // (other specs might have leftover data, so use >=)
    expect(response.pending).toBeGreaterThanOrEqual(4);
    expect(response.must).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // 2. Header CommentBadgeHeader displays pending/must counts
  // -------------------------------------------------------------------------
  test('2. Header CommentBadgeHeader displays pending and must counts', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await page.waitForURL(/\/(dashboard|$)/);

    // The CommentBadgeHeader uses aria-label="修正コメント"
    const badge = page.getByLabel('修正コメント');
    await expect(badge).toBeVisible({ timeout: 15_000 });

    // The badge text should contain "修正コメント" label
    await expect(badge).toContainText('修正コメント');

    // The badge also displays "(must: N)" pattern
    await expect(badge).toContainText('must');

    // Wait for the fetch to complete and display real counts.
    // The badge fetches on mount, so after a short wait the counts should appear.
    // The badge structure is: <span>修正コメント</span><span class="ml-1">N</span>...
    // The ml-1 class provides visual spacing but textContent has no whitespace.
    // We verify the pending count changes from 0 to our seeded data.
    await expect
      .poll(
        async () => {
          const text = await badge.textContent();
          return text ?? '';
        },
        { timeout: 15_000, message: 'Waiting for CommentBadgeHeader to reflect fetched counts' },
      )
      .not.toContain('修正コメント0');

    // Verify the badge is clickable (role="button")
    const role = await badge.getAttribute('role');
    expect(role).toBe('button');

    // Verify the badge variant -- with must > 0, the variant should be 'must'
    // which applies bg-destructive-bg class
    const className = await badge.getAttribute('class');
    expect(className).toBeTruthy();
    // The 'must' variant gives destructive styling; 'neutral' gives charcoal
    // With must > 0, the badge should use destructive (must variant)
    expect(className).toContain('destructive');
  });

  // -------------------------------------------------------------------------
  // 3. BooksTable shows "must block" badge for blocking book
  // -------------------------------------------------------------------------
  test('3. BooksTable: blocking badge visible for book with has_blocking_comments=true', async ({
    page,
  }) => {
    await page.goto('/books');
    await page.waitForURL(/\/books(\?|$)/);
    await expect(page.getByTestId('books-table')).toBeVisible();

    // Book A (blocking): should have book-blocking-badge-{id}
    const blockingBadge = page.getByTestId(
      `book-blocking-badge-${seeded.bookWithBlocking.bookId}`,
    );
    await expect(blockingBadge).toBeVisible();
    await expect(blockingBadge).toContainText('must ブロック中');

    // The blocking badge should link to /comments?priority=must&book={id}
    const href = await blockingBadge.getAttribute('href');
    expect(href).toBe(
      `/comments?priority=must&book=${seeded.bookWithBlocking.bookId}`,
    );
  });

  // -------------------------------------------------------------------------
  // 4. BooksTable does NOT show blocking badge for non-blocking book
  // -------------------------------------------------------------------------
  test('4. BooksTable: no blocking badge for book without must comments', async ({
    page,
  }) => {
    await page.goto('/books');
    await page.waitForURL(/\/books(\?|$)/);
    await expect(page.getByTestId('books-table')).toBeVisible();

    // Book B (no blocking): should NOT have book-blocking-badge-{id}
    const blockingBadge = page.getByTestId(
      `book-blocking-badge-${seeded.bookWithoutBlocking.bookId}`,
    );
    await expect(blockingBadge).toHaveCount(0);

    // Book B has has_pending_comments=true but no blocking,
    // so it should show the generic comment count link instead
    const bookRow = page.getByTestId(
      `book-row-${seeded.bookWithoutBlocking.bookId}`,
    );
    await expect(bookRow).toBeVisible();
  });
});
