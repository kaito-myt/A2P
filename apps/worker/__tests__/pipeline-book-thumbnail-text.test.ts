import { describe, expect, it, vi } from 'vitest';

import {
  A2PError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { ThumbnailTextOutput } from '@a2p/contracts/agents/thumbnail';

import {
  PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
  PipelineBookThumbnailTextPayloadSchema,
  runPipelineBookThumbnailText,
  type AddJobLike,
  type PipelineBookThumbnailTextDeps,
  type PipelineBookThumbnailTextPrisma,
} from '../src/tasks/pipeline-book-thumbnail-text.js';

// ---------------------------------------------------------------------------
// テスト用ファクトリ (pipeline-book-editor.test.ts と同形)
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

interface BookRecord {
  id: string;
  account_id: string;
  theme_id: string | null;
  title: string;
  subtitle: string | null;
}

interface ThemeRecord {
  id: string;
  genre: string;
  title: string;
  subtitle: string | null;
  hook: string;
  target_reader: string | null;
}

interface CoverTextProposalRecord {
  id: string;
  book_id: string;
  title: string;
  subtitle: string | null;
  band_copy: string | null;
  status: string;
}

interface PrismaCaptures {
  jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobUpdateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  jobCreates: Array<{ data: Record<string, unknown> }>;
  coverTextCreates: Array<{ data: Record<string, unknown> }>;
  executeRawCalls: Array<{ sql: string; values: unknown[] }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  books: BookRecord[];
  themes: ThemeRecord[];
  forceUpdateManyCount?: number;
  executeRawThrow?: Error;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineBookThumbnailTextPrisma;
  captures: PrismaCaptures;
  state: {
    jobs: JobRecord[];
    coverTextProposals: CoverTextProposalRecord[];
  };
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    jobCreates: [],
    coverTextCreates: [],
    executeRawCalls: [],
  };
  const jobs = [...args.jobs];
  const coverTextProposals: CoverTextProposalRecord[] = [];
  let jobCreateCounter = 0;
  let coverTextCounter = 0;

  const prisma: PipelineBookThumbnailTextPrisma = {
    $executeRawUnsafe: async (sql, ...values) => {
      captures.executeRawCalls.push({ sql, values });
      if (args.executeRawThrow) throw args.executeRawThrow;
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
      create: async ({ data }) => {
        captures.jobCreates.push({
          data: data as unknown as Record<string, unknown>,
        });
        jobCreateCounter += 1;
        const id = `image_job_${jobCreateCounter}`;
        jobs.push({
          id,
          status: data.status,
          book_id: data.book_id,
          kind: data.kind,
        });
        return { id };
      },
    },
    book: {
      findUnique: async ({ where }) => {
        const b = args.books.find((x) => x.id === where.id);
        return b
          ? {
              id: b.id,
              account_id: b.account_id,
              theme_id: b.theme_id,
              title: b.title,
              subtitle: b.subtitle,
            }
          : null;
      },
    },
    themeCandidate: {
      findUnique: async ({ where }) => {
        const t = args.themes.find((x) => x.id === where.id);
        return t
          ? {
              id: t.id,
              genre: t.genre,
              title: t.title,
              subtitle: t.subtitle,
              hook: t.hook,
              target_reader: t.target_reader,
            }
          : null;
      },
    },
    coverTextProposal: {
      create: async ({ data }) => {
        captures.coverTextCreates.push({
          data: data as unknown as Record<string, unknown>,
        });
        coverTextCounter += 1;
        const id = `ctp_${coverTextCounter}`;
        coverTextProposals.push({
          id,
          book_id: data.book_id,
          title: data.title,
          subtitle: data.subtitle,
          band_copy: data.band_copy,
          status: data.status,
        });
        return { id };
      },
    },
  };
  return { prisma, captures, state: { jobs, coverTextProposals } };
}

function makeDefaultFixtures(opts?: { jobStatus?: string }): {
  job: JobRecord;
  book: BookRecord;
  theme: ThemeRecord;
} {
  const job: JobRecord = {
    id: 'job_thumb_1',
    status: opts?.jobStatus ?? 'queued',
    book_id: 'book_1',
    kind: 'pipeline.book.thumbnail.text',
  };
  const book: BookRecord = {
    id: 'book_1',
    account_id: 'acc_1',
    theme_id: 'theme_1',
    title: 'テスト書籍タイトル',
    subtitle: 'テスト副題',
  };
  const theme: ThemeRecord = {
    id: 'theme_1',
    genre: 'business',
    title: 'テスト書籍タイトル',
    subtitle: 'テスト副題',
    hook: '実例と数値で語る差別化フック',
    target_reader: '副業を考えている 30-40 代会社員',
  };
  return { job, book, theme };
}

function makeCoverTextOutput(count = 3): ThumbnailTextOutput {
  return {
    proposals: Array.from({ length: count }, (_, i) => ({
      title: `表紙案${i + 1}のタイトル`,
      subtitle: `サブタイトル案${i + 1}`,
      band_copy: `帯文案${i + 1}`,
    })),
  };
}

function buildDeps(
  prisma: PipelineBookThumbnailTextPrisma,
  overrides: Partial<PipelineBookThumbnailTextDeps> = {},
): {
  deps: PipelineBookThumbnailTextDeps;
  acquireCalls: Array<{ bookId: string; holder: string; ttlMinutes?: number }>;
  releaseCalls: Array<{ bookId: string; holder: string }>;
  generateCalls: Array<unknown>;
  notifyCalls: Array<{ payload: unknown }>;
  loggerCalls: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
} {
  const { logger, calls: loggerCalls } = makeLogger();
  const acquireCalls: Array<{ bookId: string; holder: string; ttlMinutes?: number }> = [];
  const releaseCalls: Array<{ bookId: string; holder: string }> = [];
  const generateCalls: Array<unknown> = [];
  const notifyCalls: Array<{ payload: unknown }> = [];

  const baseDeps: PipelineBookThumbnailTextDeps = {
    prisma,
    logger,
    now: () => new Date('2026-05-25T00:00:00Z'),
    acquireLock: (async (args: {
      bookId: string;
      holder: string;
      ttlMinutes?: number;
    }) => {
      acquireCalls.push(args);
      return {
        book_id: args.bookId,
        holder: args.holder,
        acquired_at: new Date('2026-05-25T00:00:00Z'),
        expires_at: new Date('2026-05-25T00:30:00Z'),
      };
    }) as unknown as PipelineBookThumbnailTextDeps['acquireLock'],
    releaseLock: (async (args: { bookId: string; holder: string }) => {
      releaseCalls.push(args);
    }) as unknown as PipelineBookThumbnailTextDeps['releaseLock'],
    generateCoverText: (async (input: unknown) => {
      generateCalls.push(input);
      return makeCoverTextOutput(3);
    }) as unknown as PipelineBookThumbnailTextDeps['generateCoverText'],
    notifyJobChange: (async (payload: unknown) => {
      notifyCalls.push({ payload });
      return { ok: true };
    }) as unknown as PipelineBookThumbnailTextDeps['notifyJobChange'],
  };
  return {
    deps: { ...baseDeps, ...overrides },
    acquireCalls,
    releaseCalls,
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

describe('pipeline.book.thumbnail.text payload schema', () => {
  it('task identifier が docs/05 ss5.3.6 と一致する', () => {
    expect(PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME).toBe('pipeline.book.thumbnail.text');
  });

  it('book_id / job_id を必須', () => {
    expect(
      PipelineBookThumbnailTextPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
      }).success,
    ).toBe(true);
    expect(
      PipelineBookThumbnailTextPayloadSchema.safeParse({ book_id: 'b1' }).success,
    ).toBe(false);
    expect(
      PipelineBookThumbnailTextPayloadSchema.safeParse({ job_id: 'j1' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

describe('runPipelineBookThumbnailText happy path', () => {
  it('3 件 CoverTextProposal INSERT + 3 件 thumbnail.image enqueue + Job done + notify', async () => {
    const { job, book, theme } = makeDefaultFixtures();
    const { prisma, captures, state } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps, acquireCalls, releaseCalls, generateCalls, notifyCalls } =
      buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookThumbnailText(
      { book_id: 'book_1', job_id: 'job_thumb_1' },
      addJob,
      deps,
    );

    // CAS
    expect(captures.jobUpdateMany).toHaveLength(1);
    expect(captures.jobUpdateMany[0]?.data).toMatchObject({ status: 'running' });

    // BookLock acquire/release
    expect(acquireCalls).toEqual([
      { bookId: 'book_1', holder: 'pipeline:job_thumb_1', ttlMinutes: 30 },
    ]);
    expect(releaseCalls).toEqual([
      { bookId: 'book_1', holder: 'pipeline:job_thumb_1' },
    ]);

    // generateCoverText 呼出
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]).toMatchObject({
      jobId: 'job_thumb_1',
      bookId: 'book_1',
      accountId: 'acc_1',
      genre: 'business',
      count: 3,
      themeContext: {
        title: 'テスト書籍タイトル',
        subtitle: 'テスト副題',
        hook: '実例と数値で語る差別化フック',
        target_reader: '副業を考えている 30-40 代会社員',
      },
    });

    // CoverTextProposal 3 件 INSERT
    expect(captures.coverTextCreates).toHaveLength(3);
    captures.coverTextCreates.forEach((c, i) => {
      expect(c.data).toMatchObject({
        book_id: 'book_1',
        title: `表紙案${i + 1}のタイトル`,
        subtitle: `サブタイトル案${i + 1}`,
        band_copy: `帯文案${i + 1}`,
        status: 'proposed',
      });
    });
    expect(state.coverTextProposals).toHaveLength(3);

    // pipeline.book.thumbnail.image 3 件 enqueue
    expect(captures.jobCreates).toHaveLength(3);
    captures.jobCreates.forEach((c, i) => {
      expect(c.data).toMatchObject({
        kind: 'pipeline.book.thumbnail.image',
        book_id: 'book_1',
        parent_job_id: 'job_thumb_1',
        status: 'queued',
        payload_json: {
          book_id: 'book_1',
          cover_text_id: `ctp_${i + 1}`,
        },
      });
    });
    // 3 thumbnail.image enqueue calls
    const imageJobCalls = addJobCalls.filter((c) => c.identifier === 'pipeline.book.thumbnail.image');
    expect(imageJobCalls).toHaveLength(3);
    imageJobCalls.forEach((c, i) => {
      expect(c.payload).toMatchObject({
        book_id: 'book_1',
        cover_text_id: `ctp_${i + 1}`,
        job_id: `image_job_${i + 1}`,
      });
      expect(c.spec).toEqual({ maxAttempts: 3 });
    });

    // Job done + result_json
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.data).toMatchObject({
      status: 'done',
      result_json: {
        proposals_count: 3,
        children: [
          { cover_text_id: 'ctp_1', child_job_id: 'image_job_1' },
          { cover_text_id: 'ctp_2', child_job_id: 'image_job_2' },
          { cover_text_id: 'ctp_3', child_job_id: 'image_job_3' },
        ],
      },
    });

    // alert.cost.check per_book enqueue (F-034 / T-07-02)
    const costCheckCalls = addJobCalls.filter((c) => c.identifier === 'alert.cost.check');
    expect(costCheckCalls).toHaveLength(1);
    expect(costCheckCalls[0]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    // total addJob calls: 3 thumbnail.image + 1 alert.cost.check
    expect(addJobCalls).toHaveLength(4);

    // notify phase=thumbnail_text_done
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.payload).toMatchObject({
      jobId: 'job_thumb_1',
      status: 'done',
      kind: 'pipeline.book.thumbnail.text',
      bookId: 'book_1',
      phase: 'thumbnail_text_done',
    });
  });

  it('generateCoverText が 5 案を返しても 3 件に切り詰める', async () => {
    const { job, book, theme } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps } = buildDeps(prisma, {
      generateCoverText: (async () => {
        return makeCoverTextOutput(5);
      }) as unknown as PipelineBookThumbnailTextDeps['generateCoverText'],
    });
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookThumbnailText(
      { book_id: 'book_1', job_id: 'job_thumb_1' },
      addJob,
      deps,
    );

    expect(captures.coverTextCreates).toHaveLength(3);
    // 3 thumbnail.image + 1 alert.cost.check
    expect(addJobCalls).toHaveLength(4);
    expect(addJobCalls.filter((c) => c.identifier === 'pipeline.book.thumbnail.image')).toHaveLength(3);
    expect(addJobCalls.filter((c) => c.identifier === 'alert.cost.check')).toHaveLength(1);

    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall?.data).toMatchObject({
      result_json: { proposals_count: 3 },
    });
  });

  it('subtitle / band_copy が undefined の案は null で INSERT される', async () => {
    const { job, book, theme } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps } = buildDeps(prisma, {
      generateCoverText: (async () => ({
        proposals: [
          { title: 'タイトルのみ' },
          { title: 'タイトル2', subtitle: 'サブ2' },
          { title: 'タイトル3', band_copy: '帯文3' },
        ],
      })) as unknown as PipelineBookThumbnailTextDeps['generateCoverText'],
    });
    const { addJob } = makeAddJob();

    await runPipelineBookThumbnailText(
      { book_id: 'book_1', job_id: 'job_thumb_1' },
      addJob,
      deps,
    );

    expect(captures.coverTextCreates[0]?.data).toMatchObject({
      title: 'タイトルのみ',
      subtitle: null,
      band_copy: null,
    });
    expect(captures.coverTextCreates[1]?.data).toMatchObject({
      title: 'タイトル2',
      subtitle: 'サブ2',
      band_copy: null,
    });
    expect(captures.coverTextCreates[2]?.data).toMatchObject({
      title: 'タイトル3',
      subtitle: null,
      band_copy: '帯文3',
    });
  });

  it('Book.subtitle が null の場合 theme.subtitle にフォールバックする', async () => {
    const { job, theme } = makeDefaultFixtures();
    const book: BookRecord = {
      id: 'book_1',
      account_id: 'acc_1',
      theme_id: 'theme_1',
      title: 'テスト書籍',
      subtitle: null,
    };
    const { prisma } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps, generateCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookThumbnailText(
      { book_id: 'book_1', job_id: 'job_thumb_1' },
      addJob,
      deps,
    );

    expect(generateCalls).toHaveLength(1);
    expect(
      (generateCalls[0] as { themeContext: { subtitle?: string } }).themeContext.subtitle,
    ).toBe('テスト副題');
  });
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

describe('runPipelineBookThumbnailText idempotency', () => {
  it('Job.status === done なら早期 return', async () => {
    const { job, book, theme } = makeDefaultFixtures({ jobStatus: 'done' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps, acquireCalls, generateCalls, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookThumbnailText(
      { book_id: 'book_1', job_id: 'job_thumb_1' },
      addJob,
      deps,
    );

    expect(captures.jobUpdateMany).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(captures.coverTextCreates).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
  });

  it('CAS で count=0 (他 worker が先取り) なら skip', async () => {
    const { job, book, theme } = makeDefaultFixtures({ jobStatus: 'running' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      forceUpdateManyCount: 0,
    });
    const { deps, acquireCalls, generateCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookThumbnailText(
      { book_id: 'book_1', job_id: 'job_thumb_1' },
      addJob,
      deps,
    );

    expect(acquireCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(captures.coverTextCreates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

describe('runPipelineBookThumbnailText error paths', () => {
  it('payload zod 違反 -> ValidationError (A2PError 派生)', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(runPipelineBookThumbnailText({}, addJob, deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(runPipelineBookThumbnailText({}, addJob, deps)).rejects.toBeInstanceOf(
      A2PError,
    );
  });

  it('Job 不在 -> NotFoundError (CAS 前)', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookThumbnailText(
        { book_id: 'book_1', job_id: 'job_missing' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('Book 不在 -> NotFoundError, Job=failed, lock released', async () => {
    const { job, theme } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [],
      themes: [theme],
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookThumbnailText(
        { book_id: 'book_1', job_id: 'job_thumb_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect(releaseCalls).toHaveLength(1);
  });

  it('Book.theme_id が null -> NotFoundError, Job=failed', async () => {
    const { job, theme } = makeDefaultFixtures();
    const book: BookRecord = {
      id: 'book_1',
      account_id: 'acc_1',
      theme_id: null,
      title: 'テスト',
      subtitle: null,
    };
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookThumbnailText(
        { book_id: 'book_1', job_id: 'job_thumb_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect(releaseCalls).toHaveLength(1);
  });

  it('ThemeCandidate 不在 -> NotFoundError, Job=failed', async () => {
    const { job, book } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [],
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookThumbnailText(
        { book_id: 'book_1', job_id: 'job_thumb_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect(releaseCalls).toHaveLength(1);
  });

  it('generateCoverText throw -> 透過, Job failed, CoverTextProposal 0 件', async () => {
    const { job, book, theme } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const boom = new Error('boom from generateCoverText');
    const { deps, releaseCalls } = buildDeps(prisma, {
      generateCoverText: (async () => {
        throw boom;
      }) as unknown as PipelineBookThumbnailTextDeps['generateCoverText'],
    });
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookThumbnailText(
        { book_id: 'book_1', job_id: 'job_thumb_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(boom);

    expect(captures.coverTextCreates).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect((failedCall?.data.error as string).includes('boom from generateCoverText')).toBe(true);
    expect(releaseCalls).toHaveLength(1);
  });

  it('BookLock acquire 失敗 (ConflictError) -> Job=failed + 透過 throw, generateCoverText 未呼出', async () => {
    const { job, book, theme } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const conflict = new ConflictError('book locked');
    const { deps, generateCalls, releaseCalls } = buildDeps(prisma, {
      acquireLock: (async () => {
        throw conflict;
      }) as unknown as PipelineBookThumbnailTextDeps['acquireLock'],
    });
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookThumbnailText(
        { book_id: 'book_1', job_id: 'job_thumb_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(conflict);

    expect(generateCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect(releaseCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// notify 失敗時の warn 継続
// ---------------------------------------------------------------------------

describe('runPipelineBookThumbnailText notify failure', () => {
  it('notifyJobChange が ok=false でも本処理は完走 (Job=done のまま)', async () => {
    const { job, book, theme } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const notifyCallsLocal: Array<{ payload: unknown }> = [];
    const { deps } = buildDeps(prisma, {
      notifyJobChange: (async (payload: unknown) => {
        notifyCallsLocal.push({ payload });
        return { ok: false };
      }) as unknown as PipelineBookThumbnailTextDeps['notifyJobChange'],
    });
    const { addJob } = makeAddJob();

    await runPipelineBookThumbnailText(
      { book_id: 'book_1', job_id: 'job_thumb_1' },
      addJob,
      deps,
    );

    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.data).toMatchObject({ status: 'done' });
    expect(notifyCallsLocal).toHaveLength(1);
  });
});
