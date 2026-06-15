/**
 * Runtime verification spec for T-06-07 -- createRevisionRun SA core logic
 * (F-050): RevisionRun INSERT + revision.book.apply enqueue + BookLock 排他制御
 * + 推定コスト計算.
 *
 * SP-06 段階では 修正一括反映 UI はまだ配線されていないため、
 * Playwright を test runner として借用し、core 関数を
 * 実 PrismaClient + 実 PostgreSQL に対して直接呼び出す
 * (comments-runtime.spec.ts / covers-bulk-actions-runtime.spec.ts と同パターン)。
 *
 * シナリオ:
 *   1. createRevisionRun 正常系 — pending コメント 3 件 (2 書籍) → SA 呼出 →
 *      RevisionRun INSERT + revision.book.apply x2 enqueue +
 *      コメント run_id 更新 + 推定コスト/時間計算
 *   2. blocked_books 検出 — 1 書籍にアクティブ BookLock → blocked_books に含まれ、
 *      その書籍のコメントは除外
 *   3. 推定コスト — コメント数 x 80 円、時間 = ceil(コメント数 x 30 / 60) 分
 *
 * モック対象: enqueueJob のみ (graphile-worker キューには書き込まない)。
 * 外部 API 呼出ゼロ。コストゼロ。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { isOk, isFail } from '@a2p/contracts';
import {
  createRevisionRunCore,
  REVISION_BOOK_APPLY_TASK_NAME,
  COST_PER_COMMENT_JPY,
  SECONDS_PER_COMMENT,
  type RevisionRunsDeps,
  type RunTransactionFn,
} from '../../apps/web/lib/revision-runs-core.js';

const TEST_PEN_PREFIX = 'e2e-t-06-07-revrun';

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
// Inserted RevisionRun IDs (for cleanup)
// ---------------------------------------------------------------------------
const insertedRunIds: string[] = [];

// ---------------------------------------------------------------------------
// Enqueue mock factory
// ---------------------------------------------------------------------------

interface EnqueueCall {
  taskName: string;
  payload: unknown;
}

function makeEnqueueMock(): {
  calls: EnqueueCall[];
  fn: (taskName: string, payload: unknown) => Promise<string>;
} {
  const calls: EnqueueCall[] = [];
  let counter = 0;
  return {
    calls,
    fn: async (taskName: string, payload: unknown): Promise<string> => {
      counter += 1;
      calls.push({ taskName, payload });
      return `mock-graphile-job-revrun-${counter}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Real transaction (same shape as apps/web/app/actions/revision-runs.ts)
// ---------------------------------------------------------------------------

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      commentRepo: tx.revisionComment,
      revisionRunRepo: tx.revisionRun,
      auditLogRepo: tx.auditLog,
    }),
  );

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function buildDeps(
  userId: string,
  enqueueJobFn: (taskName: string, payload: unknown) => Promise<string>,
): RevisionRunsDeps {
  return {
    commentRepo: prisma.revisionComment,
    bookLockRepo: prisma.bookLock,
    revisionRunRepo: prisma.revisionRun,
    auditLogRepo: prisma.auditLog,
    runTransaction: realRunTransaction,
    session: { user: { id: userId, username: 'e2e-runtime' } },
    enqueueJob: enqueueJobFn,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupTestRows(): Promise<void> {
  // Clean up RevisionRun -> comment.run_id will be set to null via onDelete: SetNull
  if (insertedRunIds.length > 0) {
    // First clear run_id on comments pointing to our runs
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
      title: `T-06-07 RevisionRun テスト用テーマ (${suffix})`,
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
      title: `T-06-07 RevisionRun テスト書籍 (${suffix})`,
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

async function seedComment(
  bookId: string,
  userId: string,
  body: string,
  priority: 'must' | 'should' | 'may' = 'must',
): Promise<string> {
  const comment = await prisma.revisionComment.create({
    data: {
      book_id: bookId,
      target_kind: 'chapter',
      target_id: `ch_dummy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      body,
      priority,
      status: 'pending',
      created_by: userId,
    },
    select: { id: true },
  });
  return comment.id;
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('runtime: createRevisionRun SA core against real Postgres (T-06-07, F-050)', () => {
  // 実 DB I/O のみ (mock enqueueJob, LLM 不使用) -- 60s で十分
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. createRevisionRun 正常系 -- pending コメント 3 件 (2 書籍) →
  //    RevisionRun INSERT + revision.book.apply x2 enqueue + コメント run_id 更新
  // -------------------------------------------------------------------------
  test('createRevisionRunCore: 3 pending comments across 2 books -> RevisionRun INSERT + 2 enqueue + comments run_id set', async () => {
    const userId = await resolveRealUserId();
    const book1 = await seedBook('happy1');
    const book2 = await seedBook('happy2');
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    // Create 3 pending comments: 2 for book1, 1 for book2
    const commentId1 = await seedComment(book1.bookId, userId, 'book1 修正 A');
    const commentId2 = await seedComment(book1.bookId, userId, 'book1 修正 B');
    const commentId3 = await seedComment(book2.bookId, userId, 'book2 修正 C');

    const result = await createRevisionRunCore(
      {
        comment_ids: [commentId1, commentId2, commentId3],
        scope: 'selected',
      },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-07 happy] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    const data = result.data;
    expect(typeof data.run_id).toBe('string');
    expect(data.blocked_books).toEqual([]);
    insertedRunIds.push(data.run_id);

    // --- 推定コスト: 3 comments x 80 = 240 JPY ---------------------------------
    expect(data.estimated_cost_jpy).toBe(3 * COST_PER_COMMENT_JPY);

    // --- 推定時間: ceil(3 * 30 / 60) = ceil(1.5) = 2 min -----------------------
    expect(data.estimated_minutes).toBe(Math.max(1, Math.ceil((3 * SECONDS_PER_COMMENT) / 60)));

    // --- RevisionRun: row exists with correct fields ---------------------------
    const run = await prisma.revisionRun.findUnique({
      where: { id: data.run_id },
    });
    expect(run).not.toBeNull();
    expect(run!.status).toBe('queued');
    expect(run!.triggered_by).toBe(userId);

    const bookIdsJson = run!.book_ids_json as string[];
    expect(bookIdsJson.sort()).toEqual([book1.bookId, book2.bookId].sort());

    const commentIdsJson = run!.comment_ids_json as string[];
    expect(commentIdsJson.sort()).toEqual([commentId1, commentId2, commentId3].sort());

    // --- Comments: run_id updated to the new run --------------------------------
    const comments = await prisma.revisionComment.findMany({
      where: { id: { in: [commentId1, commentId2, commentId3] } },
    });
    expect(comments).toHaveLength(3);
    for (const c of comments) {
      expect(c.run_id).toBe(data.run_id);
    }

    // --- enqueueJob mock: 2 calls (1 per book) -----------------------------------
    expect(enqueue.calls).toHaveLength(2);
    for (const call of enqueue.calls) {
      expect(call.taskName).toBe(REVISION_BOOK_APPLY_TASK_NAME);
      const payload = call.payload as {
        revision_run_id: string;
        book_id: string;
        comment_ids: string[];
      };
      expect(payload.revision_run_id).toBe(data.run_id);
      expect([book1.bookId, book2.bookId]).toContain(payload.book_id);
      // Each book's comments are correctly grouped
      if (payload.book_id === book1.bookId) {
        expect(payload.comment_ids.sort()).toEqual([commentId1, commentId2].sort());
      } else {
        expect(payload.comment_ids).toEqual([commentId3]);
      }
    }

    // --- audit_log: 1 row (action='revision_run.kick') --------------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'revision_run.kick',
        target_kind: 'revision_run',
        target_id: data.run_id,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const after = audit.after_json as {
      run_id: string;
      comment_count: number;
      book_ids: string[];
      blocked_books: string[];
      estimated_cost_jpy: number;
      estimated_minutes: number;
      scope: string;
    };
    expect(after.run_id).toBe(data.run_id);
    expect(after.comment_count).toBe(3);
    expect(after.book_ids.sort()).toEqual([book1.bookId, book2.bookId].sort());
    expect(after.blocked_books).toEqual([]);
    expect(after.estimated_cost_jpy).toBe(3 * COST_PER_COMMENT_JPY);
    expect(after.scope).toBe('selected');

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-07 happy] run_id=${data.run_id} comments=3 books=2 ` +
        `cost=${data.estimated_cost_jpy}JPY time=${data.estimated_minutes}min ` +
        `enqueue=${enqueue.calls.length} blocked=0 audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 2. blocked_books 検出 -- 1 書籍にアクティブ BookLock →
  //    blocked_books に含まれ、その書籍のコメントは除外
  // -------------------------------------------------------------------------
  test('createRevisionRunCore: book with active BookLock -> blocked_books + comments excluded', async () => {
    const userId = await resolveRealUserId();
    const bookOk = await seedBook('lock-ok');
    const bookLocked = await seedBook('lock-blocked');
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    // Create comments: 1 for unlocked book, 2 for locked book
    const commentOk = await seedComment(bookOk.bookId, userId, 'OK book comment');
    const commentLocked1 = await seedComment(bookLocked.bookId, userId, 'locked book comment 1');
    const commentLocked2 = await seedComment(bookLocked.bookId, userId, 'locked book comment 2');

    // Create active BookLock for bookLocked (expires 30 min in the future)
    await prisma.bookLock.create({
      data: {
        book_id: bookLocked.bookId,
        holder: `pipeline:test-lock-${Date.now()}`,
        expires_at: new Date(Date.now() + 30 * 60 * 1000), // 30 min from now
      },
    });

    const result = await createRevisionRunCore(
      {
        comment_ids: [commentOk, commentLocked1, commentLocked2],
        scope: 'selected',
      },
      deps,
    );

    // --- Result is OK (partial success: only unlocked book's comment) ---------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-07 lock] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    const data = result.data;
    insertedRunIds.push(data.run_id);

    // --- blocked_books contains the locked book --------------------------------
    expect(data.blocked_books).toEqual([bookLocked.bookId]);

    // --- Cost is only for the 1 eligible comment --------------------------------
    expect(data.estimated_cost_jpy).toBe(1 * COST_PER_COMMENT_JPY);
    // ceil(1 * 30 / 60) = ceil(0.5) = 1 min (minimum 1)
    expect(data.estimated_minutes).toBe(1);

    // --- RevisionRun: only unlocked book in book_ids_json -----------------------
    const run = await prisma.revisionRun.findUnique({
      where: { id: data.run_id },
    });
    expect(run).not.toBeNull();
    const bookIdsJson = run!.book_ids_json as string[];
    expect(bookIdsJson).toEqual([bookOk.bookId]);

    const commentIdsJson = run!.comment_ids_json as string[];
    expect(commentIdsJson).toEqual([commentOk]);

    // --- Locked comments: run_id should NOT be set ------------------------------
    const lockedComments = await prisma.revisionComment.findMany({
      where: { id: { in: [commentLocked1, commentLocked2] } },
    });
    for (const c of lockedComments) {
      expect(c.run_id).toBeNull();
    }

    // --- Unlocked comment: run_id IS set ----------------------------------------
    const okComment = await prisma.revisionComment.findUnique({
      where: { id: commentOk },
    });
    expect(okComment!.run_id).toBe(data.run_id);

    // --- enqueueJob mock: 1 call (only unlocked book) ---------------------------
    expect(enqueue.calls).toHaveLength(1);
    const call = enqueue.calls[0]!;
    expect(call.taskName).toBe(REVISION_BOOK_APPLY_TASK_NAME);
    const payload = call.payload as {
      revision_run_id: string;
      book_id: string;
      comment_ids: string[];
    };
    expect(payload.book_id).toBe(bookOk.bookId);
    expect(payload.comment_ids).toEqual([commentOk]);

    // --- result_summary_json contains blocked_books ----------------------------
    const summary = run!.result_summary_json as {
      blocked_books: string[];
    };
    expect(summary.blocked_books).toEqual([bookLocked.bookId]);

    // --- audit_log: 1 row (action='revision_run.kick') -------------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'revision_run.kick',
        target_kind: 'revision_run',
        target_id: data.run_id,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    insertedAuditIds.push(auditRows[0]!.id);

    const after = auditRows[0]!.after_json as {
      blocked_books: string[];
      comment_count: number;
    };
    expect(after.blocked_books).toEqual([bookLocked.bookId]);
    expect(after.comment_count).toBe(1);

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-07 lock] run_id=${data.run_id} eligible=1 blocked_books=[${bookLocked.bookId}] ` +
        `cost=${data.estimated_cost_jpy}JPY enqueue=${enqueue.calls.length} audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 3. 推定コスト計算 -- コメント数 x 80 円、時間 = ceil(コメント数 x 30 / 60) 分
  // -------------------------------------------------------------------------
  test('createRevisionRunCore: cost estimation -- comments x 80JPY, time = ceil(comments x 30 / 60) min', async () => {
    const userId = await resolveRealUserId();
    const book = await seedBook('cost');
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    // Create 5 pending comments in a single book
    const commentIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await seedComment(book.bookId, userId, `cost test comment ${i}`);
      commentIds.push(id);
    }

    const result = await createRevisionRunCore(
      {
        comment_ids: commentIds,
        scope: 'selected',
      },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-07 cost] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    const data = result.data;
    insertedRunIds.push(data.run_id);

    // --- 推定コスト: 5 comments x 80 = 400 JPY ----------------------------------
    expect(data.estimated_cost_jpy).toBe(5 * COST_PER_COMMENT_JPY);
    expect(data.estimated_cost_jpy).toBe(400);

    // --- 推定時間: ceil(5 * 30 / 60) = ceil(2.5) = 3 min -----------------------
    const expectedMinutes = Math.max(1, Math.ceil((5 * SECONDS_PER_COMMENT) / 60));
    expect(data.estimated_minutes).toBe(expectedMinutes);
    expect(data.estimated_minutes).toBe(3);

    // --- No blocked books ------------------------------------------------------
    expect(data.blocked_books).toEqual([]);

    // --- enqueueJob mock: 1 call (single book) ----------------------------------
    expect(enqueue.calls).toHaveLength(1);
    const payload = enqueue.calls[0]!.payload as {
      comment_ids: string[];
    };
    expect(payload.comment_ids.sort()).toEqual(commentIds.sort());

    // Track audit for cleanup
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'revision_run.kick',
        target_kind: 'revision_run',
        target_id: data.run_id,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    if (auditRows.length > 0) {
      insertedAuditIds.push(auditRows[0]!.id);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-07 cost] run_id=${data.run_id} comments=5 ` +
        `cost=${data.estimated_cost_jpy}JPY (5x${COST_PER_COMMENT_JPY}) ` +
        `time=${data.estimated_minutes}min (ceil(5x${SECONDS_PER_COMMENT}/60)) ` +
        `blocked=0`,
    );
  });

  // -------------------------------------------------------------------------
  // 4. 全書籍ロック時はエラー
  // -------------------------------------------------------------------------
  test('createRevisionRunCore: all books locked -> fail result (allBooksLocked)', async () => {
    const userId = await resolveRealUserId();
    const book = await seedBook('alllock');
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    // Create 2 pending comments
    const commentId1 = await seedComment(book.bookId, userId, 'all locked comment 1');
    const commentId2 = await seedComment(book.bookId, userId, 'all locked comment 2');

    // Lock the book
    await prisma.bookLock.create({
      data: {
        book_id: book.bookId,
        holder: `pipeline:test-alllock-${Date.now()}`,
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
      },
    });

    const result = await createRevisionRunCore(
      {
        comment_ids: [commentId1, commentId2],
        scope: 'selected',
      },
      deps,
    );

    // --- Result is FAIL (validation error: all books locked) -------------------
    expect(isFail(result)).toBe(true);
    if (!isFail(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-06-07 alllock] unexpected ok:', JSON.stringify(result));
      throw new Error('expected fail result');
    }
    expect(result.error.code).toBe('validation');

    // --- enqueueJob mock: 0 calls (nothing enqueued) ---------------------------
    expect(enqueue.calls).toHaveLength(0);

    // --- Comments: run_id should NOT be set ------------------------------------
    const comments = await prisma.revisionComment.findMany({
      where: { id: { in: [commentId1, commentId2] } },
    });
    for (const c of comments) {
      expect(c.run_id).toBeNull();
    }

    // eslint-disable-next-line no-console
    console.log(
      `[T-06-07 alllock] correctly failed with code=${result.error.code} ` +
        `enqueue=0`,
    );
  });
});
