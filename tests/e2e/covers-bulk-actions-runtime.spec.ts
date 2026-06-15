/**
 * Runtime verification spec for T-05-09 -- covers Server Actions
 * core logic (F-019): bulkAdoptCovers / regenerateCover / regenerateCoverText.
 *
 * SP-05 段階では S-012 カバー承認 UI (T-05-10) はまだ配線されていないため、
 * Playwright を test runner として借用し、core 関数を
 * 実 PrismaClient + 実 PostgreSQL に対して直接呼び出す
 * (outlines-bulk-actions-runtime.spec.ts と同パターン)。
 *
 * シナリオ:
 *   1. bulkAdoptCovers: 3 件の generated cover を一括採用 -->
 *      adopted に変更、同 book の他 cover は rejected、
 *      export Job 作成 (per book) + enqueueJob 呼出 + audit_log 記録
 *   2. regenerateCover: book_id を指定して再生成 -->
 *      thumbnail.image Job 作成、job_id 返却、audit_log 記録
 *   3. regenerateCoverText: book_id を指定してテキスト再生成 -->
 *      thumbnail.text Job 作成、job_id 返却、audit_log 記録
 *
 * モック対象: enqueueJob のみ (graphile-worker キューには書き込まない)。
 * 外部 API 呼出ゼロ。コストゼロ。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { isOk } from '@a2p/contracts';
import {
  bulkAdoptCoversCore,
  regenerateCoverCore,
  regenerateCoverTextCore,
  PIPELINE_BOOK_EXPORT_TASK_NAME,
  PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
  PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
  type CoversDeps,
  type RunTransactionFn,
} from '../../apps/web/lib/covers-core.js';

const TEST_PEN_PREFIX = 'e2e-t-05-09-covers';

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
      return `mock-graphile-job-covers-${counter}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Real transaction (same shape as apps/web/app/actions/covers.ts)
// ---------------------------------------------------------------------------

const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      coverRepo: tx.cover,
      jobRepo: tx.job,
      auditLogRepo: tx.auditLog,
    }),
  );

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function buildDeps(
  userId: string,
  enqueueJobFn: (taskName: string, payload: unknown) => Promise<string>,
): CoversDeps {
  return {
    coverRepo: prisma.cover,
    bookRepo: prisma.book,
    jobRepo: prisma.job,
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

    // Account cascade deletes Book -> Cover, Outline, Chapter, etc.
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

interface SeededBulkAdoptContext {
  accountId: string;
  themeId: string;
  bookId: string;
  /** 3 covers with status='generated' intended for adoption */
  adoptCoverIds: string[];
  /** 2 extra covers with status='generated' in the same book (should become rejected) */
  otherCoverIds: string[];
}

/**
 * Seed for scenario 1 (bulkAdoptCovers):
 *  - 1 Account + 1 ThemeCandidate(accepted) + 1 Book(running)
 *  - 5 Covers total: 3 to adopt + 2 others (all status='generated')
 */
async function seedForBulkAdopt(): Promise<SeededBulkAdoptContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-adopt-${Date.now()}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-adopt-session-${Date.now()}`,
      genre: 'business',
      title: 'T-05-09 カバー採用テスト用テーマ',
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
      title: 'T-05-09 カバー採用テスト書籍',
      status: 'running',
      prompt_version_ids_json: {},
      model_assignment_snapshot: {},
    },
    select: { id: true },
  });

  // Create 5 covers: 3 for adoption, 2 others
  const adoptCoverIds: string[] = [];
  const otherCoverIds: string[] = [];

  for (let i = 0; i < 5; i++) {
    const cover = await prisma.cover.create({
      data: {
        book_id: book.id,
        r2_key: `test/covers/${book.id}/cover-${i}.png`,
        prompt_used: `テスト用プロンプト ${i}`,
        width: 1600,
        height: 2560,
        status: 'generated',
        generation_meta_json: {
          provider: 'openai',
          model: 'gpt-image-1',
          cost_jpy: 8,
        },
      },
      select: { id: true },
    });
    if (i < 3) {
      adoptCoverIds.push(cover.id);
    } else {
      otherCoverIds.push(cover.id);
    }
  }

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    adoptCoverIds,
    otherCoverIds,
  };
}

interface SeededRegenerateContext {
  accountId: string;
  bookId: string;
}

/**
 * Seed for scenarios 2 and 3 (regenerateCover / regenerateCoverText):
 *  - 1 Account + 1 ThemeCandidate(accepted) + 1 Book(running)
 */
async function seedForRegenerate(suffix: string): Promise<SeededRegenerateContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-regen-${suffix}-${Date.now()}`,
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
      theme_session_id: `${TEST_PEN_PREFIX}-regen-${suffix}-session-${Date.now()}`,
      genre: 'business',
      title: `T-05-09 カバー再生成テスト用テーマ (${suffix})`,
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
      title: `T-05-09 カバー再生成テスト書籍 (${suffix})`,
      status: 'running',
      prompt_version_ids_json: {},
      model_assignment_snapshot: {},
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    bookId: book.id,
  };
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('runtime: covers SA core against real Postgres (T-05-09, F-019)', () => {
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
  // 1. bulkAdoptCovers: 3 件 generated -> adopted + 他 cover rejected
  //    + export Job per book + enqueueJob 呼出 + audit_log
  // -------------------------------------------------------------------------
  test('bulkAdoptCoversCore: 3 件 generated -> adopted / 他 2 件 rejected / export Job INSERT / enqueue', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedForBulkAdopt();
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await bulkAdoptCoversCore(
      { cover_ids: seeded.adoptCoverIds },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-05-09 adopt] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }
    expect(result.data.adopted).toBe(3);
    expect(result.data.enqueued_book_ids).toEqual([seeded.bookId]);
    expect(result.data.failed_items).toEqual([]);

    // --- Cover: 採用対象 3 件 status='adopted' --------------------------------
    const adoptedCovers = await prisma.cover.findMany({
      where: { id: { in: seeded.adoptCoverIds } },
    });
    expect(adoptedCovers).toHaveLength(3);
    for (const c of adoptedCovers) {
      expect(c.status).toBe('adopted');
    }

    // --- Cover: 同 book の他 2 件 status='rejected' ----------------------------
    const otherCovers = await prisma.cover.findMany({
      where: { id: { in: seeded.otherCoverIds } },
    });
    expect(otherCovers).toHaveLength(2);
    for (const c of otherCovers) {
      expect(c.status).toBe('rejected');
    }

    // --- Job INSERT x 1 (kind='pipeline.book.export') -------------------------
    const jobs = await prisma.job.findMany({
      where: {
        book_id: seeded.bookId,
        kind: PIPELINE_BOOK_EXPORT_TASK_NAME,
      },
    });
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.kind).toBe(PIPELINE_BOOK_EXPORT_TASK_NAME);
    expect(job.status).toBe('queued');
    expect(job.book_id).toBe(seeded.bookId);
    const payload = job.payload_json as Record<string, unknown>;
    expect(payload.book_id).toBe(seeded.bookId);

    // --- enqueueJob mock: 1 回呼出 (1 book) -----------------------------------
    expect(enqueue.calls).toHaveLength(1);
    const c0 = enqueue.calls[0]!;
    expect(c0.taskName).toBe(PIPELINE_BOOK_EXPORT_TASK_NAME);
    const ep = c0.payload as Record<string, unknown>;
    expect(ep.book_id).toBe(seeded.bookId);
    expect(ep.job_id).toBe(job.id);

    // --- audit_log: 1 件 (action='covers.bulk_adopt') -------------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'covers.bulk_adopt',
        target_kind: 'cover',
        target_id: 'bulk',
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    // Find ours by matching adopted_cover_ids in after_json
    const ours = auditRows.find((r) => {
      const af = r.after_json as { adopted_cover_ids?: string[] } | null;
      const ids = af?.adopted_cover_ids ?? [];
      return (
        ids.length === seeded.adoptCoverIds.length &&
        ids.every((id) => seeded.adoptCoverIds.includes(id))
      );
    });
    expect(ours).toBeDefined();
    insertedAuditIds.push(ours!.id);
    expect(ours!.target_kind).toBe('cover');
    expect(ours!.target_id).toBe('bulk');

    const after = ours!.after_json as {
      adopted_count: number;
      adopted_cover_ids: string[];
      book_ids: string[];
      jobs: Array<{ book_id: string; job_id: string; kind: string }>;
    };
    expect(after.adopted_count).toBe(3);
    expect(after.adopted_cover_ids.sort()).toEqual([...seeded.adoptCoverIds].sort());
    expect(after.book_ids).toEqual([seeded.bookId]);
    expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0]!.kind).toBe(PIPELINE_BOOK_EXPORT_TASK_NAME);
    expect(after.jobs[0]!.book_id).toBe(seeded.bookId);

    // eslint-disable-next-line no-console
    console.log(
      `[T-05-09 adopt] adopted=${result.data.adopted} jobs_inserted=${jobs.length} ` +
        `enqueue_calls=${enqueue.calls.length} other_rejected=${otherCovers.length} audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 2. regenerateCover: book_id -> thumbnail.image Job 作成 + job_id 返却
  // -------------------------------------------------------------------------
  test('regenerateCoverCore: book_id -> thumbnail.image Job INSERT + enqueue + audit_log', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedForRegenerate('image');
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await regenerateCoverCore(
      { book_id: seeded.bookId, count: 4, style_tweak: 'ミニマル和風' },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-05-09 regen image] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }
    expect(typeof result.data.job_id).toBe('string');

    // --- Job INSERT (kind='pipeline.book.thumbnail.image') -------------------
    const job = await prisma.job.findUnique({
      where: { id: result.data.job_id },
    });
    expect(job).not.toBeNull();
    expect(job!.kind).toBe(PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME);
    expect(job!.status).toBe('queued');
    expect(job!.book_id).toBe(seeded.bookId);

    const payload = job!.payload_json as Record<string, unknown>;
    expect(payload.book_id).toBe(seeded.bookId);
    expect(payload.count).toBe(4);
    expect(payload.style_tweak).toBe('ミニマル和風');

    // --- enqueueJob mock: 1 回呼出 -------------------------------------------
    expect(enqueue.calls).toHaveLength(1);
    const c0 = enqueue.calls[0]!;
    expect(c0.taskName).toBe(PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME);
    const ep = c0.payload as Record<string, unknown>;
    expect(ep.book_id).toBe(seeded.bookId);
    expect(ep.job_id).toBe(result.data.job_id);
    expect(ep.count).toBe(4);
    expect(ep.style_tweak).toBe('ミニマル和風');

    // --- audit_log: 1 件 (action='covers.regenerate_image') ------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'covers.regenerate_image',
        target_kind: 'book',
        target_id: seeded.bookId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const after = audit.after_json as {
      job_id: string;
      kind: string;
      count: number;
      style_tweak: string | null;
    };
    expect(after.job_id).toBe(result.data.job_id);
    expect(after.kind).toBe(PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME);
    expect(after.count).toBe(4);
    expect(after.style_tweak).toBe('ミニマル和風');

    // eslint-disable-next-line no-console
    console.log(
      `[T-05-09 regen image] job_id=${result.data.job_id} ` +
        `kind=${job!.kind} count=${payload.count} style_tweak=${payload.style_tweak} ` +
        `enqueue_calls=${enqueue.calls.length} audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 3. regenerateCoverText: book_id -> thumbnail.text Job 作成 + job_id 返却
  // -------------------------------------------------------------------------
  test('regenerateCoverTextCore: book_id -> thumbnail.text Job INSERT + enqueue + audit_log', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedForRegenerate('text');
    const enqueue = makeEnqueueMock();
    const deps = buildDeps(userId, enqueue.fn);

    const result = await regenerateCoverTextCore(
      { book_id: seeded.bookId },
      deps,
    );

    // --- Result is OK -------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-05-09 regen text] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }
    expect(typeof result.data.job_id).toBe('string');

    // --- Job INSERT (kind='pipeline.book.thumbnail.text') --------------------
    const job = await prisma.job.findUnique({
      where: { id: result.data.job_id },
    });
    expect(job).not.toBeNull();
    expect(job!.kind).toBe(PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME);
    expect(job!.status).toBe('queued');
    expect(job!.book_id).toBe(seeded.bookId);

    const payload = job!.payload_json as Record<string, unknown>;
    expect(payload.book_id).toBe(seeded.bookId);

    // --- enqueueJob mock: 1 回呼出 -------------------------------------------
    expect(enqueue.calls).toHaveLength(1);
    const c0 = enqueue.calls[0]!;
    expect(c0.taskName).toBe(PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME);
    const ep = c0.payload as Record<string, unknown>;
    expect(ep.book_id).toBe(seeded.bookId);
    expect(ep.job_id).toBe(result.data.job_id);

    // --- audit_log: 1 件 (action='covers.regenerate_text') -------------------
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'covers.regenerate_text',
        target_kind: 'book',
        target_id: seeded.bookId,
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const audit = auditRows[0]!;
    insertedAuditIds.push(audit.id);

    const after = audit.after_json as {
      job_id: string;
      kind: string;
    };
    expect(after.job_id).toBe(result.data.job_id);
    expect(after.kind).toBe(PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME);

    // eslint-disable-next-line no-console
    console.log(
      `[T-05-09 regen text] job_id=${result.data.job_id} ` +
        `kind=${job!.kind} enqueue_calls=${enqueue.calls.length} audit=1`,
    );
  });
});
