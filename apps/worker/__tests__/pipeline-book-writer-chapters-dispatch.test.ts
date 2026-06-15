import { describe, expect, it, vi } from 'vitest';

import { A2PError, NotFoundError, ValidationError } from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';

import {
  PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
  PipelineBookWriterChaptersDispatchPayloadSchema,
  runPipelineBookWriterChaptersDispatch,
  type AddJobLike,
  type PipelineBookWriterChaptersDispatchDeps,
  type PipelineBookWriterChaptersDispatchPrisma,
} from '../src/tasks/pipeline-book-writer-chapters-dispatch.js';

// ---------------------------------------------------------------------------
// テスト用ファクトリ
// ---------------------------------------------------------------------------

function makeLogger() {
  const calls: Array<{
    level: 'info' | 'warn' | 'error';
    obj: Record<string, unknown>;
    msg: string;
  }> = [];
  const mk = (level: 'info' | 'warn' | 'error') =>
    (obj: Record<string, unknown>, msg?: string) => {
      calls.push({ level, obj, msg: msg ?? '' });
    };
  const logger = {
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  return { logger, calls };
}

interface JobRecord {
  id: string;
  status: string;
  book_id: string | null;
  kind?: string;
  payload_json?: unknown;
}

interface OutlineRecord {
  id: string;
  book_id: string;
  chapters_json: unknown;
  status: string;
}

interface PrismaCaptures {
  jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobUpdateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  jobCreates: Array<{ data: Record<string, unknown> }>;
  jobFindManyCalls: Array<{ where: Record<string, unknown> }>;
  executeRawCalls: Array<{ sql: string; values: unknown[] }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  bookExists?: boolean;
  outlines: OutlineRecord[];
  /** updateMany が返す count を強制. */
  forceUpdateManyCount?: number;
  /** job.create を強制失敗. */
  jobCreateThrow?: Error;
  /** job.create の delay (並列制御テスト用). */
  jobCreateDelayMs?: number;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineBookWriterChaptersDispatchPrisma;
  captures: PrismaCaptures;
  state: { jobs: JobRecord[]; concurrentJobCreates: { max: number; current: number } };
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    jobCreates: [],
    jobFindManyCalls: [],
    executeRawCalls: [],
  };
  const jobs = [...args.jobs];
  let jobCreateCounter = 0;
  const concurrentJobCreates = { max: 0, current: 0 };

  const prisma: PipelineBookWriterChaptersDispatchPrisma = {
    $executeRawUnsafe: async (sql, ...values) => {
      captures.executeRawCalls.push({ sql, values });
      return 1;
    },
    job: {
      findUnique: async ({ where }) => {
        const j = jobs.find((x) => x.id === where.id);
        return j ? { status: j.status, book_id: j.book_id } : null;
      },
      updateMany: async ({ where, data }) => {
        captures.jobUpdateMany.push({
          where: where as unknown as Record<string, unknown>,
          data: data as unknown as Record<string, unknown>,
        });
        if (args.forceUpdateManyCount !== undefined) {
          return { count: args.forceUpdateManyCount };
        }
        const w = where as { id: string; status: { in: string[] } };
        const j = jobs.find((x) => x.id === w.id);
        if (!j || !w.status.in.includes(j.status)) return { count: 0 };
        j.status = (data as { status: string }).status;
        return { count: 1 };
      },
      update: async ({ where, data }) => {
        captures.jobUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        const j = jobs.find((x) => x.id === where.id);
        if (j && typeof (data as { status?: string }).status === 'string') {
          j.status = (data as { status: string }).status;
        }
        return {};
      },
      findMany: async ({ where }) => {
        captures.jobFindManyCalls.push({
          where: where as unknown as Record<string, unknown>,
        });
        const w = where as {
          book_id: string;
          kind: string;
          status: { in: string[] };
        };
        return jobs
          .filter(
            (j) =>
              j.book_id === w.book_id &&
              (j.kind ?? '') === w.kind &&
              w.status.in.includes(j.status),
          )
          .map((j) => ({ id: j.id, payload_json: j.payload_json ?? null }));
      },
      create: async ({ data }) => {
        if (args.jobCreateThrow) throw args.jobCreateThrow;
        concurrentJobCreates.current += 1;
        if (concurrentJobCreates.current > concurrentJobCreates.max) {
          concurrentJobCreates.max = concurrentJobCreates.current;
        }
        try {
          if (args.jobCreateDelayMs && args.jobCreateDelayMs > 0) {
            await new Promise((r) => setTimeout(r, args.jobCreateDelayMs));
          }
          captures.jobCreates.push({
            data: data as unknown as Record<string, unknown>,
          });
          jobCreateCounter += 1;
          const id = `child_job_${jobCreateCounter}`;
          jobs.push({
            id,
            status: data.status,
            book_id: data.book_id,
            kind: data.kind,
            payload_json: data.payload_json,
          });
          return { id };
        } finally {
          concurrentJobCreates.current -= 1;
        }
      },
    },
    book: {
      findUnique: async () => {
        return args.bookExists !== false ? { id: 'book_1' } : null;
      },
    },
    outline: {
      findUnique: async ({ where }) => {
        const o = args.outlines.find((x) => x.id === where.id);
        return o
          ? { id: o.id, book_id: o.book_id, chapters_json: o.chapters_json, status: o.status }
          : null;
      },
    },
  };
  return { prisma, captures, state: { jobs, concurrentJobCreates } };
}

function makeChaptersJson(n: number): Array<{
  index: number;
  heading: string;
  summary: string;
  target_chars: number;
  subheadings: string[];
}> {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    heading: `第${i + 1}章: タイトル`,
    summary: `第${i + 1}章の要旨です。実例 / 数値 / 実践手順を盛り込んでください。`,
    target_chars: 6000,
    subheadings: [`小見出し${i + 1}-1`, `小見出し${i + 1}-2`],
  }));
}

function makeJobOutline(opts?: {
  jobStatus?: string;
  chapterCount?: number;
  outlineStatus?: string;
}): { job: JobRecord; outline: OutlineRecord } {
  const job: JobRecord = {
    id: 'dispatch_job_1',
    status: opts?.jobStatus ?? 'queued',
    book_id: 'book_1',
    kind: 'pipeline.book.writer.chapters.dispatch',
  };
  const outline: OutlineRecord = {
    id: 'outline_1',
    book_id: 'book_1',
    chapters_json: makeChaptersJson(opts?.chapterCount ?? 9),
    status: opts?.outlineStatus ?? 'approved',
  };
  return { job, outline };
}

function buildDeps(
  prisma: PipelineBookWriterChaptersDispatchPrisma,
  overrides: Partial<PipelineBookWriterChaptersDispatchDeps> = {},
): {
  deps: PipelineBookWriterChaptersDispatchDeps;
  notifyCalls: Array<{ payload: unknown }>;
  loggerCalls: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
} {
  const { logger, calls: loggerCalls } = makeLogger();
  const notifyCalls: Array<{ payload: unknown }> = [];

  const baseDeps: PipelineBookWriterChaptersDispatchDeps = {
    prisma,
    logger,
    chapterConcurrency: 4,
    now: () => new Date('2026-05-25T00:00:00Z'),
    notifyJobChange: (async (payload: unknown) => {
      notifyCalls.push({ payload });
      return { ok: true };
    }) as unknown as PipelineBookWriterChaptersDispatchDeps['notifyJobChange'],
  };
  return {
    deps: { ...baseDeps, ...overrides },
    notifyCalls,
    loggerCalls,
  };
}

function makeAddJob(): {
  addJob: AddJobLike;
  calls: Array<{ identifier: string; payload: unknown; spec?: Record<string, unknown> }>;
} {
  const calls: Array<{
    identifier: string;
    payload: unknown;
    spec?: Record<string, unknown>;
  }> = [];
  const addJob: AddJobLike = async (identifier, payload, spec) => {
    calls.push({ identifier, payload, ...(spec !== undefined ? { spec } : {}) });
    return { id: `child_${calls.length}` };
  };
  return { addJob, calls };
}

// ---------------------------------------------------------------------------
// payload schema
// ---------------------------------------------------------------------------

describe('pipeline.book.writer.chapters.dispatch payload schema', () => {
  it('task identifier', () => {
    expect(PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME).toBe(
      'pipeline.book.writer.chapters.dispatch',
    );
  });

  it('book_id / job_id / outline_id 必須', () => {
    expect(
      PipelineBookWriterChaptersDispatchPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
        outline_id: 'o1',
      }).success,
    ).toBe(true);
    expect(
      PipelineBookWriterChaptersDispatchPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

describe('runPipelineBookWriterChaptersDispatch happy path', () => {
  it('9 章 → 9 個の Job INSERT + 9 個の addJob 呼出 + dispatch Job done', async () => {
    const { job, outline } = makeJobOutline({ chapterCount: 9 });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      outlines: [outline],
    });
    const { deps, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookWriterChaptersDispatch(
      { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
      addJob,
      deps,
    );

    // CAS
    expect(captures.jobUpdateMany).toHaveLength(1);
    expect(captures.jobUpdateMany[0]?.data).toMatchObject({ status: 'running' });

    // 9 個の child Job INSERT
    expect(captures.jobCreates).toHaveLength(9);
    for (const create of captures.jobCreates) {
      expect(create.data).toMatchObject({
        kind: 'pipeline.book.writer.chapter',
        book_id: 'book_1',
        parent_job_id: 'dispatch_job_1',
        status: 'queued',
      });
      const p = create.data.payload_json as { chapter_index: number };
      expect(typeof p.chapter_index).toBe('number');
    }

    // 9 個の addJob 呼出
    expect(addJobCalls).toHaveLength(9);
    for (const c of addJobCalls) {
      expect(c.identifier).toBe('pipeline.book.writer.chapter');
      const p = c.payload as { chapter_index: number; outline_id: string; book_id: string };
      expect(p.outline_id).toBe('outline_1');
      expect(p.book_id).toBe('book_1');
      expect(typeof p.chapter_index).toBe('number');
    }

    // 全 chapter_index が 1..9 で揃っている
    const indices = addJobCalls
      .map((c) => (c.payload as { chapter_index: number }).chapter_index)
      .sort((a, b) => a - b);
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // dispatch Job done
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall?.data).toMatchObject({
      status: 'done',
      result_json: {
        total_chapters: 9,
        enqueued: 9,
        skipped_already_enqueued: 0,
        chapter_concurrency: 4,
      },
    });

    // notify
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.payload).toMatchObject({
      kind: 'pipeline.book.writer.chapters.dispatch',
      phase: 'chapters_dispatched',
      bookId: 'book_1',
      status: 'done',
    });
  });

  it('p-limit(4) で並列制御 — 同時 job.create 数が 4 を超えない', async () => {
    const { job, outline } = makeJobOutline({ chapterCount: 10 });
    const { prisma, state } = buildPrisma({
      jobs: [job],
      outlines: [outline],
      jobCreateDelayMs: 20, // 各 create に 20ms 遅延 → 並列度の窓を作る
    });
    const { deps } = buildDeps(prisma, { chapterConcurrency: 4 });
    const { addJob } = makeAddJob();

    await runPipelineBookWriterChaptersDispatch(
      { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
      addJob,
      deps,
    );

    expect(state.concurrentJobCreates.max).toBeGreaterThan(1); // 並列に走った
    expect(state.concurrentJobCreates.max).toBeLessThanOrEqual(4); // 4 を超えない
  });

  it('chapterConcurrency=1 (直列) なら max 並列数 1', async () => {
    const { job, outline } = makeJobOutline({ chapterCount: 5 });
    const { prisma, state } = buildPrisma({
      jobs: [job],
      outlines: [outline],
      jobCreateDelayMs: 10,
    });
    const { deps } = buildDeps(prisma, { chapterConcurrency: 1 });
    const { addJob } = makeAddJob();

    await runPipelineBookWriterChaptersDispatch(
      { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
      addJob,
      deps,
    );

    expect(state.concurrentJobCreates.max).toBe(1);
  });

  it('再実行で既に enqueue 済 chapter_index はスキップ (冪等性)', async () => {
    const { job, outline } = makeJobOutline({ chapterCount: 9 });
    // 既に 1, 3, 5 章は別 Job として存在 (queued)
    const existing: JobRecord[] = [
      {
        id: 'pre_chapter_1',
        status: 'queued',
        book_id: 'book_1',
        kind: 'pipeline.book.writer.chapter',
        payload_json: { chapter_index: 1 },
      },
      {
        id: 'pre_chapter_3',
        status: 'running',
        book_id: 'book_1',
        kind: 'pipeline.book.writer.chapter',
        payload_json: { chapter_index: 3 },
      },
      {
        id: 'pre_chapter_5',
        status: 'done',
        book_id: 'book_1',
        kind: 'pipeline.book.writer.chapter',
        payload_json: { chapter_index: 5 },
      },
    ];
    const { prisma, captures } = buildPrisma({
      jobs: [job, ...existing],
      outlines: [outline],
    });
    const { deps } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookWriterChaptersDispatch(
      { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
      addJob,
      deps,
    );

    // 6 章のみ新規 enqueue (9 - 3 既存)
    expect(captures.jobCreates).toHaveLength(6);
    expect(addJobCalls).toHaveLength(6);
    const indices = addJobCalls
      .map((c) => (c.payload as { chapter_index: number }).chapter_index)
      .sort((a, b) => a - b);
    expect(indices).toEqual([2, 4, 6, 7, 8, 9]);

    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall?.data).toMatchObject({
      result_json: {
        total_chapters: 9,
        enqueued: 6,
        skipped_already_enqueued: 3,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

describe('runPipelineBookWriterChaptersDispatch idempotency', () => {
  it('Job.status === done なら早期 return', async () => {
    const { job, outline } = makeJobOutline({ jobStatus: 'done' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      outlines: [outline],
    });
    const { deps, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookWriterChaptersDispatch(
      { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
      addJob,
      deps,
    );

    expect(captures.jobUpdateMany).toHaveLength(0);
    expect(captures.jobCreates).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
  });

  it('CAS で count=0 (他 worker が先取り) なら skip', async () => {
    const { job, outline } = makeJobOutline({ jobStatus: 'running' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      outlines: [outline],
      forceUpdateManyCount: 0,
    });
    const { deps } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookWriterChaptersDispatch(
      { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
      addJob,
      deps,
    );

    expect(captures.jobCreates).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

describe('runPipelineBookWriterChaptersDispatch error paths', () => {
  it('payload zod 違反 → ValidationError', async () => {
    const { prisma } = buildPrisma({ jobs: [], outlines: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChaptersDispatch({}, addJob, deps),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runPipelineBookWriterChaptersDispatch({}, addJob, deps),
    ).rejects.toBeInstanceOf(A2PError);
  });

  it('Job 不在 → NotFoundError', async () => {
    const { prisma } = buildPrisma({ jobs: [], outlines: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChaptersDispatch(
        { book_id: 'book_1', job_id: 'missing', outline_id: 'outline_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('Outline 不在 → NotFoundError + Job=failed', async () => {
    const { job } = makeJobOutline();
    const { prisma, captures } = buildPrisma({ jobs: [job], outlines: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChaptersDispatch(
        { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_missing' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Outline.status !== approved → ValidationError', async () => {
    const { job, outline } = makeJobOutline({ outlineStatus: 'pending_review' });
    const { prisma, captures } = buildPrisma({ jobs: [job], outlines: [outline] });
    const { deps } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookWriterChaptersDispatch(
        { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(captures.jobCreates).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Outline.book_id 不一致 → ValidationError', async () => {
    const { job, outline } = makeJobOutline();
    outline.book_id = 'book_other';
    const { prisma, captures } = buildPrisma({ jobs: [job], outlines: [outline] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChaptersDispatch(
        { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Book 不在 → NotFoundError', async () => {
    const { job, outline } = makeJobOutline();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      outlines: [outline],
      bookExists: false,
    });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChaptersDispatch(
        { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('job.create 失敗 → 透過 throw + dispatch Job failed', async () => {
    const { job, outline } = makeJobOutline({ chapterCount: 3 });
    const dbErr = new Error('insert failed');
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      outlines: [outline],
      jobCreateThrow: dbErr,
    });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChaptersDispatch(
        { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(dbErr);

    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Outline.chapters_json が配列でない → ValidationError', async () => {
    const { job } = makeJobOutline();
    const badOutline: OutlineRecord = {
      id: 'outline_1',
      book_id: 'book_1',
      chapters_json: { not: 'an array' },
      status: 'approved',
    };
    const { prisma, captures } = buildPrisma({ jobs: [job], outlines: [badOutline] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChaptersDispatch(
        { book_id: 'book_1', job_id: 'dispatch_job_1', outline_id: 'outline_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });
});
