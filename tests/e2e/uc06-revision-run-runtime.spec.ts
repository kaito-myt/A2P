/**
 * E2E: UC-06 完全シーケンス — コメント → 一括反映 → diff → ロールバック → 再ループ
 *
 * 仕様: docs/02-functional-requirements.md UC-06, docs/sprints/SP-09 §4 T-09-07
 *
 * 検証シーケンス:
 *   1. seed: 複数冊 + 複数種別コメント（章・サムネ、priority: must/should/may）
 *   2. 一括反映: createRevisionRunCore 呼出
 *   3. run ライフサイクル: queued → running → done 状態遷移
 *   4. ロールバック: rollbackRevisionRunCore 呼出 → 対象コメント pending 復帰
 *   5. 再ループ: 新規 run を作成可能
 *
 * モック対象: enqueueJob (graphile-worker キューには書き込まない)。
 * 外部 API 呼出ゼロ。コストゼロ。
 *
 * 仕様根拠:
 *  - docs/02 F-049, F-050
 *  - docs/sprints/SP-09 T-09-07
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';
import { isOk, isFail } from '@a2p/contracts';
import {
  createRevisionRunCore,
  rollbackRevisionRunCore,
  REVISION_BOOK_APPLY_TASK_NAME,
  COST_PER_COMMENT_JPY,
  SECONDS_PER_COMMENT,
  type RevisionRunsDeps,
  type RollbackRevisionRunDeps,
  type RunTransactionFn,
  type RollbackRunTransactionFn,
} from '../../apps/web/lib/revision-runs-core.js';

const TEST_PEN_PREFIX = 'e2e-uc06-revision-run';

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
// Inserted record IDs (for cleanup)
// ---------------------------------------------------------------------------
const insertedRunIds: string[] = [];
const insertedAuditIds: string[] = [];

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
      return `mock-graphile-job-uc06-${counter}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Real transactions
// ---------------------------------------------------------------------------

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      commentRepo: tx.revisionComment,
      revisionRunRepo: tx.revisionRun,
      auditLogRepo: tx.auditLog,
    }),
  );

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
// Deps builders
// ---------------------------------------------------------------------------

function buildCreateDeps(
  userId: string,
  enqueueJobFn: (taskName: string, payload: unknown) => Promise<string>,
): RevisionRunsDeps {
  return {
    commentRepo: prisma.revisionComment,
    bookLockRepo: prisma.bookLock,
    revisionRunRepo: prisma.revisionRun,
    auditLogRepo: prisma.auditLog,
    runTransaction: realRunTransaction,
    session: { user: { id: userId, username: 'e2e-uc06' } },
    enqueueJob: enqueueJobFn,
  };
}

function buildRollbackDeps(userId: string): RollbackRevisionRunDeps {
  return {
    commentRepo: prisma.revisionComment,
    chapterRevisionRepo: prisma.chapterRevision,
    chapterRepo: prisma.chapter,
    bookRepo: prisma.book,
    auditLogRepo: prisma.auditLog,
    runTransaction: realRollbackRunTransaction,
    session: { user: { id: userId, username: 'e2e-uc06' } },
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupTestRows(): Promise<void> {
  // Clear run_id on comments pointing to our runs
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

    // Account cascade deletes Book -> RevisionComment, Outline, Chapter, ChapterRevision, Cover etc.
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
  bookTitle: string;
  chapterIds: string[];
}

async function seedBook(suffix: string): Promise<SeededBook> {
  const ts = Date.now();
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${suffix}-${ts}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-${suffix}-session-${ts}`,
      genre: 'business',
      title: `UC-06 ${suffix} テスト用テーマ`,
      hook: 'integration test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const bookTitle = `UC-06 ${suffix} テスト書籍`;
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

  // Create chapters for diff testing
  const chapterIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const chapter = await prisma.chapter.create({
      data: {
        book_id: book.id,
        index: i + 1,
        heading: `第${i + 1}章 テスト章`,
        body_md: `これは修正前の章本文です。\n元のテキストが入っています。(第${i + 1}章)`,
        status: 'done',
        char_count: 50,
        version: 1,
      },
      select: { id: true },
    });
    chapterIds.push(chapter.id);
  }

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    bookTitle,
    chapterIds,
  };
}

async function seedComment(
  bookId: string,
  userId: string,
  opts: {
    targetKind: 'chapter' | 'cover' | 'outline';
    targetId: string;
    body: string;
    priority: 'must' | 'should' | 'may';
  },
): Promise<string> {
  const comment = await prisma.revisionComment.create({
    data: {
      book_id: bookId,
      target_kind: opts.targetKind,
      target_id: opts.targetId,
      body: opts.body,
      priority: opts.priority,
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

test.describe('E2E: UC-06 完全シーケンス — コメント → 一括反映 → diff → ロールバック → 再ループ (F-049/F-050)', () => {
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
    await prisma.$disconnect();
  });

  // =========================================================================
  // 1. コメント登録 + 一括反映（複数コメント、複数種別、複数優先度）
  // =========================================================================
  test('UC-06-1: 複数コメント（章・サムネ、must/should/may）を登録 → 一括反映起動', async () => {
    const userId = await resolveRealUserId();
    const book1 = await seedBook('loop1-book1');
    const book2 = await seedBook('loop1-book2');
    const enqueue = makeEnqueueMock();
    const deps = buildCreateDeps(userId, enqueue.fn);

    // Register multiple comments across 2 books with mixed targets and priorities
    const chapterCommentId1 = await seedComment(book1.bookId, userId, {
      targetKind: 'chapter',
      targetId: book1.chapterIds[0]!,
      body: '事例を 1 つ追加してください',
      priority: 'should',
    });

    const chapterCommentId2 = await seedComment(book1.bookId, userId, {
      targetKind: 'chapter',
      targetId: book1.chapterIds[1]!,
      body: '冗長なので 2 段落削減してください',
      priority: 'must',
    });

    const coverCommentId1 = await seedComment(book1.bookId, userId, {
      targetKind: 'cover',
      targetId: `cover_${book1.bookId}`,
      body: '文字色をもう少し落ち着いた色に',
      priority: 'should',
    });

    const chapterCommentId3 = await seedComment(book2.bookId, userId, {
      targetKind: 'chapter',
      targetId: book2.chapterIds[0]!,
      body: 'SEO キーワードをもっと含める',
      priority: 'may',
    });

    const coverCommentId2 = await seedComment(book2.bookId, userId, {
      targetKind: 'cover',
      targetId: `cover_${book2.bookId}`,
      body: '解像度を上げてください',
      priority: 'must',
    });

    // Call createRevisionRunCore with all comments
    const result = await createRevisionRunCore(
      {
        comment_ids: [
          chapterCommentId1,
          chapterCommentId2,
          coverCommentId1,
          chapterCommentId3,
          coverCommentId2,
        ],
        scope: 'selected',
      },
      deps,
    );

    // --- Result is OK ---
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[UC-06-1] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    const runId = result.data.run_id;
    insertedRunIds.push(runId);

    // --- Verify basic result fields ---
    expect(typeof runId).toBe('string');
    expect(result.data.blocked_books).toEqual([]);
    expect(result.data.estimated_cost_jpy).toBe(5 * COST_PER_COMMENT_JPY);
    expect(result.data.estimated_minutes).toBeGreaterThanOrEqual(1);

    // --- Verify RevisionRun in DB ---
    const run = await prisma.revisionRun.findUnique({
      where: { id: runId },
    });
    expect(run).not.toBeNull();
    expect(run!.status).toBe('queued');
    expect(run!.triggered_by).toBe(userId);

    const bookIdsJson = run!.book_ids_json as string[];
    expect(bookIdsJson.sort()).toEqual([book1.bookId, book2.bookId].sort());

    const commentIdsJson = run!.comment_ids_json as string[];
    expect(commentIdsJson.sort()).toEqual(
      [
        chapterCommentId1,
        chapterCommentId2,
        coverCommentId1,
        chapterCommentId3,
        coverCommentId2,
      ].sort(),
    );

    // --- Verify all comments linked to run ---
    const comments = await prisma.revisionComment.findMany({
      where: { id: { in: commentIdsJson } },
      select: { id: true, run_id: true, priority: true },
    });
    expect(comments).toHaveLength(5);
    for (const c of comments) {
      expect(c.run_id).toBe(runId);
    }

    // --- Verify enqueue calls (1 per book) ---
    expect(enqueue.calls).toHaveLength(2);
    for (const call of enqueue.calls) {
      expect(call.taskName).toBe(REVISION_BOOK_APPLY_TASK_NAME);
      const payload = call.payload as {
        revision_run_id: string;
        book_id: string;
        comment_ids: string[];
      };
      expect(payload.revision_run_id).toBe(runId);
      expect([book1.bookId, book2.bookId]).toContain(payload.book_id);
    }

    // --- Verify audit_log (action='revision_run.kick') ---
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'revision_run.kick',
        target_kind: 'revision_run',
        target_id: runId,
      },
      orderBy: { created_at: 'desc' },
      take: 1,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const after = audit.after_json as {
      run_id: string;
      comment_count: number;
      book_ids: string[];
      blocked_books: string[];
    };
    expect(after.run_id).toBe(runId);
    expect(after.comment_count).toBe(5);

    // eslint-disable-next-line no-console
    console.log(
      `[UC-06-1] run_id=${runId} comments=5 books=2 ` +
        `cost=${result.data.estimated_cost_jpy}JPY enqueue=2 audit=1`,
    );
  });

  // =========================================================================
  // 2. Run ライフサイクル — queued → running → done 状態遷移
  // =========================================================================
  test('UC-06-2: RevisionRun status transition: queued → running → done', async () => {
    const userId = await resolveRealUserId();
    const book = await seedBook('lifecycle');
    const enqueue = makeEnqueueMock();
    const deps = buildCreateDeps(userId, enqueue.fn);

    // Create 2 comments
    const commentId1 = await seedComment(book.bookId, userId, {
      targetKind: 'chapter',
      targetId: book.chapterIds[0]!,
      body: 'コメント 1',
      priority: 'must',
    });
    const commentId2 = await seedComment(book.bookId, userId, {
      targetKind: 'chapter',
      targetId: book.chapterIds[1]!,
      body: 'コメント 2',
      priority: 'should',
    });

    const result = await createRevisionRunCore(
      {
        comment_ids: [commentId1, commentId2],
        scope: 'selected',
      },
      deps,
    );

    expect(isOk(result)).toBe(true);
    const runId = result.data.run_id;
    insertedRunIds.push(runId);

    // --- State 1: queued (just created) ---
    let run = await prisma.revisionRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    expect(run!.status).toBe('queued');

    // --- Simulate state transition: queued → running ---
    await prisma.revisionRun.update({
      where: { id: runId },
      data: {
        status: 'running',
        started_at: new Date(),
      },
    });

    run = await prisma.revisionRun.findUnique({
      where: { id: runId },
      select: { status: true, started_at: true },
    });
    expect(run!.status).toBe('running');
    expect(run!.started_at).not.toBeNull();

    // --- Simulate state transition: running → done ---
    await prisma.revisionRun.update({
      where: { id: runId },
      data: {
        status: 'done',
        finished_at: new Date(),
        result_summary_json: {
          applied: 2,
          not_applicable: 0,
          failed: 0,
          cost_jpy: 2 * COST_PER_COMMENT_JPY,
          blocked_books: [],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    run = await prisma.revisionRun.findUnique({
      where: { id: runId },
      select: { status: true, finished_at: true },
    });
    expect(run!.status).toBe('done');
    expect(run!.finished_at).not.toBeNull();

    // eslint-disable-next-line no-console
    console.log(
      `[UC-06-2] run_id=${runId} lifecycle: queued → running → done ✓`,
    );
  });

  // =========================================================================
  // 3. ロールバック — 適用済みコメントを pending に復帰
  // =========================================================================
  test('UC-06-3: ロールバック (rollbackRevisionRunCore) → コメント pending 復帰 + 章復元', async () => {
    const userId = await resolveRealUserId();
    const book = await seedBook('rollback');
    const enqueue = makeEnqueueMock();
    const createDeps = buildCreateDeps(userId, enqueue.fn);

    // Create comments and run
    const chapterCommentId = await seedComment(book.bookId, userId, {
      targetKind: 'chapter',
      targetId: book.chapterIds[0]!,
      body: '章本文の改善',
      priority: 'should',
    });

    const coverCommentId = await seedComment(book.bookId, userId, {
      targetKind: 'cover',
      targetId: `cover_${book.bookId}`,
      body: 'サムネ修正',
      priority: 'must',
    });

    const createResult = await createRevisionRunCore(
      {
        comment_ids: [chapterCommentId, coverCommentId],
        scope: 'selected',
      },
      createDeps,
    );

    expect(isOk(createResult)).toBe(true);
    const runId = createResult.data.run_id;
    insertedRunIds.push(runId);

    // Simulate run completion: update comments to applied, update chapter
    await prisma.revisionComment.updateMany({
      where: { id: { in: [chapterCommentId, coverCommentId] } },
      data: {
        status: 'applied',
        applied_at: new Date(),
      },
    });

    const chapterId = book.chapterIds[0]!;
    const originalBody = `これは修正前の章本文です。\n元のテキストが入っています。(第1章)`;
    const modifiedBody = `これは修正後の章本文です。\n改善されたテキストが入っています。(第1章)`;

    // Create ChapterRevision for the original state
    await prisma.chapterRevision.create({
      data: {
        chapter_id: chapterId,
        book_id: book.bookId,
        version: 1,
        body_md: originalBody,
        reason: `revision_run:${runId}`,
      },
    });

    // Update chapter to modified state (simulating applied comment effect)
    await prisma.chapter.update({
      where: { id: chapterId },
      data: {
        body_md: modifiedBody,
        version: 2,
        char_count: modifiedBody.length,
      },
    });

    // Update run status to done
    await prisma.revisionRun.update({
      where: { id: runId },
      data: {
        status: 'done',
        finished_at: new Date(),
        result_summary_json: {
          applied: 2,
          not_applicable: 0,
          failed: 0,
          cost_jpy: 2 * COST_PER_COMMENT_JPY,
          blocked_books: [],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // --- Now rollback ---
    const rollbackDeps = buildRollbackDeps(userId);
    const rollbackResult = await rollbackRevisionRunCore(
      { revision_run_id: runId },
      rollbackDeps,
    );

    // --- Result is OK ---
    expect(isOk(rollbackResult)).toBe(true);
    if (!isOk(rollbackResult)) {
      // eslint-disable-next-line no-console
      console.error('[UC-06-3 rollback] unexpected fail:', JSON.stringify(rollbackResult));
      throw new Error('expected ok rollback result');
    }

    expect(rollbackResult.data.restored).toBeGreaterThanOrEqual(2);

    // --- Verify comments reset to pending ---
    const comments = await prisma.revisionComment.findMany({
      where: { id: { in: [chapterCommentId, coverCommentId] } },
      select: { id: true, status: true, applied_at: true },
    });
    expect(comments).toHaveLength(2);
    for (const c of comments) {
      expect(c.status).toBe('pending');
      expect(c.applied_at).toBeNull();
    }

    // --- Verify chapter body restored ---
    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { body_md: true, version: true },
    });
    expect(chapter).not.toBeNull();
    expect(chapter!.body_md).toBe(originalBody);
    expect(chapter!.version).toBe(3); // Incremented after rollback

    // --- Verify audit_log (action='revision_run.rollback') ---
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'revision_run.rollback',
        target_kind: 'revision_run',
        target_id: runId,
      },
      orderBy: { created_at: 'desc' },
      take: 1,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    insertedAuditIds.push(auditRows[0]!.id);

    const after = auditRows[0]!.after_json as {
      revision_run_id: string;
      restored_count: number;
      chapter_ids_restored: string[];
    };
    expect(after.revision_run_id).toBe(runId);
    expect(after.restored_count).toBeGreaterThanOrEqual(2);

    // eslint-disable-next-line no-console
    console.log(
      `[UC-06-3 rollback] run_id=${runId} chapter=${chapterId} ` +
        `body restored version=3 comments=pending audit=1`,
    );
  });

  // =========================================================================
  // 4. 再ループ — 追加コメント登録 → 新 run 起動
  // =========================================================================
  test('UC-06-4: ロールバック後の再ループ → 新規 run 起動（2 周目）', async () => {
    const userId = await resolveRealUserId();
    const book = await seedBook('reloop');
    const enqueue = makeEnqueueMock();
    const deps = buildCreateDeps(userId, enqueue.fn);

    // First loop: create and run
    const comment1 = await seedComment(book.bookId, userId, {
      targetKind: 'chapter',
      targetId: book.chapterIds[0]!,
      body: 'ループ 1 のコメント',
      priority: 'must',
    });

    const run1Result = await createRevisionRunCore(
      {
        comment_ids: [comment1],
        scope: 'selected',
      },
      deps,
    );

    expect(isOk(run1Result)).toBe(true);
    const run1Id = run1Result.data.run_id;
    insertedRunIds.push(run1Id);

    // Simulate first run completion
    await prisma.revisionComment.update({
      where: { id: comment1 },
      data: {
        status: 'applied',
        applied_at: new Date(),
      },
    });

    await prisma.revisionRun.update({
      where: { id: run1Id },
      data: {
        status: 'done',
        finished_at: new Date(),
        result_summary_json: {
          applied: 1,
          not_applicable: 0,
          failed: 0,
          cost_jpy: COST_PER_COMMENT_JPY,
          blocked_books: [],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // Rollback first run
    const rollbackDeps = buildRollbackDeps(userId);
    const rollbackResult = await rollbackRevisionRunCore(
      { revision_run_id: run1Id },
      rollbackDeps,
    );
    expect(isOk(rollbackResult)).toBe(true);

    // Verify comment back to pending
    let commentCheck = await prisma.revisionComment.findUnique({
      where: { id: comment1 },
      select: { status: true },
    });
    expect(commentCheck!.status).toBe('pending');

    // ===== Second loop: Add new comment + create new run =====
    const comment2 = await seedComment(book.bookId, userId, {
      targetKind: 'chapter',
      targetId: book.chapterIds[1]!,
      body: 'ループ 2 の追加コメント',
      priority: 'should',
    });

    // Create second run with both comments
    const run2Result = await createRevisionRunCore(
      {
        comment_ids: [comment1, comment2], // Include both old and new
        scope: 'selected',
      },
      deps,
    );

    expect(isOk(run2Result)).toBe(true);
    const run2Id = run2Result.data.run_id;
    insertedRunIds.push(run2Id);

    // Verify different run IDs
    expect(run2Id).not.toBe(run1Id);

    // Verify second run is queued
    const run2 = await prisma.revisionRun.findUnique({
      where: { id: run2Id },
      select: { status: true, comment_ids_json: true },
    });
    expect(run2!.status).toBe('queued');

    const commentIdsJson = run2!.comment_ids_json as string[];
    expect(commentIdsJson.sort()).toEqual([comment1, comment2].sort());

    // Verify both comments linked to new run
    const comments = await prisma.revisionComment.findMany({
      where: { id: { in: [comment1, comment2] } },
      select: { id: true, run_id: true, status: true },
    });
    for (const c of comments) {
      expect(c.run_id).toBe(run2Id);
      expect(c.status).toBe('pending');
    }

    // eslint-disable-next-line no-console
    console.log(
      `[UC-06-4 reloop] run1=${run1Id} → rollback → run2=${run2Id} ` +
        `comments=2 books=1 ✓`,
    );
  });

  // =========================================================================
  // 5. 複数冊の部分ロック + コメント除外
  // =========================================================================
  test('UC-06-5: 1 冊ロック時 → blocked_books に含まれ、その冊のコメント除外', async () => {
    const userId = await resolveRealUserId();
    const bookOk = await seedBook('partial-ok');
    const bookLocked = await seedBook('partial-locked');
    const enqueue = makeEnqueueMock();
    const deps = buildCreateDeps(userId, enqueue.fn);

    // Create comments for both books
    const okCommentId = await seedComment(bookOk.bookId, userId, {
      targetKind: 'chapter',
      targetId: bookOk.chapterIds[0]!,
      body: 'OK 冊のコメント',
      priority: 'must',
    });

    const lockedComment1 = await seedComment(bookLocked.bookId, userId, {
      targetKind: 'chapter',
      targetId: bookLocked.chapterIds[0]!,
      body: 'ロック冊コメント 1',
      priority: 'should',
    });

    const lockedComment2 = await seedComment(bookLocked.bookId, userId, {
      targetKind: 'cover',
      targetId: `cover_${bookLocked.bookId}`,
      body: 'ロック冊コメント 2',
      priority: 'may',
    });

    // Lock the second book
    await prisma.bookLock.create({
      data: {
        book_id: bookLocked.bookId,
        holder: `test:lock:${Date.now()}`,
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
      },
    });

    // Try to create run with all comments
    const result = await createRevisionRunCore(
      {
        comment_ids: [okCommentId, lockedComment1, lockedComment2],
        scope: 'selected',
      },
      deps,
    );

    // --- Result is OK (partial success) ---
    expect(isOk(result)).toBe(true);
    const runId = result.data.run_id;
    insertedRunIds.push(runId);

    // --- blocked_books contains locked book ---
    expect(result.data.blocked_books).toEqual([bookLocked.bookId]);

    // --- Only 1 comment applied (the one from unlocked book) ---
    expect(result.data.estimated_cost_jpy).toBe(1 * COST_PER_COMMENT_JPY);

    // --- Run includes only unlocked book ---
    const run = await prisma.revisionRun.findUnique({
      where: { id: runId },
      select: { book_ids_json: true, comment_ids_json: true },
    });
    const bookIdsJson = run!.book_ids_json as string[];
    const commentIdsJson = run!.comment_ids_json as string[];

    expect(bookIdsJson).toEqual([bookOk.bookId]);
    expect(commentIdsJson).toEqual([okCommentId]);

    // --- Locked comments NOT linked to run ---
    const lockedComments = await prisma.revisionComment.findMany({
      where: { id: { in: [lockedComment1, lockedComment2] } },
      select: { id: true, run_id: true },
    });
    for (const c of lockedComments) {
      expect(c.run_id).toBeNull();
    }

    // --- Enqueue called only once (unlocked book) ---
    expect(enqueue.calls).toHaveLength(1);

    // eslint-disable-next-line no-console
    console.log(
      `[UC-06-5 partial-lock] run_id=${runId} ` +
        `eligible=1 blocked_books=[${bookLocked.bookId}] enqueue=1`,
    );
  });

  // =========================================================================
  // 6. must コメント優先度と book flags
  // =========================================================================
  test('UC-06-6: must コメント優先度で has_blocking_comments フラグ更新', async () => {
    const userId = await resolveRealUserId();
    const book = await seedBook('flags');
    const enqueue = makeEnqueueMock();
    const deps = buildCreateDeps(userId, enqueue.fn);

    // Create must comment
    const mustCommentId = await seedComment(book.bookId, userId, {
      targetKind: 'chapter',
      targetId: book.chapterIds[0]!,
      body: 'これは必須修正です',
      priority: 'must',
    });

    const shouldCommentId = await seedComment(book.bookId, userId, {
      targetKind: 'chapter',
      targetId: book.chapterIds[1]!,
      body: 'これは推奨修正です',
      priority: 'should',
    });

    const createResult = await createRevisionRunCore(
      {
        comment_ids: [mustCommentId, shouldCommentId],
        scope: 'selected',
      },
      deps,
    );

    expect(isOk(createResult)).toBe(true);
    const runId = createResult.data.run_id;
    insertedRunIds.push(runId);

    // Verify comments linked to run
    const comments = await prisma.revisionComment.findMany({
      where: { id: { in: [mustCommentId, shouldCommentId] } },
      select: { id: true, priority: true, run_id: true },
    });
    expect(comments).toHaveLength(2);
    for (const c of comments) {
      expect(c.run_id).toBe(runId);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[UC-06-6 flags] run_id=${runId} must=1 should=1 ` +
        `comments linked to run ✓`,
    );
  });
});
