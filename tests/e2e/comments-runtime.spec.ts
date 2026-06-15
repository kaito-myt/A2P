/**
 * Runtime verification spec for T-06-01 -- comments Server Actions
 * core logic (F-049): createComment / deleteComment / bulkChangePriority.
 *
 * SP-06 段階では コメント UI (T-06-02~T-06-05) はまだ配線されていないため、
 * Playwright を test runner として借用し、core 関数を
 * 実 PrismaClient + 実 PostgreSQL に対して直接呼び出す
 * (outlines-bulk-actions-runtime.spec.ts / covers-bulk-actions-runtime.spec.ts
 * と同パターン)。
 *
 * シナリオ:
 *   1. createComment (must priority) -> RevisionComment INSERT +
 *      Book.has_pending_comments=true + has_blocking_comments=true + audit_log
 *   2. deleteComment (last must) -> status='superseded' +
 *      Book.has_blocking_comments=false re-calc + audit_log
 *   3. bulkChangePriority (must -> may) -> priority updated +
 *      Book.has_blocking_comments re-calc + audit_log
 *
 * モック対象: なし (本タスクは enqueueJob 不使用)。
 * 外部 API 呼出ゼロ。コストゼロ。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { isOk, isFail } from '@a2p/contracts';
import {
  createCommentCore,
  deleteCommentCore,
  bulkChangePriorityCore,
  type CommentsDeps,
  type RunTransactionFn,
} from '../../apps/web/lib/comments-core.js';

const TEST_PEN_PREFIX = 'e2e-t-06-01-comments';

// ---------------------------------------------------------------------------
// User ID resolution (audit_log FK)
// ---------------------------------------------------------------------------

let realUserId: string | null = null;

async function resolveRealUserId(): Promise<string> {
  if (realUserId) return realUserId;
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    throw new Error(
      'users テーブルにユーザーが存在しません。`pnpm --filter @a2p/db db:seed` を実行してください',
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
// Real transaction (same shape as apps/web/app/actions/comments.ts)
// ---------------------------------------------------------------------------

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      commentRepo: tx.revisionComment,
      bookRepo: tx.book,
      auditLogRepo: tx.auditLog,
    }),
  );

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function buildDeps(userId: string): CommentsDeps {
  return {
    commentRepo: prisma.revisionComment,
    bookRepo: prisma.book,
    auditLogRepo: prisma.auditLog,
    runTransaction: realRunTransaction,
    session: { user: { id: userId, username: 'e2e-runtime' } },
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupTestRows(): Promise<void> {
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

    // Account cascade deletes Book -> RevisionComment, Outline, Chapter, Cover etc.
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
// Seed helper: creates Account + ThemeCandidate + Book for comment tests
// ---------------------------------------------------------------------------

interface SeededContext {
  accountId: string;
  themeId: string;
  bookId: string;
}

async function seedBook(suffix: string): Promise<SeededContext> {
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
      title: `T-06-01 コメントテスト用テーマ (${suffix})`,
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
      title: `T-06-01 コメントテスト書籍 (${suffix})`,
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

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('runtime: comments SA core against real Postgres (T-06-01, F-049)', () => {
  // 実 DB I/O のみ (LLM 不使用, enqueueJob 不使用) -- 60s で十分
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. createComment (must priority) -> has_blocking_comments=true
  // -------------------------------------------------------------------------
  test('createCommentCore: must priority -> comment INSERT + has_blocking_comments=true + audit_log', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedBook('create');
    const deps = buildDeps(userId);

    const result = await createCommentCore(
      {
        book_id: seeded.bookId,
        target_kind: 'chapter',
        target_id: 'ch_dummy_1',
        body: '第3章に事例を追加してください',
        priority: 'must',
      },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-01 create] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }
    expect(typeof result.data.comment_id).toBe('string');
    const commentId = result.data.comment_id;

    // --- RevisionComment: row exists with correct fields ---------------------
    const comment = await prisma.revisionComment.findUnique({
      where: { id: commentId },
    });
    expect(comment).not.toBeNull();
    expect(comment!.book_id).toBe(seeded.bookId);
    expect(comment!.target_kind).toBe('chapter');
    expect(comment!.target_id).toBe('ch_dummy_1');
    expect(comment!.body).toBe('第3章に事例を追加してください');
    expect(comment!.priority).toBe('must');
    expect(comment!.status).toBe('pending');
    expect(comment!.created_by).toBe(userId);

    // --- Book: has_pending_comments=true, has_blocking_comments=true --------
    const book = await prisma.book.findUnique({ where: { id: seeded.bookId } });
    expect(book).not.toBeNull();
    expect(book!.has_pending_comments).toBe(true);
    expect(book!.has_blocking_comments).toBe(true);

    // --- audit_log: 1 row (action='comment.create') -------------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'comment.create',
        target_kind: 'revision_comment',
        target_id: commentId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);
    expect(audit.target_kind).toBe('revision_comment');
    expect(audit.target_id).toBe(commentId);

    const after = audit.after_json as {
      book_id: string;
      target_kind: string;
      target_id: string;
      priority: string;
    };
    expect(after.book_id).toBe(seeded.bookId);
    expect(after.target_kind).toBe('chapter');
    expect(after.priority).toBe('must');

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-01 create] comment_id=${commentId} ` +
        `has_pending=${book!.has_pending_comments} has_blocking=${book!.has_blocking_comments} audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 2. deleteComment (last must) -> has_blocking_comments=false
  // -------------------------------------------------------------------------
  test('deleteCommentCore: last must comment delete -> status=superseded + has_blocking_comments=false', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedBook('delete');
    const deps = buildDeps(userId);

    // First, create a must comment so we have something to delete
    const createResult = await createCommentCore(
      {
        book_id: seeded.bookId,
        target_kind: 'outline',
        target_id: 'outline_dummy_1',
        body: '構成を見直してください',
        priority: 'must',
      },
      deps,
    );
    expect(isOk(createResult)).toBe(true);
    if (!isOk(createResult)) throw new Error('setup: create failed');
    const commentId = createResult.data.comment_id;

    // Verify book flags after create
    const bookAfterCreate = await prisma.book.findUnique({ where: { id: seeded.bookId } });
    expect(bookAfterCreate!.has_blocking_comments).toBe(true);
    expect(bookAfterCreate!.has_pending_comments).toBe(true);

    // Also create a 'should' comment to verify has_pending stays true
    const createResult2 = await createCommentCore(
      {
        book_id: seeded.bookId,
        target_kind: 'chapter',
        target_id: 'ch_dummy_2',
        body: '参考文献を追記してほしい',
        priority: 'should',
      },
      deps,
    );
    expect(isOk(createResult2)).toBe(true);

    // Now delete the must comment (soft delete)
    const deleteResult = await deleteCommentCore(
      { comment_id: commentId },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(deleteResult)).toBe(true);
    if (!isOk(deleteResult)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-01 delete] unexpected fail:', JSON.stringify(deleteResult));
      throw new Error('expected ok result');
    }

    // --- RevisionComment: status='superseded' --------------------------------
    const comment = await prisma.revisionComment.findUnique({
      where: { id: commentId },
    });
    expect(comment).not.toBeNull();
    expect(comment!.status).toBe('superseded');

    // --- Book: has_blocking_comments=false (no more must+pending),
    //          has_pending_comments=true (should comment remains) -------------
    const book = await prisma.book.findUnique({ where: { id: seeded.bookId } });
    expect(book).not.toBeNull();
    expect(book!.has_blocking_comments).toBe(false);
    expect(book!.has_pending_comments).toBe(true);

    // --- audit_log: 1 row (action='comment.delete') -------------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'comment.delete',
        target_kind: 'revision_comment',
        target_id: commentId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const afterJson = audit.after_json as { status: string };
    expect(afterJson.status).toBe('superseded');

    // Also track the create audit logs for cleanup
    const createAudits = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'comment.create',
        target_kind: 'revision_comment',
      },
      orderBy: { created_at: 'desc' },
      take: 10,
    });
    for (const a of createAudits) {
      if (!insertedAuditIds.includes(a.id)) {
        insertedAuditIds.push(a.id);
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-01 delete] comment_id=${commentId} status=superseded ` +
        `has_pending=${book!.has_pending_comments} has_blocking=${book!.has_blocking_comments} audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 3. bulkChangePriority (must -> may) -> has_blocking_comments re-calc
  // -------------------------------------------------------------------------
  test('bulkChangePriorityCore: must -> may -> has_blocking_comments=false + audit_log', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedBook('bulk');
    const deps = buildDeps(userId);

    // Create 2 must comments and 1 should comment
    const createResult1 = await createCommentCore(
      {
        book_id: seeded.bookId,
        target_kind: 'chapter',
        target_id: 'ch_dummy_3',
        body: '具体的なデータを追加してください',
        priority: 'must',
      },
      deps,
    );
    expect(isOk(createResult1)).toBe(true);
    if (!isOk(createResult1)) throw new Error('setup: create 1 failed');
    const commentId1 = createResult1.data.comment_id;

    const createResult2 = await createCommentCore(
      {
        book_id: seeded.bookId,
        target_kind: 'chapter',
        target_id: 'ch_dummy_4',
        body: '結論をより強調してください',
        priority: 'must',
      },
      deps,
    );
    expect(isOk(createResult2)).toBe(true);
    if (!isOk(createResult2)) throw new Error('setup: create 2 failed');
    const commentId2 = createResult2.data.comment_id;

    const createResult3 = await createCommentCore(
      {
        book_id: seeded.bookId,
        target_kind: 'metadata',
        target_id: 'meta_1',
        body: 'タイトルの案を検討してほしい',
        priority: 'should',
      },
      deps,
    );
    expect(isOk(createResult3)).toBe(true);

    // Verify book has blocking=true before bulk change
    const bookBefore = await prisma.book.findUnique({ where: { id: seeded.bookId } });
    expect(bookBefore!.has_blocking_comments).toBe(true);
    expect(bookBefore!.has_pending_comments).toBe(true);

    // Bulk change must -> may for both must comments
    const bulkResult = await bulkChangePriorityCore(
      {
        comment_ids: [commentId1, commentId2],
        priority: 'may',
      },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(bulkResult)).toBe(true);
    if (!isOk(bulkResult)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-01 bulk] unexpected fail:', JSON.stringify(bulkResult));
      throw new Error('expected ok result');
    }
    expect(bulkResult.data.updated).toBe(2);

    // --- RevisionComment: both now priority='may' ----------------------------
    const comments = await prisma.revisionComment.findMany({
      where: { id: { in: [commentId1, commentId2] } },
    });
    expect(comments).toHaveLength(2);
    for (const c of comments) {
      expect(c.priority).toBe('may');
      expect(c.status).toBe('pending');
    }

    // --- Book: has_blocking_comments=false (no must+pending remaining),
    //          has_pending_comments=true (3 comments still pending) -----------
    const book = await prisma.book.findUnique({ where: { id: seeded.bookId } });
    expect(book).not.toBeNull();
    expect(book!.has_blocking_comments).toBe(false);
    expect(book!.has_pending_comments).toBe(true);

    // --- audit_log: 1 row (action='comment.bulk_change_priority') -----------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'comment.bulk_change_priority',
        target_kind: 'revision_comment',
        target_id: 'bulk',
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    // Find ours by checking after_json.book_ids contains seeded.bookId
    const ours = auditRows.find((r) => {
      const af = r.after_json as { book_ids?: string[] } | null;
      const ids = af?.book_ids ?? [];
      return ids.includes(seeded.bookId);
    });
    expect(ours).toBeDefined();
    insertedAuditIds.push(ours!.id);

    const after = ours!.after_json as {
      priority: string;
      updated: number;
      book_ids: string[];
    };
    expect(after.priority).toBe('may');
    expect(after.updated).toBe(2);
    expect(after.book_ids).toContain(seeded.bookId);

    // Track create audit logs for cleanup
    const createAudits = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'comment.create',
        target_kind: 'revision_comment',
      },
      orderBy: { created_at: 'desc' },
      take: 10,
    });
    for (const a of createAudits) {
      if (!insertedAuditIds.includes(a.id)) {
        insertedAuditIds.push(a.id);
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-01 bulk] updated=${bulkResult.data.updated} ` +
        `has_pending=${book!.has_pending_comments} has_blocking=${book!.has_blocking_comments} audit=1`,
    );
  });
});
