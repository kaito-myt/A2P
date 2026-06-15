/**
 * jobs-core.ts のユニットテスト (T-04-11, T-07-07, T-09-01, F-016/F-046).
 *
 * 検証:
 *  1. Editor 失敗 → retry(auto) で Editor だけ再走 (Writer 出力を再利用)
 *  2. Chapter 一部完了 → retry(auto) で未完了章のみ再 enqueue
 *  3. retry(this_step) で指定ステップだけ再実行
 *  4. 入力 zod 検証
 *  5. Job not found / not failed / no book_id エラー
 *  6. Job.retries++ と audit_log 記録
 *  7. resumePausedBook: continue → Job enqueue + Book.status 復帰
 *  8. resumePausedBook: cancel → Book.status='cancelled' + BookLock 解放
 *  9. resumePausedBook: paused でない書籍は拒否
 * 10. resumePausedBook: audit_log 記録確認
 * 11. bulkRetryJobs: failed のみリトライ、running/done/cancelled はスキップ
 * 12. bulkRetryJobs: audit_log バッチ記録
 * 13. bulkRetryJobs: 入力検証
 */
import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  retryJobCore,
  bulkRetryJobsCore,
  resumePausedBookCore,
  cancelJobCore,
  type JobsDeps,
  type JobRow,
  type ChapterRow,
  type OutlineRow,
  type ResumePausedBookDeps,
  type BookRowForResume,
  type JobRowForResume,
  type CancelJobDeps,
} from '../../lib/jobs-core';
import { messages } from '../../lib/messages';

const FROZEN_NOW = new Date('2026-05-25T10:00:00.000Z');

function makeJobRow(
  overrides: Partial<JobRow> & { id: string; kind: string },
): JobRow {
  return {
    book_id: 'book_1',
    status: 'failed',
    retries: 0,
    payload_json: { book_id: 'book_1' },
    ...overrides,
  };
}

function makeDeps(opts: {
  jobs?: JobRow[];
  chapters?: ChapterRow[];
  outline?: OutlineRow | null;
  enqueueImpl?: (taskName: string, payload: unknown) => Promise<string>;
}): {
  deps: JobsDeps;
  spies: {
    jobFindUnique: ReturnType<typeof vi.fn>;
    jobFindMany: ReturnType<typeof vi.fn>;
    jobUpdate: ReturnType<typeof vi.fn>;
    jobCreate: ReturnType<typeof vi.fn>;
    chapterFindMany: ReturnType<typeof vi.fn>;
    outlineFindUnique: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };
  jobsStore: JobRow[];
} {
  const jobsStore: JobRow[] = (opts.jobs ?? []).map((j) => ({ ...j }));
  const chaptersStore: ChapterRow[] = (opts.chapters ?? []).map((c) => ({ ...c }));
  const outlineStore: OutlineRow | null = opts.outline ?? null;

  const jobFindUnique = vi.fn(
    async (args: { where: { id: string } }) => {
      return jobsStore.find((j) => j.id === args.where.id) ?? null;
    },
  );

  const jobFindMany = vi.fn(
    async (args: { where: { book_id: string } }) => {
      return jobsStore.filter((j) => j.book_id === args.where.book_id);
    },
  );

  const jobUpdate = vi.fn(
    async (args: { where: { id: string }; data: { retries?: number; status?: string } }) => {
      const j = jobsStore.find((r) => r.id === args.where.id);
      if (!j) throw new Error(`job not found: ${args.where.id}`);
      if (args.data.retries !== undefined) j.retries = args.data.retries;
      if (args.data.status !== undefined) j.status = args.data.status;
      return { id: j.id };
    },
  );

  let jobIdCounter = 0;
  const jobCreate = vi.fn(
    async (args: { data: { kind: string; book_id: string; status: string; payload_json: unknown } }) => {
      jobIdCounter += 1;
      const id = `new_job_${jobIdCounter}`;
      jobsStore.push({
        id,
        kind: args.data.kind,
        book_id: args.data.book_id ?? null,
        status: args.data.status,
        retries: 0,
        payload_json: args.data.payload_json,
      });
      return { id };
    },
  );

  const chapterFindMany = vi.fn(
    async (args: { where: { book_id: string } }) => {
      return chaptersStore.filter((c) => true);
    },
  );

  const outlineFindUnique = vi.fn(
    async () => outlineStore,
  );

  const auditCreate = vi.fn(async () => ({}));
  const enqueue = vi.fn(opts.enqueueImpl ?? (async () => 'graphile_job_999'));

  return {
    deps: {
      jobRepo: {
        findUnique: jobFindUnique,
        findMany: jobFindMany,
        update: jobUpdate,
        create: jobCreate,
      } as unknown as JobsDeps['jobRepo'],
      chapterRepo: {
        findMany: chapterFindMany,
      } as unknown as JobsDeps['chapterRepo'],
      outlineRepo: {
        findUnique: outlineFindUnique,
      } as unknown as JobsDeps['outlineRepo'],
      auditLogRepo: {
        create: auditCreate,
      } as unknown as JobsDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
      enqueueJob: enqueue,
      now: () => FROZEN_NOW,
    },
    spies: {
      jobFindUnique,
      jobFindMany,
      jobUpdate,
      jobCreate,
      chapterFindMany,
      outlineFindUnique,
      auditCreate,
      enqueue,
    },
    jobsStore,
  };
}

// ---------------------------------------------------------------------------
// 入力検証
// ---------------------------------------------------------------------------

describe('retryJobCore — input validation', () => {
  it('job_id 空文字で validation', async () => {
    const { deps } = makeDeps({});
    const r = await retryJobCore({ job_id: '', from_step: 'auto' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('from_step 空文字で validation', async () => {
    const { deps } = makeDeps({});
    // from_step は z.string().min(1) なので空文字は validation エラー
    const r = await retryJobCore({ job_id: 'j1', from_step: '' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('from_step に未登録タスク名 → validation (whitelist 違反)', async () => {
    const { deps } = makeDeps({});
    // PIPELINE_STEP_ORDER に存在しない任意文字列は拒否される
    const r = await retryJobCore({ job_id: 'j1', from_step: 'pipeline.book.nonexistent' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// エラーケース
// ---------------------------------------------------------------------------

describe('retryJobCore — error cases', () => {
  it('存在しないジョブ → not_found', async () => {
    const { deps } = makeDeps({ jobs: [] });
    const r = await retryJobCore({ job_id: 'missing', from_step: 'auto' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });

  it('failed でないジョブ → validation (notFailed)', async () => {
    const { deps } = makeDeps({
      jobs: [makeJobRow({ id: 'j1', kind: 'pipeline.book.editor', status: 'done' })],
    });
    const r = await retryJobCore({ job_id: 'j1', from_step: 'auto' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('book_id なしジョブ → validation (noBookId)', async () => {
    const { deps } = makeDeps({
      jobs: [makeJobRow({ id: 'j1', kind: 'pipeline.book.editor', book_id: null })],
    });
    const r = await retryJobCore({ job_id: 'j1', from_step: 'auto' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Case 1: Editor 失敗 → retry(auto) で Editor だけ再走
// ---------------------------------------------------------------------------

describe('retryJobCore — Case 1: Editor failed, auto retry re-runs Editor only', () => {
  it('Editor 失敗時、Writer 出力を再利用して Editor だけ再 enqueue', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_kickoff', kind: 'pipeline.book.kickoff', status: 'done' }),
      makeJobRow({ id: 'j_marketer', kind: 'pipeline.book.marketer', status: 'done' }),
      makeJobRow({ id: 'j_outline', kind: 'pipeline.book.writer.outline', status: 'done' }),
      makeJobRow({ id: 'j_dispatch', kind: 'pipeline.book.writer.chapters.dispatch', status: 'done' }),
      makeJobRow({ id: 'j_ch1', kind: 'pipeline.book.writer.chapter', status: 'done', payload_json: { book_id: 'book_1', chapter_index: 0 } }),
      makeJobRow({ id: 'j_ch2', kind: 'pipeline.book.writer.chapter', status: 'done', payload_json: { book_id: 'book_1', chapter_index: 1 } }),
      makeJobRow({ id: 'j_editor', kind: 'pipeline.book.editor', status: 'failed' }),
    ];

    const chapters: ChapterRow[] = [
      { id: 'ch_1', index: 0, status: 'done' },
      { id: 'ch_2', index: 1, status: 'done' },
    ];

    const { deps, spies, jobsStore } = makeDeps({ jobs, chapters });

    const r = await retryJobCore({ job_id: 'j_editor', from_step: 'auto' }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    // Editor だけ再 enqueue されたことを確認
    expect(r.data.retried_step).toBe('pipeline.book.editor');
    expect(r.data.new_job_id).toMatch(/^new_job_/);

    // enqueue は 1 回のみ (Editor)
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    const [taskName, payload] = spies.enqueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(taskName).toBe('pipeline.book.editor');
    expect(payload.book_id).toBe('book_1');
    expect(payload.job_id).toMatch(/^new_job_/);

    // Job INSERT は 1 件 (Editor)
    expect(spies.jobCreate).toHaveBeenCalledTimes(1);
    const createArg = spies.jobCreate.mock.calls[0]![0] as { data: { kind: string } };
    expect(createArg.data.kind).toBe('pipeline.book.editor');

    // retries++ が呼ばれた
    expect(spies.jobUpdate).toHaveBeenCalledTimes(1);
    const updateArg = spies.jobUpdate.mock.calls[0]![0] as { where: { id: string }; data: { retries: number } };
    expect(updateArg.where.id).toBe('j_editor');
    expect(updateArg.data.retries).toBe(1);

    // audit_log
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('job.retry');
    expect(auditArg.data.target_kind).toBe('job');
    expect(auditArg.data.target_id).toBe('j_editor');
    expect(auditArg.data.actor_id).toBe('u_1');
    const before = auditArg.data.before_json as { from_step: string };
    expect(before.from_step).toBe('auto');
    const after = auditArg.data.after_json as { retried_step: string; retries: number };
    expect(after.retried_step).toBe('pipeline.book.editor');
    expect(after.retries).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Case 2: Chapter 一部完了 → retry(auto) で未完了章のみ再 enqueue
// ---------------------------------------------------------------------------

describe('retryJobCore — Case 2: Partial chapter completion, auto retry enqueues only incomplete', () => {
  it('4 章中 2 章完了 → 未完了 2 章のみ再 enqueue', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_kickoff', kind: 'pipeline.book.kickoff', status: 'done' }),
      makeJobRow({ id: 'j_marketer', kind: 'pipeline.book.marketer', status: 'done' }),
      makeJobRow({ id: 'j_outline', kind: 'pipeline.book.writer.outline', status: 'done' }),
      makeJobRow({ id: 'j_dispatch', kind: 'pipeline.book.writer.chapters.dispatch', status: 'done' }),
      makeJobRow({ id: 'j_ch0', kind: 'pipeline.book.writer.chapter', status: 'done', payload_json: { book_id: 'book_1', chapter_index: 0 } }),
      makeJobRow({ id: 'j_ch1', kind: 'pipeline.book.writer.chapter', status: 'done', payload_json: { book_id: 'book_1', chapter_index: 1 } }),
      makeJobRow({ id: 'j_ch2', kind: 'pipeline.book.writer.chapter', status: 'failed', payload_json: { book_id: 'book_1', chapter_index: 2 } }),
      makeJobRow({ id: 'j_ch3', kind: 'pipeline.book.writer.chapter', status: 'failed', payload_json: { book_id: 'book_1', chapter_index: 3 } }),
    ];

    const chapters: ChapterRow[] = [
      { id: 'ch_0', index: 0, status: 'done' },
      { id: 'ch_1', index: 1, status: 'done' },
      { id: 'ch_2', index: 2, status: 'draft' },
      { id: 'ch_3', index: 3, status: 'failed' },
    ];

    const { deps, spies } = makeDeps({ jobs, chapters });

    // Use j_ch2 as the trigger (one of the failed chapter jobs)
    const r = await retryJobCore({ job_id: 'j_ch2', from_step: 'auto' }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    // Retried step is writer.chapter
    expect(r.data.retried_step).toBe('pipeline.book.writer.chapter');

    // enqueue は未完了 2 章分のみ
    expect(spies.enqueue).toHaveBeenCalledTimes(2);

    const enqueuedIndexes = (spies.enqueue.mock.calls as Array<[string, Record<string, unknown>]>).map(
      (call) => (call[1] as { chapter_index: number }).chapter_index,
    );
    expect(enqueuedIndexes.sort()).toEqual([2, 3]);

    // Job INSERT は 2 件 (未完了 2 章)
    expect(spies.jobCreate).toHaveBeenCalledTimes(2);

    // additional_job_ids に 2 番目の job_id が入る
    expect(r.data.additional_job_ids).toHaveLength(1);

    // audit_log
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
  });

  it('全章完了 + chapter job failed → Editor を enqueue (fallback)', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_ch0', kind: 'pipeline.book.writer.chapter', status: 'done' }),
      makeJobRow({ id: 'j_ch1', kind: 'pipeline.book.writer.chapter', status: 'failed' }),
    ];

    const chapters: ChapterRow[] = [
      { id: 'ch_0', index: 0, status: 'done' },
      { id: 'ch_1', index: 1, status: 'done' },
    ];

    const { deps, spies } = makeDeps({ jobs, chapters });

    const r = await retryJobCore({ job_id: 'j_ch1', from_step: 'auto' }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    // All chapters done, so editor is enqueued
    expect(r.data.retried_step).toBe('pipeline.book.editor');
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    const [taskName] = spies.enqueue.mock.calls[0] as [string, unknown];
    expect(taskName).toBe('pipeline.book.editor');
  });
});

// ---------------------------------------------------------------------------
// Case 3: retry(this_step) で指定ステップだけ再実行
// ---------------------------------------------------------------------------

describe('retryJobCore — Case 3: this_step retries exact step', () => {
  it('Editor failed → retry(this_step) で Editor だけ再 enqueue', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_editor', kind: 'pipeline.book.editor', status: 'failed', payload_json: { book_id: 'book_1' } }),
    ];

    const { deps, spies } = makeDeps({ jobs });

    const r = await retryJobCore({ job_id: 'j_editor', from_step: 'this_step' }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.data.retried_step).toBe('pipeline.book.editor');
    expect(r.data.new_job_id).toMatch(/^new_job_/);

    // enqueue は 1 回
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    const [taskName, payload] = spies.enqueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(taskName).toBe('pipeline.book.editor');
    expect(payload.book_id).toBe('book_1');
    expect(payload.job_id).toMatch(/^new_job_/);

    // audit_log
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    const before = auditArg.data.before_json as { from_step: string };
    expect(before.from_step).toBe('this_step');
  });

  it('Marketer failed → retry(this_step) で Marketer だけ再 enqueue', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_marketer', kind: 'pipeline.book.marketer', status: 'failed', payload_json: { book_id: 'book_1' } }),
    ];

    const { deps, spies } = makeDeps({ jobs });

    const r = await retryJobCore({ job_id: 'j_marketer', from_step: 'this_step' }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.data.retried_step).toBe('pipeline.book.marketer');
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    const [taskName] = spies.enqueue.mock.calls[0] as [string, unknown];
    expect(taskName).toBe('pipeline.book.marketer');
  });
});

// ---------------------------------------------------------------------------
// retries++ と audit_log 検証
// ---------------------------------------------------------------------------

describe('retryJobCore — retries++ and audit_log', () => {
  it('retries が 2 → 3 にインクリメントされる', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j1', kind: 'pipeline.book.editor', status: 'failed', retries: 2 }),
    ];

    const { deps, spies } = makeDeps({ jobs });

    const r = await retryJobCore({ job_id: 'j1', from_step: 'this_step' }, deps);
    expect(isOk(r)).toBe(true);

    // jobUpdate で retries=3
    expect(spies.jobUpdate).toHaveBeenCalledTimes(1);
    const updateArg = spies.jobUpdate.mock.calls[0]![0] as { data: { retries: number } };
    expect(updateArg.data.retries).toBe(3);

    // audit_log の after_json.retries = 3
    const auditArg = spies.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    const after = auditArg.data.after_json as { retries: number };
    expect(after.retries).toBe(3);
  });

  it('audit_log に actor_id / action / target_kind / target_id が正しく記録', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j1', kind: 'pipeline.book.marketer', status: 'failed' }),
    ];

    const { deps, spies } = makeDeps({ jobs });

    await retryJobCore({ job_id: 'j1', from_step: 'auto' }, deps);

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const arg = spies.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.actor_id).toBe('u_1');
    expect(arg.data.action).toBe('job.retry');
    expect(arg.data.target_kind).toBe('job');
    expect(arg.data.target_id).toBe('j1');
  });
});

// ---------------------------------------------------------------------------
// enqueue 失敗
// ---------------------------------------------------------------------------

describe('retryJobCore — enqueue failure', () => {
  it('enqueue 失敗で enqueueFailed エラーを返す', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j1', kind: 'pipeline.book.editor', status: 'failed' }),
    ];

    const { deps } = makeDeps({
      jobs,
      enqueueImpl: async () => {
        throw new Error('graphile-worker down');
      },
    });

    const r = await retryJobCore({ job_id: 'j1', from_step: 'this_step' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// ===========================================================================
// resumePausedBookCore (T-07-07, F-034/F-046)
// ===========================================================================

function makeJobRowForResume(
  overrides: Partial<JobRowForResume> & { id: string; kind: string },
): JobRowForResume {
  return {
    book_id: 'book_1',
    status: 'cancelled',
    payload_json: { book_id: 'book_1' },
    ...overrides,
  };
}

function makeResumeDeps(opts: {
  book?: BookRowForResume | null;
  jobs?: JobRowForResume[];
  enqueueImpl?: (taskName: string, payload: unknown) => Promise<string>;
}): {
  deps: ResumePausedBookDeps;
  spies: {
    bookFindUnique: ReturnType<typeof vi.fn>;
    bookUpdate: ReturnType<typeof vi.fn>;
    jobFindMany: ReturnType<typeof vi.fn>;
    jobCreate: ReturnType<typeof vi.fn>;
    bookLockDeleteMany: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };
} {
  const bookStore: BookRowForResume | null = opts.book ?? null;
  const jobsStore: JobRowForResume[] = (opts.jobs ?? []).map((j) => ({ ...j }));

  const bookFindUnique = vi.fn(async () => bookStore);
  const bookUpdate = vi.fn(async (args: { where: { id: string }; data: { status?: string; cost_status?: string } }) => {
    if (bookStore) {
      if (args.data.status !== undefined) bookStore.status = args.data.status;
      if (args.data.cost_status !== undefined) bookStore.cost_status = args.data.cost_status;
    }
    return { id: args.where.id };
  });

  const jobFindMany = vi.fn(async (args: { where: { book_id: string; kind?: { startsWith: string }; status?: string | { in: string[] } } }) => {
    return jobsStore.filter((j) => {
      if (j.book_id !== args.where.book_id) return false;
      if (args.where.kind && 'startsWith' in args.where.kind) {
        if (!j.kind.startsWith(args.where.kind.startsWith)) return false;
      }
      if (args.where.status && typeof args.where.status === 'string') {
        if (j.status !== args.where.status) return false;
      }
      return true;
    });
  });

  let jobIdCounter = 0;
  const jobCreate = vi.fn(async (args: { data: { kind: string; book_id: string; status: string; payload_json: unknown } }) => {
    jobIdCounter += 1;
    return { id: `resume_job_${jobIdCounter}` };
  });

  const bookLockDeleteMany = vi.fn(async () => ({ count: 1 }));
  const auditCreate = vi.fn(async () => ({}));
  const enqueue = vi.fn(opts.enqueueImpl ?? (async () => 'graphile_job_999'));

  return {
    deps: {
      bookRepo: {
        findUnique: bookFindUnique,
        update: bookUpdate,
      } as unknown as ResumePausedBookDeps['bookRepo'],
      jobRepo: {
        findMany: jobFindMany,
        create: jobCreate,
      } as unknown as ResumePausedBookDeps['jobRepo'],
      bookLockRepo: {
        deleteMany: bookLockDeleteMany,
      } as unknown as ResumePausedBookDeps['bookLockRepo'],
      auditLogRepo: {
        create: auditCreate,
      } as unknown as ResumePausedBookDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
      enqueueJob: enqueue,
    },
    spies: {
      bookFindUnique,
      bookUpdate,
      jobFindMany,
      jobCreate,
      bookLockDeleteMany,
      auditCreate,
      enqueue,
    },
  };
}

// ---------------------------------------------------------------------------
// 入力検証
// ---------------------------------------------------------------------------

describe('resumePausedBookCore — input validation', () => {
  it('book_id 空文字で validation', async () => {
    const { deps } = makeResumeDeps({});
    const r = await resumePausedBookCore({ book_id: '', decision: 'continue' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('decision 不正値で validation', async () => {
    const { deps } = makeResumeDeps({});
    const r = await resumePausedBookCore({ book_id: 'b1', decision: 'invalid' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// paused でない書籍は拒否
// ---------------------------------------------------------------------------

describe('resumePausedBookCore — not paused rejection', () => {
  it('status が running の書籍は拒否', async () => {
    const book: BookRowForResume = { id: 'book_1', status: 'running', cost_status: 'normal' };
    const { deps } = makeResumeDeps({ book });
    const r = await resumePausedBookCore({ book_id: 'book_1', decision: 'continue' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('存在しない書籍は not_found', async () => {
    const { deps } = makeResumeDeps({ book: null });
    const r = await resumePausedBookCore({ book_id: 'missing', decision: 'continue' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// continue: Job enqueue + Book.status 復帰
// ---------------------------------------------------------------------------

describe('resumePausedBookCore — continue', () => {
  it('editor で cancel された書籍を continue → Book.status=editing + editor enqueue', async () => {
    const book: BookRowForResume = { id: 'book_1', status: 'paused_cost', cost_status: 'paused' };
    const jobs: JobRowForResume[] = [
      makeJobRowForResume({ id: 'j_kickoff', kind: 'pipeline.book.kickoff', status: 'done' }),
      makeJobRowForResume({ id: 'j_marketer', kind: 'pipeline.book.marketer', status: 'done' }),
      makeJobRowForResume({ id: 'j_editor', kind: 'pipeline.book.editor', status: 'cancelled' }),
    ];

    const { deps, spies } = makeResumeDeps({ book, jobs });

    const r = await resumePausedBookCore({ book_id: 'book_1', decision: 'continue' }, deps);

    expect(isOk(r)).toBe(true);

    // Book updated
    expect(spies.bookUpdate).toHaveBeenCalledTimes(1);
    const bookUpdateArg = spies.bookUpdate.mock.calls[0]![0] as { data: { status: string; cost_status: string } };
    expect(bookUpdateArg.data.status).toBe('editing');
    expect(bookUpdateArg.data.cost_status).toBe('normal');

    // Job created + enqueued
    expect(spies.jobCreate).toHaveBeenCalledTimes(1);
    const jobCreateArg = spies.jobCreate.mock.calls[0]![0] as { data: { kind: string } };
    expect(jobCreateArg.data.kind).toBe('pipeline.book.editor');

    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    const [taskName, payload] = spies.enqueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(taskName).toBe('pipeline.book.editor');
    expect(payload.book_id).toBe('book_1');
    expect(payload.job_id).toBe('resume_job_1');

    // BookLock not touched for continue
    expect(spies.bookLockDeleteMany).not.toHaveBeenCalled();
  });

  it('thumbnail.image で cancel された書籍 → Book.status=thumbnail', async () => {
    const book: BookRowForResume = { id: 'book_1', status: 'paused_cost', cost_status: 'paused' };
    const jobs: JobRowForResume[] = [
      makeJobRowForResume({ id: 'j_thumb', kind: 'pipeline.book.thumbnail.image', status: 'cancelled' }),
      makeJobRowForResume({ id: 'j_editor', kind: 'pipeline.book.editor', status: 'done' }),
    ];

    const { deps, spies } = makeResumeDeps({ book, jobs });

    const r = await resumePausedBookCore({ book_id: 'book_1', decision: 'continue' }, deps);
    expect(isOk(r)).toBe(true);

    const bookUpdateArg = spies.bookUpdate.mock.calls[0]![0] as { data: { status: string } };
    expect(bookUpdateArg.data.status).toBe('thumbnail');

    const [taskName] = spies.enqueue.mock.calls[0] as [string, unknown];
    expect(taskName).toBe('pipeline.book.thumbnail.image');
  });

  it('複数 cancelled ジョブ → 最もパイプライン後段のものを再開', async () => {
    const book: BookRowForResume = { id: 'book_1', status: 'paused_cost', cost_status: 'paused' };
    const jobs: JobRowForResume[] = [
      makeJobRowForResume({ id: 'j_marketer', kind: 'pipeline.book.marketer', status: 'cancelled' }),
      makeJobRowForResume({ id: 'j_editor', kind: 'pipeline.book.editor', status: 'cancelled' }),
      makeJobRowForResume({ id: 'j_ch1', kind: 'pipeline.book.writer.chapter', status: 'cancelled' }),
    ];

    const { deps, spies } = makeResumeDeps({ book, jobs });

    const r = await resumePausedBookCore({ book_id: 'book_1', decision: 'continue' }, deps);
    expect(isOk(r)).toBe(true);

    const [taskName] = spies.enqueue.mock.calls[0] as [string, unknown];
    expect(taskName).toBe('pipeline.book.editor');
  });

  it('cancelled ジョブが 0 件 → validation エラー', async () => {
    const book: BookRowForResume = { id: 'book_1', status: 'paused_cost', cost_status: 'paused' };
    const { deps } = makeResumeDeps({ book, jobs: [] });

    const r = await resumePausedBookCore({ book_id: 'book_1', decision: 'continue' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// cancel: Book.status='cancelled' + BookLock 解放
// ---------------------------------------------------------------------------

describe('resumePausedBookCore — cancel', () => {
  it('cancel → Book.status=cancelled + cost_status=normal + BookLock 解放', async () => {
    const book: BookRowForResume = { id: 'book_1', status: 'paused_cost', cost_status: 'paused' };
    const { deps, spies } = makeResumeDeps({ book });

    const r = await resumePausedBookCore({ book_id: 'book_1', decision: 'cancel' }, deps);

    expect(isOk(r)).toBe(true);

    // Book updated
    expect(spies.bookUpdate).toHaveBeenCalledTimes(1);
    const bookUpdateArg = spies.bookUpdate.mock.calls[0]![0] as { data: { status: string; cost_status: string } };
    expect(bookUpdateArg.data.status).toBe('cancelled');
    expect(bookUpdateArg.data.cost_status).toBe('normal');

    // BookLock released
    expect(spies.bookLockDeleteMany).toHaveBeenCalledTimes(1);
    const lockArg = spies.bookLockDeleteMany.mock.calls[0]![0] as { where: { book_id: string } };
    expect(lockArg.where.book_id).toBe('book_1');

    // No job enqueue for cancel
    expect(spies.enqueue).not.toHaveBeenCalled();
    expect(spies.jobCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// audit_log 記録確認
// ---------------------------------------------------------------------------

describe('resumePausedBookCore — audit_log', () => {
  it('continue: audit_log に book.resume + decision=continue が記録', async () => {
    const book: BookRowForResume = { id: 'book_1', status: 'paused_cost', cost_status: 'paused' };
    const jobs: JobRowForResume[] = [
      makeJobRowForResume({ id: 'j_editor', kind: 'pipeline.book.editor', status: 'cancelled' }),
    ];

    const { deps, spies } = makeResumeDeps({ book, jobs });

    await resumePausedBookCore({ book_id: 'book_1', decision: 'continue' }, deps);

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const arg = spies.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.actor_id).toBe('u_1');
    expect(arg.data.action).toBe('book.resume');
    expect(arg.data.target_kind).toBe('book');
    expect(arg.data.target_id).toBe('book_1');

    const before = arg.data.before_json as { status: string; cost_status: string };
    expect(before.status).toBe('paused_cost');
    expect(before.cost_status).toBe('paused');

    const after = arg.data.after_json as { decision: string; status: string; resumed_step: string; new_job_id: string };
    expect(after.decision).toBe('continue');
    expect(after.status).toBe('editing');
    expect(after.resumed_step).toBe('pipeline.book.editor');
    expect(after.new_job_id).toBe('resume_job_1');
  });

  it('cancel: audit_log に book.resume + decision=cancel が記録', async () => {
    const book: BookRowForResume = { id: 'book_1', status: 'paused_cost', cost_status: 'paused' };
    const { deps, spies } = makeResumeDeps({ book });

    await resumePausedBookCore({ book_id: 'book_1', decision: 'cancel' }, deps);

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const arg = spies.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.action).toBe('book.resume');

    const after = arg.data.after_json as { decision: string; status: string; cost_status: string };
    expect(after.decision).toBe('cancel');
    expect(after.status).toBe('cancelled');
    expect(after.cost_status).toBe('normal');
  });
});

// ===========================================================================
// bulkRetryJobsCore (T-09-01, F-046)
// ===========================================================================

describe('bulkRetryJobsCore — input validation', () => {
  it('job_ids 空配列で validation', async () => {
    const { deps } = makeDeps({});
    const r = await bulkRetryJobsCore({ job_ids: [] }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('job_ids が配列でない → validation', async () => {
    const { deps } = makeDeps({});
    const r = await bulkRetryJobsCore({ job_ids: 'not_an_array' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

describe('bulkRetryJobsCore — failed のみリトライ、running/done/cancelled はスキップ', () => {
  it('failed ジョブはリトライされる', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_editor', kind: 'pipeline.book.editor', status: 'failed' }),
    ];
    const { deps, spies } = makeDeps({ jobs });

    const r = await bulkRetryJobsCore({ job_ids: ['j_editor'] }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.retried_count).toBe(1);
    expect(r.data.skipped).toHaveLength(0);
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
  });

  it('cancelled ジョブはスキップ (skipReasonNotRetriable、enqueue 呼ばれない)', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_marketer', kind: 'pipeline.book.marketer', status: 'cancelled' }),
    ];
    const { deps, spies } = makeDeps({ jobs });

    const r = await bulkRetryJobsCore({ job_ids: ['j_marketer'] }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.retried_count).toBe(0);
    expect(r.data.skipped).toHaveLength(1);
    expect(r.data.skipped[0]!.job_id).toBe('j_marketer');
    expect(r.data.skipped[0]!.reason).toBe(messages.jobs.bulk.skipReasonNotRetriable);
    expect(spies.enqueue).not.toHaveBeenCalled();
  });

  it('running ジョブはスキップ (reason 付き)', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_running', kind: 'pipeline.book.editor', status: 'running' }),
    ];
    const { deps } = makeDeps({ jobs });

    const r = await bulkRetryJobsCore({ job_ids: ['j_running'] }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.retried_count).toBe(0);
    expect(r.data.skipped).toHaveLength(1);
    expect(r.data.skipped[0]!.job_id).toBe('j_running');
    expect(typeof r.data.skipped[0]!.reason).toBe('string');
  });

  it('done ジョブはスキップ (reason 付き)', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_done', kind: 'pipeline.book.export', status: 'done' }),
    ];
    const { deps } = makeDeps({ jobs });

    const r = await bulkRetryJobsCore({ job_ids: ['j_done'] }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.retried_count).toBe(0);
    expect(r.data.skipped).toHaveLength(1);
    expect(r.data.skipped[0]!.job_id).toBe('j_done');
  });

  it('混在: failed=リトライ + running=スキップ + done=スキップ', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_failed', kind: 'pipeline.book.editor', status: 'failed' }),
      makeJobRow({ id: 'j_running', kind: 'pipeline.book.marketer', status: 'running' }),
      makeJobRow({ id: 'j_done', kind: 'pipeline.book.export', status: 'done' }),
    ];
    const { deps, spies } = makeDeps({ jobs });

    const r = await bulkRetryJobsCore(
      { job_ids: ['j_failed', 'j_running', 'j_done'] },
      deps,
    );

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.retried_count).toBe(1);
    expect(r.data.skipped).toHaveLength(2);

    const skippedIds = r.data.skipped.map((s) => s.job_id);
    expect(skippedIds).toContain('j_running');
    expect(skippedIds).toContain('j_done');

    // Only failed job triggers enqueue
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
  });

  it('存在しないジョブはスキップ', async () => {
    const { deps } = makeDeps({ jobs: [] });

    const r = await bulkRetryJobsCore({ job_ids: ['nonexistent'] }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.retried_count).toBe(0);
    expect(r.data.skipped).toHaveLength(1);
    expect(r.data.skipped[0]!.job_id).toBe('nonexistent');
  });
});

describe('bulkRetryJobsCore — audit_log', () => {
  it('1 件以上リトライ成功時に単一バッチ audit_log を記録', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j1', kind: 'pipeline.book.editor', status: 'failed' }),
      makeJobRow({ id: 'j2', kind: 'pipeline.book.marketer', status: 'failed' }),
    ];
    const { deps, spies } = makeDeps({ jobs });

    const r = await bulkRetryJobsCore({ job_ids: ['j1', 'j2'] }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.retried_count).toBe(2);

    // retryJobCore writes 1 audit per job (2 jobs) + 1 bulk audit at end
    // Total: 3 audit calls
    const auditCalls = spies.auditCreate.mock.calls as Array<[{ data: Record<string, unknown> }]>;
    const bulkAudit = auditCalls.find(
      (call) => call[0].data.action === 'job.bulk_retry',
    );
    expect(bulkAudit).toBeDefined();
    expect(bulkAudit![0].data.actor_id).toBe('u_1');
    expect(bulkAudit![0].data.target_kind).toBe('job');

    const afterJson = bulkAudit![0].data.after_json as { retried_count: number };
    expect(afterJson.retried_count).toBe(2);
  });

  it('全件スキップ時は audit_log を書かない', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_running', kind: 'pipeline.book.editor', status: 'running' }),
    ];
    const { deps, spies } = makeDeps({ jobs });

    const r = await bulkRetryJobsCore({ job_ids: ['j_running'] }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.retried_count).toBe(0);

    // No audit for bulk action (retried_count=0)
    const auditCalls = spies.auditCreate.mock.calls as Array<[{ data: Record<string, unknown> }]>;
    const bulkAudit = auditCalls.find(
      (call) => call[0].data.action === 'job.bulk_retry',
    );
    expect(bulkAudit).toBeUndefined();
  });
});

// ===========================================================================
// retryJob from_step: 特定ステップ指定 (T-09-02, F-016)
// ===========================================================================

describe('retryJobCore — from_step as named pipeline kind', () => {
  it('from_step に pipeline kind 文字列を指定 → そのステップを enqueue', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_editor', kind: 'pipeline.book.editor', status: 'failed', payload_json: { book_id: 'book_1' } }),
    ];

    const { deps, spies } = makeDeps({ jobs });

    const r = await retryJobCore(
      { job_id: 'j_editor', from_step: 'pipeline.book.thumbnail.text' },
      deps,
    );

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    // ステップ名が from_step で指定したもの
    expect(r.data.retried_step).toBe('pipeline.book.thumbnail.text');

    // enqueue は 1 回
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    const [taskName, payload] = spies.enqueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(taskName).toBe('pipeline.book.thumbnail.text');
    expect(payload.book_id).toBe('book_1');
    expect(payload.from_step).toBe('pipeline.book.thumbnail.text'); // payload に from_step が付く
    expect(payload.job_id).toMatch(/^new_job_/);

    // audit_log の before_json.from_step
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    const before = auditArg.data.before_json as { from_step: string };
    expect(before.from_step).toBe('pipeline.book.thumbnail.text');
  });

  it('from_step="auto" は従来通り動作 (backward compat)', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_editor', kind: 'pipeline.book.editor', status: 'failed' }),
    ];
    const { deps, spies } = makeDeps({ jobs });

    const r = await retryJobCore({ job_id: 'j_editor', from_step: 'auto' }, deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.retried_step).toBe('pipeline.book.editor');
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
  });

  it('from_step="this_step" は従来通り動作 (backward compat)', async () => {
    const jobs: JobRow[] = [
      makeJobRow({ id: 'j_marketer', kind: 'pipeline.book.marketer', status: 'failed' }),
    ];
    const { deps, spies } = makeDeps({ jobs });

    const r = await retryJobCore({ job_id: 'j_marketer', from_step: 'this_step' }, deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.retried_step).toBe('pipeline.book.marketer');
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// cancelJobCore (T-09-02, F-016, docs/05 §4.3.14)
// ===========================================================================

function makeCancelDeps(opts: {
  job?: JobRow | null;
  book?: { id: string; status: string } | null;
}): {
  deps: CancelJobDeps;
  spies: {
    jobFindUnique: ReturnType<typeof vi.fn>;
    jobUpdate: ReturnType<typeof vi.fn>;
    bookFindUnique: ReturnType<typeof vi.fn>;
    bookUpdate: ReturnType<typeof vi.fn>;
    bookLockDeleteMany: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
  };
} {
  const jobStore: JobRow | null = opts.job ?? null;
  const bookStore: { id: string; status: string } | null = opts.book ?? null;

  const jobFindUnique = vi.fn(async () => jobStore);
  const jobUpdate = vi.fn(async (args: { where: { id: string }; data: { status?: string; retries?: number } }) => {
    if (jobStore && args.data.status !== undefined) jobStore.status = args.data.status;
    return { id: args.where.id };
  });

  const bookFindUnique = vi.fn(async () => bookStore);
  const bookUpdate = vi.fn(async (args: { where: { id: string }; data: { status?: string } }) => {
    if (bookStore && args.data.status !== undefined) bookStore.status = args.data.status;
    return { id: args.where.id };
  });

  const bookLockDeleteMany = vi.fn(async () => ({ count: 0 }));
  const auditCreate = vi.fn(async () => ({}));

  return {
    deps: {
      jobRepo: {
        findUnique: jobFindUnique,
        findMany: vi.fn(async () => []),
        update: jobUpdate,
        create: vi.fn(async () => ({ id: 'new_job_1' })),
      } as unknown as CancelJobDeps['jobRepo'],
      bookRepo: {
        findUnique: bookFindUnique,
        update: bookUpdate,
      } as unknown as CancelJobDeps['bookRepo'],
      bookLockRepo: {
        deleteMany: bookLockDeleteMany,
      } as unknown as CancelJobDeps['bookLockRepo'],
      auditLogRepo: {
        create: auditCreate,
      } as unknown as CancelJobDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
    },
    spies: {
      jobFindUnique,
      jobUpdate,
      bookFindUnique,
      bookUpdate,
      bookLockDeleteMany,
      auditCreate,
    },
  };
}

describe('cancelJobCore — input validation', () => {
  it('job_id 空文字で validation', async () => {
    const { deps } = makeCancelDeps({});
    const r = await cancelJobCore({ job_id: '' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('job_id なし → validation', async () => {
    const { deps } = makeCancelDeps({});
    const r = await cancelJobCore({}, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

describe('cancelJobCore — not found', () => {
  it('存在しないジョブ → not_found', async () => {
    const { deps } = makeCancelDeps({ job: null });
    const r = await cancelJobCore({ job_id: 'missing' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });
});

describe('cancelJobCore — reject terminal jobs', () => {
  it('status=done のジョブ → validation (alreadyTerminal)', async () => {
    const job = makeJobRow({ id: 'j1', kind: 'pipeline.book.editor', status: 'done' });
    const { deps } = makeCancelDeps({ job });
    const r = await cancelJobCore({ job_id: 'j1' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('status=failed のジョブ → validation (alreadyTerminal)', async () => {
    const job = makeJobRow({ id: 'j1', kind: 'pipeline.book.editor', status: 'failed' });
    const { deps } = makeCancelDeps({ job });
    const r = await cancelJobCore({ job_id: 'j1' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('status=cancelled のジョブ → validation (alreadyTerminal)', async () => {
    const job = makeJobRow({ id: 'j1', kind: 'pipeline.book.editor', status: 'cancelled' });
    const { deps } = makeCancelDeps({ job });
    const r = await cancelJobCore({ job_id: 'j1' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

describe('cancelJobCore — cancel running job (pipeline)', () => {
  it('running pipeline job → Job.status=cancelled + Book.status=cancelled + BookLock 解放', async () => {
    const job = makeJobRow({ id: 'j1', kind: 'pipeline.book.editor', status: 'running', book_id: 'book_1' });
    const book = { id: 'book_1', status: 'editing' };

    const { deps, spies } = makeCancelDeps({ job, book });

    const r = await cancelJobCore({ job_id: 'j1' }, deps);
    expect(isOk(r)).toBe(true);

    // Job cancelled
    expect(spies.jobUpdate).toHaveBeenCalledTimes(1);
    const jobUpdateArg = spies.jobUpdate.mock.calls[0]![0] as { data: { status: string } };
    expect(jobUpdateArg.data.status).toBe('cancelled');

    // Book cancelled
    expect(spies.bookUpdate).toHaveBeenCalledTimes(1);
    const bookUpdateArg = spies.bookUpdate.mock.calls[0]![0] as { data: { status: string } };
    expect(bookUpdateArg.data.status).toBe('cancelled');

    // BookLock released
    expect(spies.bookLockDeleteMany).toHaveBeenCalledTimes(1);
    const lockArg = spies.bookLockDeleteMany.mock.calls[0]![0] as { where: { book_id: string } };
    expect(lockArg.where.book_id).toBe('book_1');

    // audit_log
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(auditArg.data.actor_id).toBe('u_1');
    expect(auditArg.data.action).toBe('job.cancel');
    expect(auditArg.data.target_kind).toBe('job');
    expect(auditArg.data.target_id).toBe('j1');
  });

  it('queued pipeline job も同様にキャンセル可能', async () => {
    const job = makeJobRow({ id: 'j2', kind: 'pipeline.book.marketer', status: 'queued', book_id: 'book_1' });
    const book = { id: 'book_1', status: 'running' };

    const { deps, spies } = makeCancelDeps({ job, book });

    const r = await cancelJobCore({ job_id: 'j2' }, deps);
    expect(isOk(r)).toBe(true);

    const jobUpdateArg = spies.jobUpdate.mock.calls[0]![0] as { data: { status: string } };
    expect(jobUpdateArg.data.status).toBe('cancelled');

    const bookUpdateArg = spies.bookUpdate.mock.calls[0]![0] as { data: { status: string } };
    expect(bookUpdateArg.data.status).toBe('cancelled');
  });
});

describe('cancelJobCore — cancel non-pipeline job (no book update)', () => {
  it('book_id なしジョブ → Job のみ cancelled、Book/BookLock 触らず', async () => {
    const job = makeJobRow({ id: 'j3', kind: 'catalog.fetch', status: 'running', book_id: null });

    const { deps, spies } = makeCancelDeps({ job });

    const r = await cancelJobCore({ job_id: 'j3' }, deps);
    expect(isOk(r)).toBe(true);

    // Job cancelled
    const jobUpdateArg = spies.jobUpdate.mock.calls[0]![0] as { data: { status: string } };
    expect(jobUpdateArg.data.status).toBe('cancelled');

    // Book not touched
    expect(spies.bookUpdate).not.toHaveBeenCalled();
    expect(spies.bookLockDeleteMany).not.toHaveBeenCalled();
  });

  it('kind が pipeline. で始まらないジョブ → Book 更新しない', async () => {
    const job = makeJobRow({ id: 'j4', kind: 'fx.fetch', status: 'running', book_id: 'book_1' });

    const { deps, spies } = makeCancelDeps({ job, book: { id: 'book_1', status: 'running' } });

    const r = await cancelJobCore({ job_id: 'j4' }, deps);
    expect(isOk(r)).toBe(true);

    // Book not touched (not a pipeline kind)
    expect(spies.bookUpdate).not.toHaveBeenCalled();
  });
});

describe('cancelJobCore — audit_log', () => {
  it('audit_log に action=job.cancel が記録される', async () => {
    const job = makeJobRow({ id: 'j5', kind: 'pipeline.book.editor', status: 'running', book_id: 'book_1' });
    const book = { id: 'book_1', status: 'editing' };

    const { deps, spies } = makeCancelDeps({ job, book });

    await cancelJobCore({ job_id: 'j5' }, deps);

    const auditArg = spies.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('job.cancel');
    expect(auditArg.data.target_id).toBe('j5');

    const before = auditArg.data.before_json as { status: string; kind: string };
    expect(before.status).toBe('running');
    expect(before.kind).toBe('pipeline.book.editor');

    const after = auditArg.data.after_json as { status: string; book_cancelled: boolean };
    expect(after.status).toBe('cancelled');
    expect(after.book_cancelled).toBe(true);
  });
});

// Prisma import 警告抑止
void Prisma;
