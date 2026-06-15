/**
 * Runtime verification spec for T-04-11 -- retryJobCore Server Action
 * core logic (F-016 / F-046).
 *
 * SP-04 段階では retryJob UI ボタンはまだ配線されていないため、
 * Playwright を test runner として借用し、`retryJobCore` を
 * 実 PrismaClient + 実 PostgreSQL に対して直接呼び出す
 * (outlines-bulk-actions-runtime.spec.ts と同パターン)。
 *
 * シナリオ:
 *   1. Editor 失敗 + 全章 done -> retry(auto) -> Editor のみ再 enqueue
 *      Writer/Chapter ジョブは作成されない。元ジョブの retries +1。audit_log 記録。
 *   2. Chapter 部分完了 (4 章: 2 done, 2 draft) + chapter 失敗ジョブ
 *      -> retry(auto) -> 未完了 2 章分のみジョブ作成
 *   3. Editor 失敗ジョブに対し retry(this_step) -> Editor ジョブ 1 件のみ作成
 *
 * モック対象: enqueueJob のみ (graphile-worker キューには書き込まない)。
 * 外部 API 呼出ゼロ。コストゼロ。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { isOk } from '@a2p/contracts';
import {
  retryJobCore,
  type JobsDeps,
} from '../../apps/web/lib/jobs-core.js';

const TEST_PEN_PREFIX = 'e2e-t-04-11-retry';

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
      return `mock-graphile-job-retry-${counter}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function buildDeps(
  userId: string,
  enqueueJobFn: (taskName: string, payload: unknown) => Promise<string>,
): JobsDeps {
  return {
    jobRepo: prisma.job,
    chapterRepo: prisma.chapter,
    outlineRepo: prisma.outline,
    auditLogRepo: prisma.auditLog,
    session: { user: { id: userId, username: 'e2e-runtime' } },
    enqueueJob: enqueueJobFn,
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeededEditorFailContext {
  accountId: string;
  bookId: string;
  failedJobId: string;
  writerJobId: string;
  chapterJobIds: string[];
}

/**
 * Seed for scenario 1 and 3:
 * - 1 Account + 1 ThemeCandidate(accepted) + 1 Book(running)
 * - 1 Outline(approved) + 4 Chapters (all done)
 * - Jobs: writer.outline(done) + 4x writer.chapter(done) + editor(failed)
 */
async function seedEditorFail(): Promise<SeededEditorFailContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-editorfail-${Date.now()}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-editorfail-session-${Date.now()}`,
      genre: 'business',
      title: 'T-04-11 Editor 失敗テスト用テーマ',
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
      title: 'T-04-11 Editor 失敗テスト書籍',
      status: 'running',
      prompt_version_ids_json: {},
      model_assignment_snapshot: {},
    },
    select: { id: true },
  });

  // Outline (approved)
  await prisma.outline.create({
    data: {
      book_id: book.id,
      status: 'approved',
      approved_at: new Date(),
      chapters_json: Array.from({ length: 4 }, (_, i) => ({
        index: i + 1,
        heading: `ダミー章 ${i + 1}`,
        summary: 'dummy',
        target_chars: 5000,
        subheadings: ['sh1', 'sh2'],
      })),
    },
  });

  // 4 Chapters (all done)
  for (let i = 1; i <= 4; i++) {
    await prisma.chapter.create({
      data: {
        book_id: book.id,
        index: i,
        heading: `テスト章 ${i}`,
        body_md: `テスト本文 ${i}`,
        status: 'done',
        char_count: 5000,
      },
    });
  }

  // Writer outline job (done)
  const writerJob = await prisma.job.create({
    data: {
      kind: 'pipeline.book.writer.outline',
      book_id: book.id,
      status: 'done',
      payload_json: { book_id: book.id },
    },
    select: { id: true },
  });

  // 4 Chapter jobs (done)
  const chapterJobIds: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const chJob = await prisma.job.create({
      data: {
        kind: 'pipeline.book.writer.chapter',
        book_id: book.id,
        status: 'done',
        payload_json: { book_id: book.id, chapter_index: i },
      },
      select: { id: true },
    });
    chapterJobIds.push(chJob.id);
  }

  // Editor job (failed)
  const editorJob = await prisma.job.create({
    data: {
      kind: 'pipeline.book.editor',
      book_id: book.id,
      status: 'failed',
      payload_json: { book_id: book.id },
      error: 'simulated editor failure',
      retries: 0,
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    bookId: book.id,
    failedJobId: editorJob.id,
    writerJobId: writerJob.id,
    chapterJobIds,
  };
}

interface SeededPartialChapterContext {
  accountId: string;
  bookId: string;
  failedJobId: string;
  doneChapterIndices: number[];
  draftChapterIndices: number[];
}

/**
 * Seed for scenario 2:
 * - 1 Account + 1 ThemeCandidate(accepted) + 1 Book(running)
 * - 1 Outline(approved) + 4 Chapters (2 done, 2 draft)
 * - Jobs: writer.outline(done) + 2x writer.chapter(done) + writer.chapter(failed)
 */
async function seedPartialChapter(): Promise<SeededPartialChapterContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-partialch-${Date.now()}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-partialch-session-${Date.now()}`,
      genre: 'business',
      title: 'T-04-11 Chapter 部分完了テスト用テーマ',
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
      title: 'T-04-11 Chapter 部分完了テスト書籍',
      status: 'running',
      prompt_version_ids_json: {},
      model_assignment_snapshot: {},
    },
    select: { id: true },
  });

  // Outline (approved)
  await prisma.outline.create({
    data: {
      book_id: book.id,
      status: 'approved',
      approved_at: new Date(),
      chapters_json: Array.from({ length: 4 }, (_, i) => ({
        index: i + 1,
        heading: `ダミー章 ${i + 1}`,
        summary: 'dummy',
        target_chars: 5000,
        subheadings: ['sh1', 'sh2'],
      })),
    },
  });

  // 4 Chapters: index 1,2 = done, index 3,4 = draft
  for (let i = 1; i <= 4; i++) {
    await prisma.chapter.create({
      data: {
        book_id: book.id,
        index: i,
        heading: `テスト章 ${i}`,
        body_md: i <= 2 ? `完了本文 ${i}` : '',
        status: i <= 2 ? 'done' : 'draft',
        char_count: i <= 2 ? 5000 : 0,
      },
    });
  }

  // Writer outline job (done)
  await prisma.job.create({
    data: {
      kind: 'pipeline.book.writer.outline',
      book_id: book.id,
      status: 'done',
      payload_json: { book_id: book.id },
    },
  });

  // 2 Chapter jobs (done) for index 1,2
  for (let i = 1; i <= 2; i++) {
    await prisma.job.create({
      data: {
        kind: 'pipeline.book.writer.chapter',
        book_id: book.id,
        status: 'done',
        payload_json: { book_id: book.id, chapter_index: i },
      },
    });
  }

  // 1 Chapter job (failed) -- represents the chapter dispatch/writing failure
  const failedJob = await prisma.job.create({
    data: {
      kind: 'pipeline.book.writer.chapter',
      book_id: book.id,
      status: 'failed',
      payload_json: { book_id: book.id, chapter_index: 3 },
      error: 'simulated chapter write failure',
      retries: 0,
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    bookId: book.id,
    failedJobId: failedJob.id,
    doneChapterIndices: [1, 2],
    draftChapterIndices: [3, 4],
  };
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('runtime: retryJobCore against real Postgres (T-04-11, F-016/F-046)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. Editor 失敗 -> retry(auto) -> Editor のみ再 enqueue
  // -------------------------------------------------------------------------
  test('retryJobCore(auto): Editor 失敗 -> Editor のみ再 enqueue, Writer/Chapter は触らない', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedEditorFail();
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await retryJobCore(
      { job_id: seeded.failedJobId, from_step: 'auto' },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-04-11 auto editor] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    expect(result.data.retried_step).toBe('pipeline.book.editor');
    expect(typeof result.data.new_job_id).toBe('string');
    // No additional_job_ids for single-step retry
    expect(result.data.additional_job_ids).toBeUndefined();

    // --- Original job retries incremented -----------------------------------
    const originalJob = await prisma.job.findUnique({
      where: { id: seeded.failedJobId },
    });
    expect(originalJob).not.toBeNull();
    expect(originalJob!.retries).toBe(1);

    // --- New Editor job created (queued) ------------------------------------
    const newEditorJob = await prisma.job.findUnique({
      where: { id: result.data.new_job_id },
    });
    expect(newEditorJob).not.toBeNull();
    expect(newEditorJob!.kind).toBe('pipeline.book.editor');
    expect(newEditorJob!.status).toBe('queued');
    expect(newEditorJob!.book_id).toBe(seeded.bookId);

    // --- No new Writer or Chapter jobs created ------------------------------
    const allNewJobs = await prisma.job.findMany({
      where: {
        book_id: seeded.bookId,
        status: 'queued',
      },
    });
    // Only the 1 new editor job should be queued
    expect(allNewJobs).toHaveLength(1);
    expect(allNewJobs[0]!.kind).toBe('pipeline.book.editor');

    // --- enqueueJob called exactly once with editor task --------------------
    expect(enqueue.calls).toHaveLength(1);
    expect(enqueue.calls[0]!.taskName).toBe('pipeline.book.editor');
    const enqPayload = enqueue.calls[0]!.payload as Record<string, unknown>;
    expect(enqPayload.book_id).toBe(seeded.bookId);
    expect(enqPayload.job_id).toBe(result.data.new_job_id);

    // --- audit_log: 1 entry (action='job.retry') ----------------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'job.retry',
        target_kind: 'job',
        target_id: seeded.failedJobId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const before = audit.before_json as Record<string, unknown>;
    expect(before.job_id).toBe(seeded.failedJobId);
    expect(before.kind).toBe('pipeline.book.editor');
    expect(before.status).toBe('failed');
    expect(before.retries).toBe(0);
    expect(before.from_step).toBe('auto');

    const after = audit.after_json as Record<string, unknown>;
    expect(after.new_job_id).toBe(result.data.new_job_id);
    expect(after.retried_step).toBe('pipeline.book.editor');
    expect(after.retries).toBe(1);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-11 auto editor] retried_step=${result.data.retried_step} ` +
        `new_job=${result.data.new_job_id} enqueue_calls=${enqueue.calls.length} ` +
        `original_retries=${originalJob!.retries} audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 2. Chapter 部分完了 -> retry(auto) -> 未完了章のみ再 enqueue
  // -------------------------------------------------------------------------
  test('retryJobCore(auto): Chapter 部分完了 -> 未完了 2 章分のみジョブ作成', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedPartialChapter();
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await retryJobCore(
      { job_id: seeded.failedJobId, from_step: 'auto' },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-04-11 auto chapter] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    expect(result.data.retried_step).toBe('pipeline.book.writer.chapter');

    // --- 2 new chapter jobs created (for draft chapters 3 and 4) ------------
    const totalNewJobIds = [result.data.new_job_id];
    if (result.data.additional_job_ids) {
      totalNewJobIds.push(...result.data.additional_job_ids);
    }
    expect(totalNewJobIds).toHaveLength(2);

    // Verify each new job
    for (const jobId of totalNewJobIds) {
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      expect(job).not.toBeNull();
      expect(job!.kind).toBe('pipeline.book.writer.chapter');
      expect(job!.status).toBe('queued');
      expect(job!.book_id).toBe(seeded.bookId);

      const payload = job!.payload_json as Record<string, unknown>;
      expect(payload.book_id).toBe(seeded.bookId);
      // chapter_index should be 3 or 4 (draft chapters)
      expect(seeded.draftChapterIndices).toContain(payload.chapter_index);
    }

    // --- enqueueJob called exactly 2 times for draft chapters ----------------
    expect(enqueue.calls).toHaveLength(2);
    const enqueuedIndices = enqueue.calls.map(
      (c) => (c.payload as Record<string, unknown>).chapter_index,
    );
    expect(enqueuedIndices.sort()).toEqual([3, 4]);

    for (const call of enqueue.calls) {
      expect(call.taskName).toBe('pipeline.book.writer.chapter');
      const p = call.payload as Record<string, unknown>;
      expect(p.book_id).toBe(seeded.bookId);
      expect(typeof p.job_id).toBe('string');
    }

    // --- Original job retries incremented -----------------------------------
    const originalJob = await prisma.job.findUnique({
      where: { id: seeded.failedJobId },
    });
    expect(originalJob).not.toBeNull();
    expect(originalJob!.retries).toBe(1);

    // --- No new jobs for done chapters (index 1, 2) -------------------------
    const newQueuedJobs = await prisma.job.findMany({
      where: {
        book_id: seeded.bookId,
        status: 'queued',
        kind: 'pipeline.book.writer.chapter',
      },
    });
    expect(newQueuedJobs).toHaveLength(2);
    const queuedPayloads = newQueuedJobs.map(
      (j) => (j.payload_json as Record<string, unknown>).chapter_index,
    );
    expect((queuedPayloads as number[]).sort()).toEqual([3, 4]);

    // --- audit_log recorded -------------------------------------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'job.retry',
        target_kind: 'job',
        target_id: seeded.failedJobId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    insertedAuditIds.push(auditRows[0]!.id);

    const after = auditRows[0]!.after_json as Record<string, unknown>;
    expect(after.retried_step).toBe('pipeline.book.writer.chapter');
    expect(after.retries).toBe(1);
    const additionalIds = after.additional_job_ids as string[];
    // 1 primary + 1 additional = 2 total
    expect(additionalIds).toHaveLength(1);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-11 auto chapter] retried_step=${result.data.retried_step} ` +
        `total_new_jobs=${totalNewJobIds.length} enqueue_calls=${enqueue.calls.length} ` +
        `draft_indices=${enqueuedIndices} audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 3. this_step: Editor 失敗ジョブに対し retry(this_step) -> Editor 1 件のみ
  // -------------------------------------------------------------------------
  test('retryJobCore(this_step): Editor 失敗 -> Editor ジョブ 1 件のみ作成', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedEditorFail();
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await retryJobCore(
      { job_id: seeded.failedJobId, from_step: 'this_step' },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-04-11 this_step] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }

    expect(result.data.retried_step).toBe('pipeline.book.editor');
    expect(typeof result.data.new_job_id).toBe('string');
    expect(result.data.additional_job_ids).toBeUndefined();

    // --- Only 1 new Editor job created --------------------------------------
    const newJob = await prisma.job.findUnique({
      where: { id: result.data.new_job_id },
    });
    expect(newJob).not.toBeNull();
    expect(newJob!.kind).toBe('pipeline.book.editor');
    expect(newJob!.status).toBe('queued');
    expect(newJob!.book_id).toBe(seeded.bookId);

    // --- enqueueJob called exactly once with editor task --------------------
    expect(enqueue.calls).toHaveLength(1);
    expect(enqueue.calls[0]!.taskName).toBe('pipeline.book.editor');
    const enqPayload = enqueue.calls[0]!.payload as Record<string, unknown>;
    expect(enqPayload.book_id).toBe(seeded.bookId);
    expect(enqPayload.job_id).toBe(result.data.new_job_id);

    // --- Original job retries incremented -----------------------------------
    const originalJob = await prisma.job.findUnique({
      where: { id: seeded.failedJobId },
    });
    expect(originalJob).not.toBeNull();
    expect(originalJob!.retries).toBe(1);

    // --- audit_log recorded with from_step='this_step' ----------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'job.retry',
        target_kind: 'job',
        target_id: seeded.failedJobId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const before = audit.before_json as Record<string, unknown>;
    expect(before.from_step).toBe('this_step');
    expect(before.kind).toBe('pipeline.book.editor');

    const after = audit.after_json as Record<string, unknown>;
    expect(after.new_job_id).toBe(result.data.new_job_id);
    expect(after.retried_step).toBe('pipeline.book.editor');
    expect(after.retries).toBe(1);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-11 this_step] retried_step=${result.data.retried_step} ` +
        `new_job=${result.data.new_job_id} enqueue_calls=${enqueue.calls.length} ` +
        `original_retries=${originalJob!.retries} audit=1`,
    );
  });
});
