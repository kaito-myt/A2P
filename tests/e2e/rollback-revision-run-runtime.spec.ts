/**
 * Runtime verification spec for T-06-11 -- rollbackRevisionRunCore SA core logic
 * (F-016 / F-050): ChapterRevision restoration + comment status reset +
 * Book flag recalculation.
 *
 * Playwright is used as test runner; the core function is invoked directly
 * against real PrismaClient + real PostgreSQL
 * (same pattern as revision-runs-runtime.spec.ts, comments-runtime.spec.ts).
 *
 * Scenarios:
 *   1. Chapter rollback -- Book + Chapter (version=3, body_md='modified') +
 *      ChapterRevision (version=2, body_md='original') + applied comment
 *      -> rollback -> Chapter.body_md='original' + version=4 + comment pending
 *   2. Book flag recalculation -- must comment applied -> rollback ->
 *      has_blocking_comments=true, has_pending_comments=true
 *   3. No applied comments -> not_found error
 *   4. Non-chapter comments -- cover comment reset to pending without chapter ops
 *
 * Mock target: none (no enqueueJob, no external API calls).
 * External API calls: zero. Cost: zero.
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { isOk, isFail } from '@a2p/contracts';
import {
  rollbackRevisionRunCore,
  type RollbackRevisionRunDeps,
  type RollbackRunTransactionFn,
} from '../../apps/web/lib/revision-runs-core.js';

const TEST_PEN_PREFIX = 'e2e-t-06-11-rollback';

// ---------------------------------------------------------------------------
// User ID resolution (audit_log FK)
// ---------------------------------------------------------------------------

let realUserId: string | null = null;

async function resolveRealUserId(): Promise<string> {
  if (realUserId) return realUserId;
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    throw new Error(
      'users table has no users. Run `pnpm --filter @a2p/db db:seed` first.',
    );
  }
  realUserId = user.id;
  return realUserId;
}

// ---------------------------------------------------------------------------
// Inserted audit_log IDs (for cleanup)
// ---------------------------------------------------------------------------
const insertedAuditIds: string[] = [];

// ---------------------------------------------------------------------------
// Inserted RevisionRun IDs (for cleanup)
// ---------------------------------------------------------------------------
const insertedRunIds: string[] = [];

// ---------------------------------------------------------------------------
// Real transaction (same shape as apps/web/app/actions/revision-runs.ts)
// ---------------------------------------------------------------------------

const realRollbackRunTransaction: RollbackRunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      commentRepo: tx.revisionComment,
      chapterRevisionRepo: tx.chapterRevision,
      chapterRepo: tx.chapter,
      bookRepo: tx.book,
      auditLogRepo: tx.auditLog,
    }),
  );

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function buildDeps(userId: string): RollbackRevisionRunDeps {
  return {
    commentRepo: prisma.revisionComment,
    chapterRevisionRepo: prisma.chapterRevision,
    chapterRepo: prisma.chapter,
    bookRepo: prisma.book,
    auditLogRepo: prisma.auditLog,
    runTransaction: realRollbackRunTransaction,
    session: { user: { id: userId, username: 'e2e-runtime' } },
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupTestRows(): Promise<void> {
  // Clean up RevisionRun -> comment.run_id will be set to null via onDelete: SetNull
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
  const accountIds = accounts.map((a) => a.id);

  if (accountIds.length > 0) {
    const books = await prisma.book.findMany({
      where: { account_id: { in: accountIds } },
      select: { id: true },
    });
    const bookIds = books.map((b) => b.id);

    if (bookIds.length > 0) {
      // Job (no cascade from Book)
      await prisma.job
        .deleteMany({ where: { book_id: { in: bookIds } } })
        .catch(() => undefined);
      // BookLock (no cascade)
      await prisma.bookLock
        .deleteMany({ where: { book_id: { in: bookIds } } })
        .catch(() => undefined);
    }

    // Account cascade deletes Book -> RevisionComment, Outline, Chapter,
    // ChapterRevision, Cover etc.
    await prisma.account
      .deleteMany({ where: { id: { in: accountIds } } })
      .catch(() => undefined);
  }

  if (insertedAuditIds.length > 0) {
    await prisma.auditLog
      .deleteMany({ where: { id: { in: insertedAuditIds } } })
      .catch(() => undefined);
    insertedAuditIds.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeededBook {
  accountId: string;
  themeId: string;
  bookId: string;
}

async function seedBook(suffix: string): Promise<SeededBook> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${suffix}-${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['test'],
      },
      status: 'archived',
    },
    select: { id: true },
  });

  const theme = await prisma.themeCandidate.create({
    data: {
      account_id: account.id,
      theme_session_id: `${TEST_PEN_PREFIX}-${suffix}-session-${Date.now()}`,
      genre: 'business',
      title: `T-06-11 ロールバックテスト用テーマ (${suffix})`,
      hook: 'integration test',
      competitors_json: [],
      signals_json: { sources: ['test'] },
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const book = await prisma.book.create({
    data: {
      account_id: account.id,
      theme_id: theme.id,
      title: `T-06-11 ロールバックテスト書籍 (${suffix})`,
      status: 'running',
      prompt_version_ids_json: {},
      model_assignment_snapshot: {},
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

interface SeededChapter {
  chapterId: string;
}

async function seedChapter(
  bookId: string,
  opts: {
    index?: number;
    heading?: string;
    body_md: string;
    version: number;
  },
): Promise<SeededChapter> {
  const chapter = await prisma.chapter.create({
    data: {
      book_id: bookId,
      index: opts.index ?? 1,
      heading: opts.heading ?? 'Test Chapter',
      body_md: opts.body_md,
      char_count: opts.body_md.length,
      version: opts.version,
      status: 'done',
    },
    select: { id: true },
  });
  return { chapterId: chapter.id };
}

async function seedChapterRevision(
  chapterId: string,
  bookId: string,
  opts: {
    version: number;
    body_md: string;
    reason: string;
  },
): Promise<string> {
  const rev = await prisma.chapterRevision.create({
    data: {
      chapter_id: chapterId,
      book_id: bookId,
      version: opts.version,
      body_md: opts.body_md,
      reason: opts.reason,
    },
    select: { id: true },
  });
  return rev.id;
}

async function seedRevisionRun(userId: string, bookId: string): Promise<string> {
  const run = await prisma.revisionRun.create({
    data: {
      triggered_by: userId,
      status: 'done',
      book_ids_json: [bookId],
      comment_ids_json: [],
      result_summary_json: {
        applied: 1,
        not_applicable: 0,
        failed: 0,
        cost_jpy: 80,
      },
    },
    select: { id: true },
  });
  insertedRunIds.push(run.id);
  return run.id;
}

async function seedAppliedComment(
  bookId: string,
  userId: string,
  runId: string,
  opts: {
    target_kind: string;
    target_id: string;
    body: string;
    priority?: 'must' | 'should' | 'may';
  },
): Promise<string> {
  const comment = await prisma.revisionComment.create({
    data: {
      book_id: bookId,
      target_kind: opts.target_kind,
      target_id: opts.target_id,
      body: opts.body,
      priority: opts.priority ?? 'must',
      status: 'applied',
      applied_at: new Date(),
      run_id: runId,
      created_by: userId,
    },
    select: { id: true },
  });
  return comment.id;
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('runtime: rollbackRevisionRunCore SA core against real Postgres (T-06-11, F-016/F-050)', () => {
  // Real DB I/O only (no LLM, no enqueueJob) -- 60s is enough
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. Chapter rollback -- Chapter (version=3, body_md='modified') +
  //    ChapterRevision (version=2, body_md='original') + applied comment
  //    -> rollback -> Chapter.body_md='original' + version=4 + comment pending
  // -------------------------------------------------------------------------
  test('rollbackRevisionRunCore: chapter body restored from ChapterRevision + version incremented + comment reset to pending', async () => {
    const userId = await resolveRealUserId();
    const book = await seedBook('ch-rollback');
    const deps = buildDeps(userId);

    // Create chapter at version=3 with modified body
    const { chapterId } = await seedChapter(book.bookId, {
      body_md: 'modified body v3',
      version: 3,
    });

    // Create ChapterRevision for version=2 (the "original" state to restore)
    const runId = await seedRevisionRun(userId, book.bookId);

    // Create revision history: v1 and v2
    await seedChapterRevision(chapterId, book.bookId, {
      version: 1,
      body_md: 'original body v1',
      reason: 'manual_edit',
    });
    await seedChapterRevision(chapterId, book.bookId, {
      version: 2,
      body_md: 'original body v2',
      reason: `revision_run:${runId}`,
    });

    // Create an applied comment pointing to this chapter
    const commentId = await seedAppliedComment(
      book.bookId,
      userId,
      runId,
      {
        target_kind: 'chapter',
        target_id: chapterId,
        body: 'chapter rollback test comment',
        priority: 'should',
      },
    );

    // Update run's comment_ids_json
    await prisma.revisionRun.update({
      where: { id: runId },
      data: { comment_ids_json: [commentId] },
    });

    // --- Execute rollback ---
    const result = await rollbackRevisionRunCore(
      { revision_run_id: runId },
      deps,
    );

    // --- Result is OK ---
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-11 ch-rollback] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    expect(result.data.restored).toBeGreaterThanOrEqual(1);

    // --- Chapter: body_md restored to v2 body, version incremented to 4 ---
    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
    });
    expect(chapter).not.toBeNull();
    expect(chapter!.body_md).toBe('original body v2');
    expect(chapter!.version).toBe(4);
    expect(chapter!.char_count).toBe('original body v2'.length);

    // --- A new ChapterRevision should have been created (saving v3 state) ---
    const rollbackRevision = await prisma.chapterRevision.findFirst({
      where: {
        chapter_id: chapterId,
        version: 3,
        reason: `rollback:${runId}`,
      },
    });
    expect(rollbackRevision).not.toBeNull();
    expect(rollbackRevision!.body_md).toBe('modified body v3');

    // --- Comment: status reset to 'pending', applied_at cleared ---
    const comment = await prisma.revisionComment.findUnique({
      where: { id: commentId },
    });
    expect(comment).not.toBeNull();
    expect(comment!.status).toBe('pending');
    expect(comment!.applied_at).toBeNull();

    // --- audit_log: 1 row (action='revision_run.rollback') ---
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'revision_run.rollback',
        target_kind: 'revision_run',
        target_id: runId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const after = audit.after_json as {
      revision_run_id: string;
      comment_ids: string[];
      chapter_ids_restored: string[];
      restored_count: number;
      partial: boolean;
    };
    expect(after.revision_run_id).toBe(runId);
    expect(after.comment_ids).toContain(commentId);
    expect(after.chapter_ids_restored).toContain(chapterId);
    expect(after.restored_count).toBeGreaterThanOrEqual(1);
    expect(after.partial).toBe(false);

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-11 ch-rollback] chapter=${chapterId} body restored='original body v2' ` +
        `version=4 comment.status=pending audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 2. Book flag recalculation -- must comment applied -> rollback ->
  //    has_blocking_comments=true, has_pending_comments=true
  // -------------------------------------------------------------------------
  test('rollbackRevisionRunCore: must comment rollback -> has_blocking_comments=true + has_pending_comments=true', async () => {
    const userId = await resolveRealUserId();
    const book = await seedBook('flag-recalc');
    const deps = buildDeps(userId);

    // Book starts with has_blocking_comments=false (comment was applied)
    const runId = await seedRevisionRun(userId, book.bookId);

    // Create an applied must comment (non-chapter, so no chapter restoration needed)
    const commentId = await seedAppliedComment(
      book.bookId,
      userId,
      runId,
      {
        target_kind: 'cover',
        target_id: `cover_dummy_${Date.now()}`,
        body: 'must comment for flag recalc test',
        priority: 'must',
      },
    );

    // Update run's comment_ids_json
    await prisma.revisionRun.update({
      where: { id: runId },
      data: { comment_ids_json: [commentId] },
    });

    // Verify book flags before rollback -- no pending comments, no blocking
    const bookBefore = await prisma.book.findUnique({
      where: { id: book.bookId },
    });
    expect(bookBefore!.has_pending_comments).toBe(false);
    expect(bookBefore!.has_blocking_comments).toBe(false);

    // --- Execute rollback ---
    const result = await rollbackRevisionRunCore(
      { revision_run_id: runId },
      deps,
    );

    // --- Result is OK ---
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-11 flag-recalc] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    // --- Comment status is now pending ---
    const comment = await prisma.revisionComment.findUnique({
      where: { id: commentId },
    });
    expect(comment!.status).toBe('pending');

    // --- Book: has_pending_comments=true, has_blocking_comments=true ---
    const bookAfter = await prisma.book.findUnique({
      where: { id: book.bookId },
    });
    expect(bookAfter).not.toBeNull();
    expect(bookAfter!.has_pending_comments).toBe(true);
    expect(bookAfter!.has_blocking_comments).toBe(true);

    // --- audit_log: 1 row ---
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'revision_run.rollback',
        target_kind: 'revision_run',
        target_id: runId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    insertedAuditIds.push(auditRows[0]!.id);

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-11 flag-recalc] book=${book.bookId} ` +
        `has_pending=${bookAfter!.has_pending_comments} ` +
        `has_blocking=${bookAfter!.has_blocking_comments} ` +
        `comment.status=pending audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 3. No applied comments -> not_found error
  // -------------------------------------------------------------------------
  test('rollbackRevisionRunCore: no applied comments for run -> not_found error', async () => {
    const userId = await resolveRealUserId();
    const book = await seedBook('no-applied');
    const deps = buildDeps(userId);

    const runId = await seedRevisionRun(userId, book.bookId);

    // Create a pending comment (NOT applied) assigned to this run
    await prisma.revisionComment.create({
      data: {
        book_id: book.bookId,
        target_kind: 'chapter',
        target_id: `ch_dummy_${Date.now()}`,
        body: 'still pending comment',
        priority: 'must',
        status: 'pending',
        run_id: runId,
        created_by: userId,
      },
    });

    // --- Execute rollback ---
    const result = await rollbackRevisionRunCore(
      { revision_run_id: runId },
      deps,
    );

    // --- Result is FAIL (not_found: no applied comments) ---
    expect(isFail(result)).toBe(true);
    if (!isFail(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-11 no-applied] unexpected ok:', JSON.stringify(result));
      throw new Error('expected fail result');
    }
    expect(result.error.code).toBe('not_found');

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-11 no-applied] correctly failed with code=${result.error.code}`,
    );
  });

  // -------------------------------------------------------------------------
  // 4. Non-chapter comment (cover) -- status reset only, no chapter ops
  // -------------------------------------------------------------------------
  test('rollbackRevisionRunCore: non-chapter comment (cover) -> status reset to pending only', async () => {
    const userId = await resolveRealUserId();
    const book = await seedBook('non-ch');
    const deps = buildDeps(userId);

    const runId = await seedRevisionRun(userId, book.bookId);

    // Create an applied cover comment
    const commentId = await seedAppliedComment(
      book.bookId,
      userId,
      runId,
      {
        target_kind: 'cover',
        target_id: `cover_dummy_${Date.now()}`,
        body: 'cover comment for non-chapter test',
        priority: 'should',
      },
    );

    // Update run's comment_ids_json
    await prisma.revisionRun.update({
      where: { id: runId },
      data: { comment_ids_json: [commentId] },
    });

    // --- Execute rollback ---
    const result = await rollbackRevisionRunCore(
      { revision_run_id: runId },
      deps,
    );

    // --- Result is OK ---
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-11 non-ch] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    // restored count should include non-chapter comments
    expect(result.data.restored).toBeGreaterThanOrEqual(1);

    // --- Comment: status reset to 'pending', applied_at cleared ---
    const comment = await prisma.revisionComment.findUnique({
      where: { id: commentId },
    });
    expect(comment).not.toBeNull();
    expect(comment!.status).toBe('pending');
    expect(comment!.applied_at).toBeNull();

    // --- No ChapterRevision created (no chapter involved) ---
    const chapterRevisions = await prisma.chapterRevision.findMany({
      where: { book_id: book.bookId },
    });
    expect(chapterRevisions).toHaveLength(0);

    // --- audit_log ---
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'revision_run.rollback',
        target_kind: 'revision_run',
        target_id: runId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    insertedAuditIds.push(auditRows[0]!.id);

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-11 non-ch] comment.status=pending applied_at=null ` +
        `chapterRevisions=0 audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 5. Zod validation -- missing revision_run_id -> validation error
  // -------------------------------------------------------------------------
  test('rollbackRevisionRunCore: missing revision_run_id -> validation error', async () => {
    const userId = await resolveRealUserId();
    const deps = buildDeps(userId);

    const result = await rollbackRevisionRunCore({}, deps);

    expect(isFail(result)).toBe(true);
    if (!isFail(result)) {
      throw new Error('expected fail result');
    }
    expect(result.error.code).toBe('validation');

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-11 zod] correctly rejected with code=${result.error.code}`,
    );
  });
});
