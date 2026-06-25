import { describe, expect, it, vi } from 'vitest';

import {
  A2PError,
  NotFoundError,
  ValidationError,
} from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { ThumbnailImageOutput } from '@a2p/contracts/agents/thumbnail';

import {
  PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
  PipelineBookThumbnailImagePayloadSchema,
  runPipelineBookThumbnailImage,
  type AddJobLike,
  type PipelineBookThumbnailImageDeps,
  type PipelineBookThumbnailImagePrisma,
} from '../src/tasks/pipeline-book-thumbnail-image.js';

// ---------------------------------------------------------------------------
// テスト用ファクトリ
// ---------------------------------------------------------------------------

function makeLogger() {
  const calls: Array<{
    level: 'info' | 'warn' | 'error';
    obj: Record<string, unknown>;
    msg: string;
  }> = [];
  const mk =
    (level: 'info' | 'warn' | 'error') =>
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
}

interface CoverTextRecord {
  id: string;
  book_id: string;
  title: string;
  subtitle: string | null;
}

interface PrismaCaptures {
  jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobUpdateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  jobCreates: Array<{ data: Record<string, unknown> }>;
  bookUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  executeRawCalls: Array<{ sql: string; values: unknown[] }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  coverTexts: CoverTextRecord[];
  coverCount?: number;
  forceUpdateManyCount?: number;
  executeRawThrow?: Error;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineBookThumbnailImagePrisma;
  captures: PrismaCaptures;
  state: { jobs: JobRecord[] };
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    jobCreates: [],
    bookUpdates: [],
    executeRawCalls: [],
  };
  const jobs = [...args.jobs];
  let jobCreateCounter = 0;
  let currentCoverCount = args.coverCount ?? 0;

  const prisma: PipelineBookThumbnailImagePrisma = {
    $executeRawUnsafe: async (sql, ...values) => {
      captures.executeRawCalls.push({ sql, values });
      if (args.executeRawThrow) throw args.executeRawThrow;
      return 1;
    },
    book: {
      update: async ({ where, data }) => {
        captures.bookUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        return {};
      },
    },
    job: {
      findUnique: async ({ where }) => {
        const j = jobs.find((x) => x.id === where.id);
        return j ? { status: j.status, book_id: j.book_id } : null;
      },
      findFirst: async ({ where }) => {
        const j = jobs.find(
          (x) =>
            x.book_id === where.book_id &&
            x.kind === where.kind &&
            where.status.in.includes(x.status),
        );
        return j ? { id: j.id } : null;
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
      create: async ({ data }) => {
        captures.jobCreates.push({
          data: data as unknown as Record<string, unknown>,
        });
        jobCreateCounter += 1;
        const id = `judge_job_${jobCreateCounter}`;
        jobs.push({
          id,
          status: data.status,
          book_id: data.book_id,
          kind: data.kind,
        });
        return { id };
      },
    },
    coverTextProposal: {
      findUnique: async ({ where }) => {
        const ct = args.coverTexts.find((x) => x.id === where.id);
        return ct
          ? { id: ct.id, book_id: ct.book_id, title: ct.title, subtitle: ct.subtitle }
          : null;
      },
    },
    cover: {
      count: async () => {
        return currentCoverCount;
      },
    },
  };
  return { prisma, captures, state: { jobs } };
}

function makeDefaultFixtures(opts?: { jobStatus?: string }): {
  job: JobRecord;
  coverText: CoverTextRecord;
} {
  const job: JobRecord = {
    id: 'job_img_1',
    status: opts?.jobStatus ?? 'queued',
    book_id: 'book_1',
    kind: 'pipeline.book.thumbnail.image',
  };
  const coverText: CoverTextRecord = {
    id: 'ctp_1',
    book_id: 'book_1',
    title: '表紙案1のタイトル',
    subtitle: 'サブタイトル案1',
  };
  return { job, coverText };
}

function makeImageOutput(coverId = 'cover_001'): ThumbnailImageOutput {
  return {
    r2Key: `books/book_1/covers/raw/${coverId}.jpg`,
    promptUsed: 'test prompt',
    coverId,
  };
}

function buildDeps(
  prisma: PipelineBookThumbnailImagePrisma,
  overrides: Partial<PipelineBookThumbnailImageDeps> = {},
): {
  deps: PipelineBookThumbnailImageDeps;
  generateCalls: Array<unknown>;
  notifyCalls: Array<{ payload: unknown }>;
  loggerCalls: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
} {
  const { logger, calls: loggerCalls } = makeLogger();
  const generateCalls: Array<unknown> = [];
  const notifyCalls: Array<{ payload: unknown }> = [];

  const baseDeps: PipelineBookThumbnailImageDeps = {
    prisma,
    logger,
    now: () => new Date('2026-05-25T00:00:00Z'),
    generateCoverImage: (async (input: unknown) => {
      generateCalls.push(input);
      return makeImageOutput();
    }) as unknown as PipelineBookThumbnailImageDeps['generateCoverImage'],
    notifyJobChange: (async (payload: unknown) => {
      notifyCalls.push({ payload });
      return { ok: true };
    }) as unknown as PipelineBookThumbnailImageDeps['notifyJobChange'],
    expectedCoverCount: 3,
  };
  return {
    deps: { ...baseDeps, ...overrides },
    generateCalls,
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
    return { id: `gw_${calls.length}` };
  };
  return { addJob, calls };
}

// ---------------------------------------------------------------------------
// payload schema
// ---------------------------------------------------------------------------

describe('pipeline.book.thumbnail.image payload schema', () => {
  it('task identifier が docs/05 ss5.3.7 と一致する', () => {
    expect(PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME).toBe('pipeline.book.thumbnail.image');
  });

  it('book_id / cover_text_id / job_id を必須', () => {
    expect(
      PipelineBookThumbnailImagePayloadSchema.safeParse({
        book_id: 'b1',
        cover_text_id: 'ct1',
        job_id: 'j1',
      }).success,
    ).toBe(true);
    expect(
      PipelineBookThumbnailImagePayloadSchema.safeParse({
        book_id: 'b1',
        cover_text_id: 'ct1',
      }).success,
    ).toBe(false);
    expect(
      PipelineBookThumbnailImagePayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
      }).success,
    ).toBe(false);
    expect(
      PipelineBookThumbnailImagePayloadSchema.safeParse({
        cover_text_id: 'ct1',
        job_id: 'j1',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// happy path: not last (1 of 3 covers)
// ---------------------------------------------------------------------------

describe('runPipelineBookThumbnailImage happy path (not last)', () => {
  it('generateCoverImage 呼出 + Job done + no export enqueue', async () => {
    const { job, coverText } = makeDefaultFixtures();
    // coverCount=1: after this image, only 1 cover exists (not all 3)
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      coverTexts: [coverText],
      coverCount: 1,
    });
    const { deps, generateCalls, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookThumbnailImage(
      { book_id: 'book_1', cover_text_id: 'ctp_1', job_id: 'job_img_1' },
      addJob,
      deps,
    );

    // CAS
    expect(captures.jobUpdateMany).toHaveLength(1);
    expect(captures.jobUpdateMany[0]?.data).toMatchObject({ status: 'running' });

    // generateCoverImage 呼出
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]).toMatchObject({
      jobId: 'job_img_1',
      bookId: 'book_1',
      coverTextId: 'ctp_1',
      title: '表紙案1のタイトル',
      subtitle: 'サブタイトル案1',
    });

    // export NOT enqueued (only 1 of 3 covers done)
    expect(captures.jobCreates).toHaveLength(0);
    // cost check enqueue only (F-034 / T-07-02)
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[0]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    // Job done
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.data).toMatchObject({
      status: 'done',
      result_json: {
        cover_id: 'cover_001',
        all_complete: false,
        cover_count: 1,
        judge_job_id: null,
      },
    });

    // notify without phase
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.payload).toMatchObject({
      jobId: 'job_img_1',
      status: 'done',
      kind: 'pipeline.book.thumbnail.image',
      bookId: 'book_1',
    });
    expect((notifyCalls[0]?.payload as Record<string, unknown>).phase).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// happy path: last cover -> judge enqueue
// ---------------------------------------------------------------------------

describe('runPipelineBookThumbnailImage happy path (last cover, triggers judge)', () => {
  it('全候補完了で pipeline.book.judge enqueue + Book.status=judging + phase=thumbnail_images_complete', async () => {
    const { job, coverText } = makeDefaultFixtures();
    // coverCount=3: after this image, all 3 covers exist
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      coverTexts: [coverText],
      coverCount: 3,
    });
    const { deps, generateCalls, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookThumbnailImage(
      { book_id: 'book_1', cover_text_id: 'ctp_1', job_id: 'job_img_1' },
      addJob,
      deps,
    );

    // generateCoverImage 呼出
    expect(generateCalls).toHaveLength(1);

    // judge enqueue
    expect(captures.jobCreates).toHaveLength(1);
    expect(captures.jobCreates[0]?.data).toMatchObject({
      kind: 'pipeline.book.judge',
      book_id: 'book_1',
      parent_job_id: 'job_img_1',
      status: 'queued',
      payload_json: { book_id: 'book_1', retry_count: 0 },
    });
    expect(addJobCalls).toHaveLength(2);
    expect(addJobCalls[0]).toMatchObject({
      identifier: 'pipeline.book.judge',
      payload: { book_id: 'book_1', job_id: 'judge_job_1', retry_count: 0 },
      spec: { maxAttempts: 2 },
    });
    // cost check enqueue (F-034 / T-07-02)
    expect(addJobCalls[1]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[1]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    // Book.status='judging'
    expect(captures.bookUpdates).toHaveLength(1);
    expect(captures.bookUpdates[0]).toMatchObject({
      where: { id: 'book_1' },
      data: { status: 'judging' },
    });

    // Job done with all_complete=true
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall?.data).toMatchObject({
      result_json: {
        all_complete: true,
        cover_count: 3,
        judge_job_id: 'judge_job_1',
      },
    });

    // notify with phase
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.payload).toMatchObject({
      phase: 'thumbnail_images_complete',
    });
  });

  it('judge Job が既に存在すれば二重 enqueue しない', async () => {
    const { job, coverText } = makeDefaultFixtures();
    const existingJudgeJob: JobRecord = {
      id: 'judge_existing',
      status: 'queued',
      book_id: 'book_1',
      kind: 'pipeline.book.judge',
    };
    const { prisma, captures } = buildPrisma({
      jobs: [job, existingJudgeJob],
      coverTexts: [coverText],
      coverCount: 3,
    });
    const { deps } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookThumbnailImage(
      { book_id: 'book_1', cover_text_id: 'ctp_1', job_id: 'job_img_1' },
      addJob,
      deps,
    );

    // no new judge job created
    expect(captures.jobCreates).toHaveLength(0);
    // no book update (judge already enqueued)
    expect(captures.bookUpdates).toHaveLength(0);
    // cost check enqueue only (F-034 / T-07-02), judge skipped
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[0]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    // Job done with all_complete=true, judge_job_id=null (skipped)
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall?.data).toMatchObject({
      result_json: {
        all_complete: true,
        judge_job_id: null,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// CoverTextProposal with no subtitle
// ---------------------------------------------------------------------------

describe('runPipelineBookThumbnailImage cover text with no subtitle', () => {
  it('subtitle が null なら undefined が generateCoverImage に渡される', async () => {
    const { job } = makeDefaultFixtures();
    const coverText: CoverTextRecord = {
      id: 'ctp_no_sub',
      book_id: 'book_1',
      title: 'タイトルのみ',
      subtitle: null,
    };
    const { prisma } = buildPrisma({
      jobs: [job],
      coverTexts: [coverText],
      coverCount: 1,
    });
    const { deps, generateCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookThumbnailImage(
      { book_id: 'book_1', cover_text_id: 'ctp_no_sub', job_id: 'job_img_1' },
      addJob,
      deps,
    );

    expect(generateCalls).toHaveLength(1);
    const input = generateCalls[0] as Record<string, unknown>;
    expect(input.title).toBe('タイトルのみ');
    expect(input.subtitle).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

describe('runPipelineBookThumbnailImage idempotency', () => {
  it('Job.status === done なら早期 return', async () => {
    const { job, coverText } = makeDefaultFixtures({ jobStatus: 'done' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      coverTexts: [coverText],
    });
    const { deps, generateCalls, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookThumbnailImage(
      { book_id: 'book_1', cover_text_id: 'ctp_1', job_id: 'job_img_1' },
      addJob,
      deps,
    );

    expect(captures.jobUpdateMany).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
  });

  it('CAS で count=0 (他 worker が先取り) なら skip', async () => {
    const { job, coverText } = makeDefaultFixtures({ jobStatus: 'running' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      coverTexts: [coverText],
      forceUpdateManyCount: 0,
    });
    const { deps, generateCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookThumbnailImage(
      { book_id: 'book_1', cover_text_id: 'ctp_1', job_id: 'job_img_1' },
      addJob,
      deps,
    );

    expect(generateCalls).toHaveLength(0);
    expect(captures.jobUpdates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

describe('runPipelineBookThumbnailImage error paths', () => {
  it('payload zod 違反 -> ValidationError', async () => {
    const { prisma } = buildPrisma({ jobs: [], coverTexts: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(runPipelineBookThumbnailImage({}, addJob, deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(runPipelineBookThumbnailImage({}, addJob, deps)).rejects.toBeInstanceOf(
      A2PError,
    );
  });

  it('Job 不在 -> NotFoundError', async () => {
    const { prisma } = buildPrisma({ jobs: [], coverTexts: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookThumbnailImage(
        { book_id: 'book_1', cover_text_id: 'ctp_1', job_id: 'job_missing' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('CoverTextProposal 不在 -> NotFoundError, Job=failed', async () => {
    const { job } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      coverTexts: [],
    });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookThumbnailImage(
        { book_id: 'book_1', cover_text_id: 'ctp_missing', job_id: 'job_img_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('CoverTextProposal.book_id mismatch -> ValidationError, Job=failed', async () => {
    const { job } = makeDefaultFixtures();
    const coverText: CoverTextRecord = {
      id: 'ctp_wrong',
      book_id: 'book_OTHER',
      title: 'タイトル',
      subtitle: null,
    };
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      coverTexts: [coverText],
    });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookThumbnailImage(
        { book_id: 'book_1', cover_text_id: 'ctp_wrong', job_id: 'job_img_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('generateCoverImage throw -> 透過, Job=failed', async () => {
    const { job, coverText } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      coverTexts: [coverText],
    });
    const boom = new Error('boom from generateCoverImage');
    const { deps } = buildDeps(prisma, {
      generateCoverImage: (async () => {
        throw boom;
      }) as unknown as PipelineBookThumbnailImageDeps['generateCoverImage'],
    });
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookThumbnailImage(
        { book_id: 'book_1', cover_text_id: 'ctp_1', job_id: 'job_img_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(boom);

    expect(addJobCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect((failedCall?.data.error as string).includes('boom from generateCoverImage')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// notify 失敗時の warn 継続
// ---------------------------------------------------------------------------

describe('runPipelineBookThumbnailImage notify failure', () => {
  it('notifyJobChange が ok=false でも本処理は完走 (Job=done のまま)', async () => {
    const { job, coverText } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      coverTexts: [coverText],
      coverCount: 1,
    });
    const notifyCallsLocal: Array<{ payload: unknown }> = [];
    const { deps } = buildDeps(prisma, {
      notifyJobChange: (async (payload: unknown) => {
        notifyCallsLocal.push({ payload });
        return { ok: false };
      }) as unknown as PipelineBookThumbnailImageDeps['notifyJobChange'],
    });
    const { addJob } = makeAddJob();

    await runPipelineBookThumbnailImage(
      { book_id: 'book_1', cover_text_id: 'ctp_1', job_id: 'job_img_1' },
      addJob,
      deps,
    );

    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.data).toMatchObject({ status: 'done' });
    expect(notifyCallsLocal).toHaveLength(1);
  });
});
