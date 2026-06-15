/**
 * Runtime verification spec for T-04-07 — `bulkApproveOutlines` /
 * `bulkRejectOutlines` Server Actions コアロジック (F-018).
 *
 * SP-04 段階では S-011 アウトライン承認 UI (T-04-08) はまだ配線されていないため、
 * 通常の Playwright (ブラウザ操作 → DOM 検証) では F-018 を E2E で検証できない。
 * 既存 `apps/web/__tests__/actions/outlines.test.ts` (17 ケース) は DI スタブで
 * ロジックを単体検証済みだが、本 spec は以下を追加で実証する:
 *
 *   - 実 PostgreSQL (Docker `a2p-pg` port 5433 / .env.local の DATABASE_URL)
 *     に対して `bulkApproveOutlinesCore` / `bulkRejectOutlinesCore` を実
 *     PrismaClient + 実 $transaction で呼び出す
 *   - Outline / Book / Job / AuditLog の各テーブル INSERT/UPDATE が成立し、
 *     コアロジックが想定通り DB 状態を遷移させる
 *   - `enqueueJob` は **mock** とし、graphile-worker キューには書き込まない
 *     (本 spec の目的は SA コア層 ↔ Postgres の結合検証であり、graphile 経由の
 *      実 worker 起動は T-04-04/T-04-05 の runtime spec が既にカバー済み)
 *   - 内部 Job 行 (`prisma.job`) への INSERT 内容 (kind/book_id/status/payload_json)
 *     を必ず assert
 *
 * シナリオ:
 *   1. 承認パス: Outline.status='pending_review' な 2 件を作成 →
 *      `bulkApproveOutlinesCore` 実行 → 各 Outline.status='approved' +
 *      approved_at 設定 + Book.status='running' + Job
 *      (kind='pipeline.book.writer.chapters.dispatch') 2 件 INSERT +
 *      audit_log 1 件 (action='outlines.bulk_approve') + enqueueJob 2 回呼出
 *   2. 差戻しパス: Outline.status='pending_review' な 1 件を作成 →
 *      `bulkRejectOutlinesCore` 実行 → Outline.status='rejected' +
 *      reject_note 設定 + Job (kind='pipeline.book.writer.outline',
 *      payload.reject_note 一致) 1 件 INSERT + audit_log 1 件
 *      (action='outlines.bulk_reject') + enqueueJob 1 回呼出
 *
 * 注:
 *  - 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner として
 *    借用し、@a2p/db / apps/web/lib/outlines-core を直接 import する。
 *  - セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *    .env.local (DATABASE_URL) が前提。
 *  - 外部 API 呼出ゼロ (enqueueJob mock + LLM 不使用)。コストゼロ。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { isOk } from '@a2p/contracts';
import {
  bulkApproveOutlinesCore,
  bulkRejectOutlinesCore,
  PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
  PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
  type OutlinesDeps,
  type RunTransactionFn,
} from '../../apps/web/lib/outlines-core.js';

const TEST_PEN_PREFIX = 'e2e-t-04-07-outlines';

/**
 * 実 prisma.$transaction を使って RunTransactionFn を組み立てる
 * (apps/web/app/actions/outlines.ts の realRunTransaction と同形)。
 */
const realRunTransaction: RunTransactionFn = async (fn) =>
  prisma.$transaction(async (tx) =>
    fn({
      outlineRepo: tx.outline,
      bookRepo: tx.book,
      jobRepo: tx.job,
      auditLogRepo: tx.auditLog,
    }),
  );

interface SeededApproveContext {
  accountId: string;
  themeId: string;
  bookIds: string[];
  outlineIds: string[];
}

interface SeededRejectContext {
  accountId: string;
  themeId: string;
  bookId: string;
  outlineId: string;
}

/**
 * audit_log.actor_id は users(id) への FK。本 spec は実 DB に書くので、
 * 既存ユーザー (シード済 operator) の id を取得して session.user.id に注入する。
 * AUTH_USERNAME が未設定 / ユーザー未シードの環境では skip する。
 */
let realUserId: string | null = null;

/** 本 spec が INSERT した audit_log 行の id を控え、afterAll で削除する. */
const insertedAuditIds: string[] = [];

async function resolveRealUserId(): Promise<string> {
  if (realUserId) return realUserId;
  // global.setup.ts でログイン成功している前提なので、最低 1 ユーザは存在するはず
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    throw new Error(
      'users テーブルにユーザーが存在しません。`pnpm --filter @a2p/db db:seed` を実行してください',
    );
  }
  realUserId = user.id;
  return realUserId;
}

/**
 * 本 spec 由来の行を全削除 (afterAll / beforeAll で使用).
 * Account.pen_name の prefix で本テスト由来を識別、依存テーブルは ON DELETE CASCADE
 * (Book / Outline は cascade) で消える。Job / AuditLog は cascade なしなので
 * book_id / target_id 経由で明示削除する。
 */
async function cleanupTestRows(): Promise<void> {
  // 本 spec 由来 Account を pen_name prefix で特定
  const accounts = await prisma.account.findMany({
    where: { pen_name: { startsWith: TEST_PEN_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return;

  // 当該 account 配下の book id を集める
  const books = await prisma.book.findMany({
    where: { account_id: { in: accountIds } },
    select: { id: true },
  });
  const bookIds = books.map((b) => b.id);

  // outline id (audit_log target_id 候補) を先に集める — bulk audit は
  // target_id='bulk' で書かれるので outline id は audit_log の検索 key にはならないが、
  // 念のため取得しておく
  const outlines = await prisma.outline.findMany({
    where: { book_id: { in: bookIds } },
    select: { id: true },
  });
  const outlineIds = outlines.map((o) => o.id);

  // Job (cascade なし、book_id SetNull)
  if (bookIds.length > 0) {
    await prisma.job
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
  }

  // AuditLog: 本 spec の audit 行を削除。target_id='bulk' で書かれるため
  // outline id では引けない。各テストが trackAuditId に id を控えているので
  // それらを id IN で削除する (テスト独立性確保)。
  if (insertedAuditIds.length > 0) {
    await prisma.auditLog
      .deleteMany({ where: { id: { in: insertedAuditIds } } })
      .catch(() => undefined);
    insertedAuditIds.length = 0;
  }

  // BookLock 残骸 (Phase 1 の writer outline 系は持たないが念のため)
  if (bookIds.length > 0) {
    await prisma.bookLock
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
  }

  // Account を消すと cascade で ThemeCandidate / Book / Outline が落ちる
  await prisma.account
    .deleteMany({ where: { id: { in: accountIds } } })
    .catch(() => undefined);

  // outlineIds は cleanup の参考情報 (assertion 不要、未使用警告を回避)
  void outlineIds;
}

/**
 * 承認シナリオ用シード: 1 Account + 1 ThemeCandidate(accepted) + N Book(queued) +
 * N Outline(pending_review). Outline.chapters_json は最小ダミー (本 spec は承認/
 * 差戻し SA の DB 遷移検証のみで、章本文生成は別タスクの範疇).
 */
async function seedForApprove(bookCount: number): Promise<SeededApproveContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-approve-${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['remote_work'],
      },
      status: 'archived',
    },
    select: { id: true },
  });

  const theme = await prisma.themeCandidate.create({
    data: {
      account_id: account.id,
      theme_session_id: `${TEST_PEN_PREFIX}-approve-session-${Date.now()}`,
      genre: 'business',
      title: 'T-04-07 承認シナリオ用テーマ',
      hook: 'integration test',
      competitors_json: [],
      signals_json: { sources: ['test'] },
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const bookIds: string[] = [];
  const outlineIds: string[] = [];

  for (let i = 0; i < bookCount; i += 1) {
    const book = await prisma.book.create({
      data: {
        account_id: account.id,
        theme_id: theme.id,
        title: `T-04-07 承認テスト書籍 #${i + 1}`,
        status: 'queued',
        prompt_version_ids_json: {},
        model_assignment_snapshot: {},
      },
      select: { id: true },
    });
    bookIds.push(book.id);

    const outline = await prisma.outline.create({
      data: {
        book_id: book.id,
        status: 'pending_review',
        // F-003 受入: 7-10 章 / 各章 target_chars 等 — 本 spec は SA の DB 遷移検証なので
        // 最小ダミー (3 章) で十分。承認 SA は chapters_json の中身を読まない。
        chapters_json: [
          {
            index: 1,
            heading: 'ダミー章 1',
            summary: 'dummy',
            target_chars: 5000,
            subheadings: ['sh1', 'sh2'],
          },
          {
            index: 2,
            heading: 'ダミー章 2',
            summary: 'dummy',
            target_chars: 5000,
            subheadings: ['sh1', 'sh2'],
          },
          {
            index: 3,
            heading: 'ダミー章 3',
            summary: 'dummy',
            target_chars: 5000,
            subheadings: ['sh1', 'sh2'],
          },
        ],
      },
      select: { id: true },
    });
    outlineIds.push(outline.id);
  }

  return {
    accountId: account.id,
    themeId: theme.id,
    bookIds,
    outlineIds,
  };
}

async function seedForReject(): Promise<SeededRejectContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-reject-${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['remote_work'],
      },
      status: 'archived',
    },
    select: { id: true },
  });

  const theme = await prisma.themeCandidate.create({
    data: {
      account_id: account.id,
      theme_session_id: `${TEST_PEN_PREFIX}-reject-session-${Date.now()}`,
      genre: 'business',
      title: 'T-04-07 差戻しシナリオ用テーマ',
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
      title: 'T-04-07 差戻しテスト書籍',
      status: 'queued',
      prompt_version_ids_json: {},
      model_assignment_snapshot: {},
    },
    select: { id: true },
  });

  const outline = await prisma.outline.create({
    data: {
      book_id: book.id,
      status: 'pending_review',
      chapters_json: [
        {
          index: 1,
          heading: 'ダミー章',
          summary: 'dummy',
          target_chars: 5000,
          subheadings: ['sh1', 'sh2'],
        },
      ],
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    themeId: theme.id,
    bookId: book.id,
    outlineId: outline.id,
  };
}

test.describe('runtime: bulk(Approve|Reject)Outlines core against real Postgres (T-04-07)', () => {
  // 実 DB I/O のみ (mock enqueueJob, LLM 不使用) — 60s で十分
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTestRows();
  });

  test.afterAll(async () => {
    await cleanupTestRows();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. happy path: pending_review 2 件 → approved + Book.status='running'
  //                + dispatch Job × 2 INSERT + audit_log × 1 + enqueueJob × 2
  // -------------------------------------------------------------------------
  test('bulkApproveOutlinesCore: pending_review 2 件 → approved/Book running/Job INSERT/enqueue', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedForApprove(2);

    // mock enqueueJob: graphile_worker キューには書かず呼出ログだけ取る
    const enqueueCalls: Array<{ taskName: string; payload: unknown }> = [];
    let enqueueCounter = 0;
    const enqueueJobMock = async (taskName: string, payload: unknown): Promise<string> => {
      enqueueCounter += 1;
      enqueueCalls.push({ taskName, payload });
      return `mock-graphile-job-${enqueueCounter}`;
    };

    const deps: OutlinesDeps = {
      outlineRepo: prisma.outline,
      bookRepo: prisma.book,
      jobRepo: prisma.job,
      auditLogRepo: prisma.auditLog,
      runTransaction: realRunTransaction,
      session: { user: { id: userId, username: 'e2e-runtime' } },
      enqueueJob: enqueueJobMock,
    };

    const result = await bulkApproveOutlinesCore(
      { outline_ids: seeded.outlineIds },
      deps,
    );

    // --- 結果 ----------------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // 型ガード後に補助的に詳細を出す (assertion 失敗時の調査用)
      // eslint-disable-next-line no-console
      console.error('[T-04-07 approve] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }
    expect(result.data.approved).toBe(2);
    expect(result.data.enqueued_outline_ids.sort()).toEqual(
      [...seeded.outlineIds].sort(),
    );
    expect(result.data.failed_items).toEqual([]);

    // --- Outline: 各行 status='approved' + approved_at 設定 ------------------
    const outlines = await prisma.outline.findMany({
      where: { id: { in: seeded.outlineIds } },
    });
    expect(outlines).toHaveLength(2);
    for (const o of outlines) {
      expect(o.status).toBe('approved');
      expect(o.approved_at).not.toBeNull();
      expect(o.reject_note).toBeNull();
    }

    // --- Book: 各行 status='running' ----------------------------------------
    const books = await prisma.book.findMany({
      where: { id: { in: seeded.bookIds } },
    });
    expect(books).toHaveLength(2);
    for (const b of books) {
      expect(b.status).toBe('running');
    }

    // --- Job INSERT × 2 (kind='pipeline.book.writer.chapters.dispatch') ------
    const jobs = await prisma.job.findMany({
      where: {
        book_id: { in: seeded.bookIds },
        kind: PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
      },
    });
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j.kind).toBe(PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME);
      expect(j.status).toBe('queued');
      expect(seeded.bookIds).toContain(j.book_id);
      const payload = j.payload_json as Record<string, unknown>;
      expect(payload.book_id).toBe(j.book_id);
      expect(typeof payload.outline_id).toBe('string');
      expect(seeded.outlineIds).toContain(payload.outline_id);
    }

    // --- enqueueJob mock: 2 回呼出、payload に book_id / outline_id / job_id --
    expect(enqueueCalls).toHaveLength(2);
    for (const c of enqueueCalls) {
      expect(c.taskName).toBe(PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME);
      const p = c.payload as Record<string, unknown>;
      expect(seeded.bookIds).toContain(p.book_id);
      expect(seeded.outlineIds).toContain(p.outline_id);
      expect(typeof p.job_id).toBe('string');
      // job_id は実 prisma.job.id (cuid) — Job INSERT で確定したものと一致
      const matched = jobs.find((j) => j.id === p.job_id);
      expect(matched).toBeDefined();
    }

    // --- audit_log: 1 件 (action='outlines.bulk_approve', target_kind='outline',
    //     target_id='bulk') -------------------------------------------------
    // 本テスト実行で書かれた audit 行を特定するため、after_json.outline_ids が
    // seeded.outlineIds と一致するものだけを抽出 (シードした actor は実 user で
    // 他テストと共有のため actor_id 単独では絞れない)。
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'outlines.bulk_approve',
        target_kind: 'outline',
        target_id: 'bulk',
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    const ours = auditRows.find((r) => {
      const af = r.after_json as { outline_ids?: string[] } | null;
      const ids = af?.outline_ids ?? [];
      return ids.length === seeded.outlineIds.length && ids.every((id) => seeded.outlineIds.includes(id));
    });
    expect(ours).toBeDefined();
    insertedAuditIds.push(ours!.id);
    expect(ours!.target_kind).toBe('outline');
    expect(ours!.target_id).toBe('bulk');
    const after = ours!.after_json as {
      approved_count: number;
      jobs: Array<{ outline_id: string; book_id: string; job_id: string; kind: string }>;
    };
    expect(after.approved_count).toBe(2);
    expect(after.jobs).toHaveLength(2);
    for (const j of after.jobs) {
      expect(j.kind).toBe(PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME);
      expect(seeded.outlineIds).toContain(j.outline_id);
      expect(seeded.bookIds).toContain(j.book_id);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-07 approve] approved=${result.data.approved} jobs_inserted=${jobs.length} ` +
        `enqueue_calls=${enqueueCalls.length} audit=1`,
    );
  });

  // -------------------------------------------------------------------------
  // 2. happy path: pending_review 1 件 → rejected + reject_note 反映
  //                + writer.outline Job 再 INSERT (payload に reject_note) + audit
  // -------------------------------------------------------------------------
  test('bulkRejectOutlinesCore: pending_review 1 件 → rejected/reject_note/Job INSERT/enqueue', async () => {
    const userId = await resolveRealUserId();
    const seeded = await seedForReject();

    const enqueueCalls: Array<{ taskName: string; payload: unknown }> = [];
    let enqueueCounter = 0;
    const enqueueJobMock = async (taskName: string, payload: unknown): Promise<string> => {
      enqueueCounter += 1;
      enqueueCalls.push({ taskName, payload });
      return `mock-graphile-job-reject-${enqueueCounter}`;
    };

    const deps: OutlinesDeps = {
      outlineRepo: prisma.outline,
      bookRepo: prisma.book,
      jobRepo: prisma.job,
      auditLogRepo: prisma.auditLog,
      runTransaction: realRunTransaction,
      session: { user: { id: userId, username: 'e2e-runtime' } },
      enqueueJob: enqueueJobMock,
    };

    const REJECT_NOTE = '章数を 9 に増やし、第 3 章は副業の確定申告に絞ってください';

    const result = await bulkRejectOutlinesCore(
      {
        items: [{ outline_id: seeded.outlineId, reject_note: REJECT_NOTE }],
      },
      deps,
    );

    // --- 結果 ----------------------------------------------------------------
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      // eslint-disable-next-line no-console
      console.error('[T-04-07 reject] unexpected fail:', JSON.stringify(result));
      throw new Error('expected ok result');
    }
    expect(result.data.rejected).toBe(1);
    expect(result.data.enqueued_outline_ids).toEqual([seeded.outlineId]);
    expect(result.data.failed_items).toEqual([]);

    // --- Outline: status='rejected' + reject_note 反映 + approved_at 未設定 --
    const outline = await prisma.outline.findUnique({
      where: { id: seeded.outlineId },
    });
    expect(outline).not.toBeNull();
    expect(outline!.status).toBe('rejected');
    expect(outline!.reject_note).toBe(REJECT_NOTE);
    expect(outline!.approved_at).toBeNull();

    // --- Book: 差戻しでは status 触らない (Outline rejected のままパイプライン再走) --
    const book = await prisma.book.findUnique({ where: { id: seeded.bookId } });
    expect(book).not.toBeNull();
    expect(book!.status).toBe('queued'); // seed 時の初期値のまま

    // --- Job INSERT × 1 (kind='pipeline.book.writer.outline', payload.reject_note 一致) ---
    const jobs = await prisma.job.findMany({
      where: {
        book_id: seeded.bookId,
        kind: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
      },
    });
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.kind).toBe(PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME);
    expect(job.status).toBe('queued');
    expect(job.book_id).toBe(seeded.bookId);
    const payload = job.payload_json as Record<string, unknown>;
    expect(payload.book_id).toBe(seeded.bookId);
    expect(payload.reject_note).toBe(REJECT_NOTE);

    // --- enqueueJob mock: 1 回呼出、payload.reject_note 一致 + job_id 整合 ----
    expect(enqueueCalls).toHaveLength(1);
    const c = enqueueCalls[0]!;
    expect(c.taskName).toBe(PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME);
    const ep = c.payload as Record<string, unknown>;
    expect(ep.book_id).toBe(seeded.bookId);
    expect(ep.reject_note).toBe(REJECT_NOTE);
    expect(ep.job_id).toBe(job.id);

    // --- audit_log: 1 件 (action='outlines.bulk_reject') --------------------
    // 本テスト実行で書かれた audit 行を after_json.outline_ids でフィルタ
    const auditRows = await prisma.auditLog.findMany({
      where: {
        actor_id: userId,
        action: 'outlines.bulk_reject',
        target_kind: 'outline',
        target_id: 'bulk',
      },
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    const ours = auditRows.find((r) => {
      const af = r.after_json as { outline_ids?: string[] } | null;
      const ids = af?.outline_ids ?? [];
      return ids.length === 1 && ids[0] === seeded.outlineId;
    });
    expect(ours).toBeDefined();
    insertedAuditIds.push(ours!.id);
    expect(ours!.target_kind).toBe('outline');
    expect(ours!.target_id).toBe('bulk');
    const after = ours!.after_json as {
      rejected_count: number;
      jobs: Array<{ outline_id: string; book_id: string; job_id: string; reject_note_length: number }>;
    };
    expect(after.rejected_count).toBe(1);
    expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0]!.outline_id).toBe(seeded.outlineId);
    expect(after.jobs[0]!.book_id).toBe(seeded.bookId);
    expect(after.jobs[0]!.reject_note_length).toBe(REJECT_NOTE.length);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-07 reject] rejected=${result.data.rejected} job_inserted=${jobs.length} ` +
        `enqueue_calls=${enqueueCalls.length} audit=1 reject_note_len=${REJECT_NOTE.length}`,
    );
  });
});
