import { describe, expect, it, vi } from 'vitest';

import { A2PError, ConflictError, NotFoundError, ValidationError } from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { MarketerMetadataOutput } from '@a2p/contracts/agents/marketer';

import {
  PIPELINE_BOOK_MARKETER_TASK_NAME,
  PipelineBookMarketerPayloadSchema,
  runPipelineBookMarketer,
  type AddJobLike,
  type PipelineBookMarketerDeps,
  type PipelineBookMarketerPrisma,
} from '../src/tasks/pipeline-book-marketer.js';

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
  competitors_json: unknown;
  signals_json: unknown;
}

interface PrismaCaptures {
  jobUpdates: Array<{
    where: { id: string };
    data: Record<string, unknown>;
  }>;
  jobUpdateMany: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }>;
  jobCreates: Array<{
    data: Record<string, unknown>;
  }>;
  kdpUpserts: Array<{
    where: { book_id: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  books: BookRecord[];
  themes: ThemeRecord[];
  /** updateMany が返す count を強制する場合 (CAS 失敗テスト用)。 */
  forceUpdateManyCount?: number;
  /** kdpMetadata.upsert を強制失敗させる場合。 */
  upsertThrow?: Error;
  /** job.create が返す新規 Job.id (省略時 'child_job_id_1')。 */
  childJobIdSeed?: string;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineBookMarketerPrisma;
  captures: PrismaCaptures;
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    jobCreates: [],
    kdpUpserts: [],
  };
  const jobs = [...args.jobs];
  const childSeed = args.childJobIdSeed ?? 'child_job_id_1';
  let childCounter = 0;

  const prisma: PipelineBookMarketerPrisma = {
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
        childCounter += 1;
        const id = childCounter === 1 ? childSeed : `${childSeed}_${childCounter}`;
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
              competitors_json: t.competitors_json,
              signals_json: t.signals_json,
            }
          : null;
      },
    },
    kdpMetadata: {
      upsert: async ({ where, create, update }) => {
        if (args.upsertThrow) throw args.upsertThrow;
        captures.kdpUpserts.push({ where, create, update });
        return { id: `kdp_${where.book_id}`, book_id: where.book_id };
      },
    },
  };
  return { prisma, captures };
}

function makeOkMetadata(): MarketerMetadataOutput {
  return {
    metadata: {
      description:
        'これは Marketer が生成したテスト用の書籍紹介文です。'.repeat(3) +
        '十分長く 50 文字以上を確保します。',
      categories: [
        'Kindle ストア > Kindleストア > Kindle本 > ビジネス・経済 > 起業',
        'Kindle ストア > Kindleストア > Kindle本 > ビジネス・経済 > マーケティング・セールス',
      ],
      keywords: ['副業', '起業', 'マーケティング', 'ビジネス', '実践'],
      suggested_price_jpy: 480,
    },
    notes: 'test note',
  };
}

function makeJobBookTheme(opts?: {
  jobStatus?: string;
  themeId?: string | null;
}): {
  job: JobRecord;
  book: BookRecord;
  theme: ThemeRecord;
} {
  const job: JobRecord = {
    id: 'job_1',
    status: opts?.jobStatus ?? 'queued',
    book_id: 'book_1',
  };
  const book: BookRecord = {
    id: 'book_1',
    account_id: 'acc_1',
    theme_id: opts?.themeId === undefined ? 'theme_1' : opts.themeId,
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
    competitors_json: [
      { title: '副業の教科書', url: 'https://example.com/a', asin: 'B0X1' },
    ],
    signals_json: { reasoning: 'r', market_score: 70 },
  };
  return { job, book, theme };
}

function buildDeps(
  prisma: PipelineBookMarketerPrisma,
  overrides: Partial<PipelineBookMarketerDeps> = {},
): {
  deps: PipelineBookMarketerDeps;
  acquireCalls: Array<{ bookId: string; holder: string; ttlMinutes?: number }>;
  releaseCalls: Array<{ bookId: string; holder: string }>;
  generateCalls: Array<unknown>;
} {
  const { logger } = makeLogger();
  const acquireCalls: Array<{ bookId: string; holder: string; ttlMinutes?: number }> = [];
  const releaseCalls: Array<{ bookId: string; holder: string }> = [];
  const generateCalls: Array<unknown> = [];

  const baseDeps: PipelineBookMarketerDeps = {
    prisma,
    logger,
    now: () => new Date('2026-05-23T00:00:00Z'),
    acquireLock: (async (args: { bookId: string; holder: string; ttlMinutes?: number }) => {
      acquireCalls.push(args);
      return {
        book_id: args.bookId,
        holder: args.holder,
        acquired_at: new Date('2026-05-23T00:00:00Z'),
        expires_at: new Date('2026-05-23T00:30:00Z'),
      };
    }) as unknown as PipelineBookMarketerDeps['acquireLock'],
    releaseLock: (async (args: { bookId: string; holder: string }) => {
      releaseCalls.push(args);
    }) as unknown as PipelineBookMarketerDeps['releaseLock'],
    generateMetadata: (async (input: unknown) => {
      generateCalls.push(input);
      return makeOkMetadata();
    }) as unknown as PipelineBookMarketerDeps['generateMetadata'],
  };
  return {
    deps: { ...baseDeps, ...overrides },
    acquireCalls,
    releaseCalls,
    generateCalls,
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
// テスト
// ---------------------------------------------------------------------------

describe('pipeline.book.marketer payload schema', () => {
  it('task identifier が docs/05 §5.3.2 と一致する', () => {
    expect(PIPELINE_BOOK_MARKETER_TASK_NAME).toBe('pipeline.book.marketer');
  });

  it('book_id / job_id を必須にする', () => {
    expect(
      PipelineBookMarketerPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
      }).success,
    ).toBe(true);

    expect(
      PipelineBookMarketerPayloadSchema.safeParse({ job_id: 'j1' }).success,
    ).toBe(false);
    expect(
      PipelineBookMarketerPayloadSchema.safeParse({ book_id: 'b1' }).success,
    ).toBe(false);
    expect(
      PipelineBookMarketerPayloadSchema.safeParse({
        book_id: '',
        job_id: 'j1',
      }).success,
    ).toBe(false);
  });
});

describe('runPipelineBookMarketer happy path', () => {
  it('Job CAS → Marketer 呼出 → KdpMetadata upsert → child enqueue → lock release が順に行われる', async () => {
    const { job, book, theme } = makeJobBookTheme();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps, acquireCalls, releaseCalls, generateCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookMarketer(
      { book_id: 'book_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    // 1. CAS で running に上がっている
    expect(captures.jobUpdateMany).toHaveLength(1);
    expect(captures.jobUpdateMany[0]?.data).toMatchObject({ status: 'running' });

    // 2. acquireLock 呼出 (holder=pipeline:<job_id>, ttl 30 分)
    expect(acquireCalls).toEqual([
      { bookId: 'book_1', holder: 'pipeline:job_1', ttlMinutes: 30 },
    ]);

    // 3. generateMetadata 呼出 (jobId は内部 Job.id, accountId 紐付け)
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]).toMatchObject({
      jobId: 'job_1',
      bookId: 'book_1',
      accountId: 'acc_1',
      genre: 'business',
      themeContext: {
        title: 'テスト書籍タイトル',
        subtitle: 'テスト副題',
        hook: '実例と数値で語る差別化フック',
        target_reader: '副業を考えている 30-40 代会社員',
      },
    });

    // 4. KdpMetadata.upsert (snake_case 列名で書き込み)
    expect(captures.kdpUpserts).toHaveLength(1);
    expect(captures.kdpUpserts[0]?.where).toEqual({ book_id: 'book_1' });
    expect(captures.kdpUpserts[0]?.create).toMatchObject({
      book_id: 'book_1',
      keywords: ['副業', '起業', 'マーケティング', 'ビジネス', '実践'],
      categories: expect.any(Array),
      price_jpy: 480,
    });
    // price_jpy 列名で書き込まれている (DB 列は price_jpy、agent 出力は suggested_price_jpy)
    expect((captures.kdpUpserts[0]?.create as { price_jpy: number }).price_jpy).toBe(480);

    // 5. Job.update で done に遷移
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.where).toEqual({ id: 'job_1' });
    expect(doneCall?.data).toMatchObject({
      status: 'done',
      result_json: { kdp_metadata_id: 'kdp_book_1', notes: 'test note' },
    });

    // 6. 子 enqueue: フリガナ(readings) と writer.outline の 2 件を新規 Job 行として
    //    INSERT し、それぞれ新規 Job.id を payload.job_id に乗せて enqueue する。
    expect(captures.jobCreates).toHaveLength(2);
    const outlineCreate = captures.jobCreates.find(
      (c) => c.data.kind === 'pipeline.book.writer.outline',
    );
    expect(outlineCreate?.data).toMatchObject({
      kind: 'pipeline.book.writer.outline',
      book_id: 'book_1',
      parent_job_id: 'job_1',
      status: 'queued',
    });
    // フリガナ(readings)の子 Job も自動連鎖される (KDP 入稿でフリガナを最初から揃える)
    expect(
      captures.jobCreates.some((c) => c.data.kind === 'pipeline.book.readings.generate'),
    ).toBe(true);
    // enqueue: cost.check + readings + writer.outline の 3 件
    expect(addJobCalls).toHaveLength(3);
    // cost check enqueue (F-034 / T-07-02)
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[0]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });
    // readings enqueue (非致命の連鎖)
    expect(
      addJobCalls.some((c) => c.identifier === 'pipeline.book.readings.generate'),
    ).toBe(true);
    // writer.outline enqueue — 新規子 Job.id (親 job_1 ではない) を乗せる
    const outlineEnqueue = addJobCalls.find(
      (c) => c.identifier === 'pipeline.book.writer.outline',
    );
    expect(outlineEnqueue?.payload).toMatchObject({ book_id: 'book_1' });
    expect((outlineEnqueue?.payload as { job_id: string }).job_id).toEqual(expect.any(String));
    expect((outlineEnqueue?.payload as { job_id: string }).job_id).not.toBe('job_1');

    // 7. lock release は finally で必ず実行
    expect(releaseCalls).toEqual([{ bookId: 'book_1', holder: 'pipeline:job_1' }]);
  });

  it('writer.outline 用の子 Job 行を kind/parent_job_id/status=queued で INSERT する', async () => {
    const { job, book, theme } = makeJobBookTheme();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      childJobIdSeed: 'child_job_id_xyz',
    });
    const { deps } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookMarketer(
      { book_id: 'book_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    // 子 Job 行が正しい契約で INSERT されている (readings + writer.outline の 2 件)
    expect(captures.jobCreates).toHaveLength(2);
    const outlineCreate = captures.jobCreates.find(
      (c) => c.data.kind === 'pipeline.book.writer.outline',
    );
    expect(outlineCreate?.data).toEqual(
      expect.objectContaining({
        kind: 'pipeline.book.writer.outline',
        book_id: 'book_1',
        parent_job_id: 'job_1',
        status: 'queued',
        payload_json: expect.objectContaining({ book_id: 'book_1' }),
      }),
    );

    // graphile-worker への enqueue は新規 Job.id を payload に乗せている
    expect(addJobCalls).toHaveLength(3);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    const outlineEnqueue = addJobCalls.find(
      (c) => c.identifier === 'pipeline.book.writer.outline',
    );
    expect(outlineEnqueue?.payload).toMatchObject({ book_id: 'book_1' });
    expect((outlineEnqueue?.payload as { job_id: string }).job_id).toEqual(expect.any(String));
  });

  it('再実行 (同 job_id) でも upsert により KdpMetadata は 1 件のまま', async () => {
    const { job, book, theme } = makeJobBookTheme();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    // 1 回目: 通常実行
    await runPipelineBookMarketer({ book_id: 'book_1', job_id: 'job_1' }, addJob, deps);
    expect(captures.kdpUpserts).toHaveLength(1);

    // job は done になっているので 2 回目は早期 skip
    // (CAS は呼ばれず、upsert も追加されない)
    await runPipelineBookMarketer({ book_id: 'book_1', job_id: 'job_1' }, addJob, deps);
    expect(captures.kdpUpserts).toHaveLength(1);
    expect(captures.jobUpdateMany).toHaveLength(1);
  });
});

describe('runPipelineBookMarketer idempotency', () => {
  it('Job.status === done なら早期 return (Marketer 呼ばれず、子 enqueue されない)', async () => {
    const { job, book, theme } = makeJobBookTheme({ jobStatus: 'done' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps, acquireCalls, generateCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookMarketer(
      { book_id: 'book_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    expect(captures.jobUpdateMany).toHaveLength(0);
    expect(captures.kdpUpserts).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
  });

  it('CAS で count=0 (他 worker が先に running 化) なら skip', async () => {
    const { job, book, theme } = makeJobBookTheme({ jobStatus: 'running' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      forceUpdateManyCount: 0,
    });
    const { deps, acquireCalls, generateCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookMarketer(
      { book_id: 'book_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    expect(captures.kdpUpserts).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
  });
});

describe('runPipelineBookMarketer error paths', () => {
  it('payload zod 違反 → ValidationError', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookMarketer({}, addJob, deps),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runPipelineBookMarketer({}, addJob, deps),
    ).rejects.toBeInstanceOf(A2PError);
  });

  it('Job が存在しない → NotFoundError', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [] });
    const { deps, acquireCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookMarketer(
        { book_id: 'book_1', job_id: 'job_missing' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Job が無いので lock は取らない
    expect(acquireCalls).toHaveLength(0);
  });

  it('Book が存在しない → NotFoundError, Job は failed に降格, lock は release', async () => {
    const { job, theme } = makeJobBookTheme();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [], // book を欠落させる
      themes: [theme],
    });
    const { deps, acquireCalls, releaseCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookMarketer(
        { book_id: 'book_missing', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(acquireCalls).toHaveLength(1);
    expect(releaseCalls).toHaveLength(1);
    expect(addJobCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Book.theme_id が null → NotFoundError', async () => {
    const { job, book, theme } = makeJobBookTheme({ themeId: null });
    const { prisma } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookMarketer({ book_id: 'book_1', job_id: 'job_1' }, addJob, deps),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(releaseCalls).toHaveLength(1);
  });

  it('ThemeCandidate が存在しない → NotFoundError', async () => {
    const { job, book } = makeJobBookTheme();
    const { prisma } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [], // theme 欠落
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookMarketer({ book_id: 'book_1', job_id: 'job_1' }, addJob, deps),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(releaseCalls).toHaveLength(1);
  });

  it('generateMetadata throw → 透過, Job は failed, 子 enqueue されない, lock 解放', async () => {
    const { job, book, theme } = makeJobBookTheme();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const boom = new Error('boom from agent');
    const { deps, releaseCalls } = buildDeps(prisma, {
      generateMetadata: (async () => {
        throw boom;
      }) as unknown as PipelineBookMarketerDeps['generateMetadata'],
    });
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookMarketer({ book_id: 'book_1', job_id: 'job_1' }, addJob, deps),
    ).rejects.toBe(boom);

    expect(captures.kdpUpserts).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    expect(releaseCalls).toHaveLength(1);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect((failedCall?.data.error as string).includes('boom from agent')).toBe(true);
  });

  it('KdpMetadata.upsert throw → 透過, Job failed, 子 enqueue されない, lock 解放', async () => {
    const { job, book, theme } = makeJobBookTheme();
    const dbErr = new Error('db error');
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      upsertThrow: dbErr,
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookMarketer({ book_id: 'book_1', job_id: 'job_1' }, addJob, deps),
    ).rejects.toBe(dbErr);

    expect(addJobCalls).toHaveLength(0);
    expect(releaseCalls).toHaveLength(1);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect(captures.kdpUpserts).toHaveLength(0);
  });

  it('acquireBookLock が ConflictError throw → 透過 (graphile-worker retry に任せる), Job は failed', async () => {
    const { job, book, theme } = makeJobBookTheme();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const lockErr = new ConflictError('book locked', { details: { bookId: 'book_1' } });
    const { deps, releaseCalls, generateCalls } = buildDeps(prisma, {
      acquireLock: (async () => {
        throw lockErr;
      }) as unknown as PipelineBookMarketerDeps['acquireLock'],
    });
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookMarketer({ book_id: 'book_1', job_id: 'job_1' }, addJob, deps),
    ).rejects.toBe(lockErr);

    // lock 取得前なので generateMetadata は呼ばれない
    expect(generateCalls).toHaveLength(0);
    // lock を取れていないので release も呼ばない
    expect(releaseCalls).toHaveLength(0);
    // CAS で running に上げた後の失敗なので Job は failed に戻す
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });
});
