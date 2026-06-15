/**
 * Runtime verification spec for T-07-07 -- resumePausedBookCore Server Action
 * core logic (F-034 / F-046).
 *
 * SP-07 段階では PausedJobsTable の UI 操作は配線途中のため、
 * Playwright を test runner として借用し、`resumePausedBookCore` を
 * 実 PrismaClient + 実 PostgreSQL に対して直接呼び出す
 * (retry-job-runtime.spec.ts と同パターン)。
 *
 * シナリオ:
 *   1. continue -- paused_cost 書籍 + cancelled editor job
 *      -> resumePausedBook(continue) -> Book.status='editing', cost_status='normal'
 *         + 新 Job enqueue + audit_log(decision=continue)
 *   2. cancel  -- paused_cost 書籍
 *      -> resumePausedBook(cancel) -> Book.status='cancelled', cost_status='normal'
 *         + BookLock 削除 + audit_log(decision=cancel)
 *   3. not paused rejection -- running 書籍に対して continue を呼ぶと validation エラー
 *   4. book not found -- 存在しない book_id で not_found エラー
 *   5. no cancelled job -- continue 時に cancelled ジョブが無ければ validation エラー
 *
 * モック対象: enqueueJob のみ (graphile-worker キューには書き込まない)。
 * 外部 API 呼出ゼロ。コストゼロ。
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';
import { isOk, isFail } from '@a2p/contracts';
import {
  resumePausedBookCore,
  type ResumePausedBookDeps,
} from '../../apps/web/lib/jobs-core.js';

const TEST_PEN_PREFIX = 'e2e-t-07-07-resume';

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
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupTestRows(): Promise<void> {
  const accounts = await prisma.account.findMany({
    where: { pen_name: { startsWith: TEST_PEN_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0 && insertedAuditIds.length === 0) return;

  if (accountIds.length > 0) {
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

    // Account cascade deletes Book -> Outline, Chapter, etc.
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
      return `mock-graphile-job-resume-${counter}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function buildDeps(
  userId: string,
  enqueueJobFn: (taskName: string, payload: unknown) => Promise<string>,
): ResumePausedBookDeps {
  return {
    bookRepo: prisma.book,
    jobRepo: prisma.job,
    bookLockRepo: prisma.bookLock,
    auditLogRepo: prisma.auditLog,
    session: { user: { id: userId, username: 'e2e-runtime' } },
    enqueueJob: enqueueJobFn,
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeededPausedBookContext {
  accountId: string;
  bookId: string;
  cancelledJobId: string;
  cancelledJobKind: string;
}

/**
 * Seed for scenario 1 (continue):
 * - 1 Account + 1 ThemeCandidate(accepted) + 1 Book(paused_cost, cost_status=paused)
 * - 1 Job(kind='pipeline.book.editor', status='cancelled')
 * - 1 BookLock (to verify it is NOT deleted on continue)
 */
async function seedPausedBookWithCancelledJob(
  label: string,
  cancelledKind = 'pipeline.book.editor',
): Promise<SeededPausedBookContext> {
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
      title: `T-07-07 ${label} テスト用テーマ`,
      hook: 'integration test',
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
      title: `T-07-07 ${label} テスト書籍`,
      status: 'paused_cost',
      cost_status: 'paused',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  // Cancelled pipeline job
  const cancelledJob = await prisma.job.create({
    data: {
      kind: cancelledKind,
      book_id: book.id,
      status: 'cancelled',
      payload_json: { book_id: book.id } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    bookId: book.id,
    cancelledJobId: cancelledJob.id,
    cancelledJobKind: cancelledKind,
  };
}

/**
 * Seed for scenario 2 (cancel):
 * - 1 Account + 1 Book(paused_cost, cost_status=paused)
 * - 1 BookLock (to verify it IS deleted on cancel)
 */
async function seedPausedBookWithLock(): Promise<{
  accountId: string;
  bookId: string;
  bookLockHolder: string;
}> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-cancel-${Date.now()}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-cancel-session-${Date.now()}`,
      genre: 'business',
      title: 'T-07-07 cancel テスト用テーマ',
      hook: 'integration test',
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
      title: 'T-07-07 cancel テスト書籍',
      status: 'paused_cost',
      cost_status: 'paused',
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  const holder = `pipeline:cancel-test-${Date.now()}`;
  await prisma.bookLock.create({
    data: {
      book_id: book.id,
      holder,
      expires_at: new Date(Date.now() + 30 * 60 * 1000), // +30 min
    },
  });

  return {
    accountId: account.id,
    bookId: book.id,
    bookLockHolder: holder,
  };
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('runtime: resumePausedBookCore against real Postgres (T-07-07, F-034/F-046)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. continue -- paused_cost 書籍 + cancelled editor job -> 再開
  // -------------------------------------------------------------------------
  test('resumePausedBookCore(continue): paused_cost 書籍が editing に復帰し editor が enqueue される', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedPausedBookWithCancelledJob('continue');
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await resumePausedBookCore(
      { book_id: seeded.bookId, decision: 'continue' },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-07-07 continue] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    // --- Book status restored -----------------------------------------------
    const book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { status: true, cost_status: true },
    });
    expect(book).not.toBeNull();
    expect(book!.status).toBe('editing');
    expect(book!.cost_status).toBe('normal');

    // --- New Job created (queued) -------------------------------------------
    const newJobs = await prisma.job.findMany({
      where: {
        book_id: seeded.bookId,
        status: 'queued',
      },
    });
    expect(newJobs).toHaveLength(1);
    expect(newJobs[0]!.kind).toBe('pipeline.book.editor');

    // --- enqueueJob called exactly once with editor task --------------------
    expect(enqueue.calls).toHaveLength(1);
    expect(enqueue.calls[0]!.taskName).toBe('pipeline.book.editor');
    const enqPayload = enqueue.calls[0]!.payload as Record<string, unknown>;
    expect(enqPayload.book_id).toBe(seeded.bookId);
    expect(typeof enqPayload.job_id).toBe('string');

    // --- audit_log: 1 entry (action='book.resume', decision='continue') -----
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'book.resume',
        target_kind: 'book',
        target_id: seeded.bookId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const before = audit.before_json as Record<string, unknown>;
    expect(before.status).toBe('paused_cost');
    expect(before.cost_status).toBe('paused');

    const after = audit.after_json as Record<string, unknown>;
    expect(after.decision).toBe('continue');
    expect(after.status).toBe('editing');
    expect(after.cost_status).toBe('normal');
    expect(after.resumed_step).toBe('pipeline.book.editor');
    expect(typeof after.new_job_id).toBe('string');

    // eslint-disable-next-line no-console
    console.log(
      `[T-07-07 continue] book.status=${book!.status} cost_status=${book!.cost_status} ` +
        `enqueue_calls=${enqueue.calls.length} audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 2. cancel -- paused_cost 書籍 -> cancelled + BookLock 削除
  // -------------------------------------------------------------------------
  test('resumePausedBookCore(cancel): paused_cost 書籍が cancelled になり BookLock が解放される', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedPausedBookWithLock();
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    // Verify BookLock exists before
    const lockBefore = await prisma.bookLock.findUnique({
      where: { book_id: seeded.bookId },
    });
    expect(lockBefore).not.toBeNull();
    expect(lockBefore!.holder).toBe(seeded.bookLockHolder);

    const result = await resumePausedBookCore(
      { book_id: seeded.bookId, decision: 'cancel' },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-07-07 cancel] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    // --- Book status = 'cancelled' + cost_status = 'normal' -----------------
    const book = await prisma.book.findUnique({
      where: { id: seeded.bookId },
      select: { status: true, cost_status: true },
    });
    expect(book).not.toBeNull();
    expect(book!.status).toBe('cancelled');
    expect(book!.cost_status).toBe('normal');

    // --- BookLock deleted ----------------------------------------------------
    const lockAfter = await prisma.bookLock.findUnique({
      where: { book_id: seeded.bookId },
    });
    expect(lockAfter).toBeNull();

    // --- No job enqueue for cancel -------------------------------------------
    expect(enqueue.calls).toHaveLength(0);

    // --- No new queued jobs --------------------------------------------------
    const newJobs = await prisma.job.findMany({
      where: {
        book_id: seeded.bookId,
        status: 'queued',
      },
    });
    expect(newJobs).toHaveLength(0);

    // --- audit_log: 1 entry (action='book.resume', decision='cancel') --------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'book.resume',
        target_kind: 'book',
        target_id: seeded.bookId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const after = audit.after_json as Record<string, unknown>;
    expect(after.decision).toBe('cancel');
    expect(after.status).toBe('cancelled');
    expect(after.cost_status).toBe('normal');

    // eslint-disable-next-line no-console
    console.log(
      `[T-07-07 cancel] book.status=${book!.status} cost_status=${book!.cost_status} ` +
        `bookLock=null enqueue_calls=${enqueue.calls.length} audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 3. not paused rejection -- running 書籍に対して continue はエラー
  // -------------------------------------------------------------------------
  test('resumePausedBookCore: running 書籍に対して continue を呼ぶと validation エラー', async () => {
    const userId = await resolveRealUserId();

    // Create a running book (not paused)
    const account = await prisma.account.create({
      data: {
        pen_name: `${TEST_PEN_PREFIX}-notpaused-${Date.now()}`,
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
        theme_session_id: `${TEST_PEN_PREFIX}-notpaused-session-${Date.now()}`,
        genre: 'business',
        title: 'T-07-07 not-paused テスト用テーマ',
        hook: 'integration test',
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
        title: 'T-07-07 not-paused テスト書籍',
        status: 'running',
        cost_status: 'normal',
        prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
        model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await resumePausedBookCore(
      { book_id: book.id, decision: 'continue' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (isFail(result)) {
      expect(result.error.code).toBe('validation');
    }
    expect(enqueue.calls).toHaveLength(0);

    // eslint-disable-next-line no-console
    console.log('[T-07-07 not-paused] correctly rejected with validation error');
  });

  // -------------------------------------------------------------------------
  // 4. book not found
  // -------------------------------------------------------------------------
  test('resumePausedBookCore: 存在しない book_id で not_found エラー', async () => {
    const userId = await resolveRealUserId();
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await resumePausedBookCore(
      { book_id: 'nonexistent-book-id-12345', decision: 'continue' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (isFail(result)) {
      expect(result.error.code).toBe('not_found');
    }
    expect(enqueue.calls).toHaveLength(0);

    // eslint-disable-next-line no-console
    console.log('[T-07-07 not-found] correctly rejected with not_found error');
  });

  // -------------------------------------------------------------------------
  // 5. no cancelled job on continue
  // -------------------------------------------------------------------------
  test('resumePausedBookCore(continue): cancelled ジョブが 0 件だと validation エラー', async () => {
    const userId = await resolveRealUserId();

    // Paused book but NO cancelled pipeline jobs
    const account = await prisma.account.create({
      data: {
        pen_name: `${TEST_PEN_PREFIX}-nocancelled-${Date.now()}`,
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
        theme_session_id: `${TEST_PEN_PREFIX}-nocancelled-session-${Date.now()}`,
        genre: 'business',
        title: 'T-07-07 no-cancelled テスト用テーマ',
        hook: 'integration test',
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
        title: 'T-07-07 no-cancelled テスト書籍',
        status: 'paused_cost',
        cost_status: 'paused',
        prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
        model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await resumePausedBookCore(
      { book_id: book.id, decision: 'continue' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (isFail(result)) {
      expect(result.error.code).toBe('validation');
    }
    expect(enqueue.calls).toHaveLength(0);

    // eslint-disable-next-line no-console
    console.log('[T-07-07 no-cancelled] correctly rejected with validation error');
  });
});
