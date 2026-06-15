import { describe, expect, it, vi } from 'vitest';

import type { AgentRole, Genre } from '@a2p/contracts/agents';
import {
  A2PError,
  ConfigError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { LoadedAssignment } from '@a2p/agents/lib/load-model-assignment';
import type { LoadedPrompt } from '@a2p/agents/lib/prompt-loader';

import {
  PIPELINE_BOOK_KICKOFF_TASK_NAME,
  PipelineBookKickoffPayloadSchema,
  SNAPSHOT_ROLES,
  runPipelineBookKickoff,
  type AddJobLike,
  type PipelineBookKickoffDeps,
  type PipelineBookKickoffPrisma,
} from '../src/tasks/pipeline-book-kickoff.js';

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
}

interface ThemeRecord {
  id: string;
  account_id: string;
  genre: string;
  title: string;
  subtitle: string | null;
  status: string;
}

interface BookRecord {
  id: string;
  account_id: string;
  theme_id: string | null;
  title: string;
  subtitle: string | null;
}

interface PrismaCaptures {
  jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobUpdateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  jobCreates: Array<{ data: Record<string, unknown> }>;
  bookCreates: Array<{ data: Record<string, unknown> }>;
  themeUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  batchPlanItemUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  themes: ThemeRecord[];
  books?: BookRecord[];
  /** updateMany が返す count を強制する場合 (CAS 失敗テスト用)。 */
  forceUpdateManyCount?: number;
  /** book.create を強制失敗させる場合。 */
  bookCreateThrow?: Error;
  /** job.create (子 Job) を強制失敗させる場合。 */
  childJobCreateThrow?: Error;
  /** 生成される Book.id seed (省略時 'book_new_1')。 */
  newBookIdSeed?: string;
  /** 生成される子 Job.id seed (省略時 'child_marketer_1')。 */
  childJobIdSeed?: string;
  /** AppSettings.ab_distribution_json の値 (T-11-06 A/B 割当テスト用)。 */
  abDistributionJson?: unknown;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineBookKickoffPrisma;
  captures: PrismaCaptures;
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    jobCreates: [],
    bookCreates: [],
    themeUpdates: [],
    batchPlanItemUpdates: [],
  };
  const jobs = [...args.jobs];
  const themes = [...args.themes];
  const books = [...(args.books ?? [])];
  const newBookSeed = args.newBookIdSeed ?? 'book_new_1';
  const childSeed = args.childJobIdSeed ?? 'child_marketer_1';
  let bookCounter = 0;
  let childJobCounter = 0;

  const prisma: PipelineBookKickoffPrisma = {
    // T-03-11: notifyJobChange (SSE pg_notify) は別ファイルで検証. ここでは noop.
    $executeRawUnsafe: async () => 1,
    appSettings: {
      findUnique: async () =>
        args.abDistributionJson !== undefined
          ? { ab_distribution_json: args.abDistributionJson }
          : null,
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
        if (j) {
          if (typeof (data as { status?: string }).status === 'string') {
            j.status = (data as { status: string }).status;
          }
          if ('book_id' in (data as object)) {
            const v = (data as { book_id?: string | null }).book_id;
            j.book_id = v ?? null;
          }
        }
        return {};
      },
      create: async ({ data }) => {
        captures.jobCreates.push({
          data: data as unknown as Record<string, unknown>,
        });
        if (args.childJobCreateThrow) throw args.childJobCreateThrow;
        childJobCounter += 1;
        const id =
          childJobCounter === 1 ? childSeed : `${childSeed}_${childJobCounter}`;
        return { id };
      },
    },
    themeCandidate: {
      findUnique: async ({ where }) => {
        const t = themes.find((x) => x.id === where.id);
        return t ? { ...t } : null;
      },
      update: async ({ where, data }) => {
        captures.themeUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        const t = themes.find((x) => x.id === where.id);
        if (t) {
          if (typeof (data as { status?: string }).status === 'string') {
            t.status = (data as { status: string }).status;
          }
        }
        return {};
      },
    },
    book: {
      findUnique: async ({ where }) => {
        const b = books.find((x) => x.id === where.id);
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
      create: async ({ data }) => {
        captures.bookCreates.push({
          data: data as unknown as Record<string, unknown>,
        });
        if (args.bookCreateThrow) throw args.bookCreateThrow;
        bookCounter += 1;
        const id = bookCounter === 1 ? newBookSeed : `${newBookSeed}_${bookCounter}`;
        const rec: BookRecord = {
          id,
          account_id: (data as { account_id: string }).account_id,
          theme_id: (data as { theme_id: string }).theme_id,
          title: (data as { title: string }).title,
          subtitle: (data as { subtitle: string | null }).subtitle,
        };
        books.push(rec);
        return { id };
      },
    },
    batchPlanItem: {
      update: async ({ where, data }) => {
        captures.batchPlanItemUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        return {};
      },
    },
  };
  return { prisma, captures };
}

function makeJobAndTheme(opts?: {
  jobStatus?: string;
  bookId?: string | null;
  themeStatus?: string;
}): { job: JobRecord; theme: ThemeRecord } {
  const job: JobRecord = {
    id: 'job_1',
    status: opts?.jobStatus ?? 'queued',
    book_id: opts?.bookId === undefined ? null : opts.bookId,
  };
  const theme: ThemeRecord = {
    id: 'theme_1',
    account_id: 'acc_1',
    genre: 'business',
    title: 'テスト書籍タイトル',
    subtitle: 'テスト副題',
    status: opts?.themeStatus ?? 'pending',
  };
  return { job, theme };
}

function buildDeps(
  prisma: PipelineBookKickoffPrisma,
  overrides: Partial<PipelineBookKickoffDeps> = {},
): {
  deps: PipelineBookKickoffDeps;
  acquireCalls: Array<{ bookId: string; holder: string; ttlMinutes?: number }>;
  releaseCalls: Array<{ bookId: string; holder: string }>;
  loadModelAssignmentCalls: Array<{ role: AgentRole; genre: Genre | null }>;
  loadActivePromptCalls: Array<{ role: AgentRole; genre: Genre | null }>;
} {
  const { logger } = makeLogger();
  const acquireCalls: Array<{ bookId: string; holder: string; ttlMinutes?: number }> = [];
  const releaseCalls: Array<{ bookId: string; holder: string }> = [];
  const loadModelAssignmentCalls: Array<{ role: AgentRole; genre: Genre | null }> = [];
  const loadActivePromptCalls: Array<{ role: AgentRole; genre: Genre | null }> = [];

  const baseDeps: PipelineBookKickoffDeps = {
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
    }) as unknown as PipelineBookKickoffDeps['acquireLock'],
    releaseLock: (async (args: { bookId: string; holder: string }) => {
      releaseCalls.push(args);
    }) as unknown as PipelineBookKickoffDeps['releaseLock'],
    loadModelAssignment: (async (role: AgentRole, genre: Genre | null) => {
      loadModelAssignmentCalls.push({ role, genre });
      const map: Record<string, { provider: string; model: string }> = {
        marketer: { provider: 'anthropic', model: 'claude-opus-4-7' },
        writer: { provider: 'anthropic', model: 'claude-opus-4-7' },
        editor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        judge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        thumbnail_text: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        thumbnail_image: { provider: 'openai', model: 'gpt-image-1' },
        optimizer: { provider: 'anthropic', model: 'claude-opus-4-7' },
      };
      const entry = map[role];
      if (!entry) {
        throw new ConfigError(`no test assignment for role=${role}`);
      }
      const result: LoadedAssignment = {
        id: `ma_${role}_${genre ?? 'all'}`,
        provider: entry.provider,
        model: entry.model,
        genre,
      };
      return result;
    }) as unknown as PipelineBookKickoffDeps['loadModelAssignment'],
    loadActivePrompt: (async (role: AgentRole, genre: Genre | null) => {
      loadActivePromptCalls.push({ role, genre });
      const result: LoadedPrompt = {
        template: `prompt body for ${role}`,
        version: 1,
        promptId: `prompt_${role}_${genre ?? 'all'}`,
        genre,
      };
      return result;
    }) as unknown as PipelineBookKickoffDeps['loadActivePrompt'],
    // T-03-11: SSE 進捗配信用 notify は kickoff の正常完了直後に呼ばれる.
    // 本テスト群は notify の中身は別ファイルで検証するため、ここでは noop で握りつぶす.
    notifyJobChange: (async () => ({ ok: true })) as unknown as PipelineBookKickoffDeps['notifyJobChange'],
  };
  return {
    deps: { ...baseDeps, ...overrides },
    acquireCalls,
    releaseCalls,
    loadModelAssignmentCalls,
    loadActivePromptCalls,
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
    return { id: `gworker_${calls.length}` };
  };
  return { addJob, calls };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('pipeline.book.kickoff payload schema', () => {
  it('task identifier が docs/05 §5.3.1 と一致する', () => {
    expect(PIPELINE_BOOK_KICKOFF_TASK_NAME).toBe('pipeline.book.kickoff');
  });

  it('theme_id / account_id / job_id を必須にする', () => {
    expect(
      PipelineBookKickoffPayloadSchema.safeParse({
        theme_id: 't1',
        account_id: 'a1',
        job_id: 'j1',
      }).success,
    ).toBe(true);
    expect(
      PipelineBookKickoffPayloadSchema.safeParse({
        account_id: 'a1',
        job_id: 'j1',
      }).success,
    ).toBe(false);
    expect(
      PipelineBookKickoffPayloadSchema.safeParse({
        theme_id: 't1',
        job_id: 'j1',
      }).success,
    ).toBe(false);
    expect(
      PipelineBookKickoffPayloadSchema.safeParse({
        theme_id: 't1',
        account_id: 'a1',
      }).success,
    ).toBe(false);
  });

  it('overrides は任意で provider/model 必須', () => {
    expect(
      PipelineBookKickoffPayloadSchema.safeParse({
        theme_id: 't1',
        account_id: 'a1',
        job_id: 'j1',
        model_assignment_overrides: {
          writer: { provider: 'google', model: 'gemini-2.5-flash' },
        },
      }).success,
    ).toBe(true);
    expect(
      PipelineBookKickoffPayloadSchema.safeParse({
        theme_id: 't1',
        account_id: 'a1',
        job_id: 'j1',
        model_assignment_overrides: { writer: { provider: '', model: '' } },
      }).success,
    ).toBe(false);
  });
});

describe('runPipelineBookKickoff happy path', () => {
  it('Job CAS → snapshot 確定 → Book INSERT → theme accepted → 子 Job INSERT → addJob → done', async () => {
    const { job, theme } = makeJobAndTheme();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      themes: [theme],
    });
    const {
      deps,
      acquireCalls,
      releaseCalls,
      loadModelAssignmentCalls,
      loadActivePromptCalls,
    } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookKickoff(
      { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    // 1. CAS で running に上がっている
    expect(captures.jobUpdateMany).toHaveLength(1);
    expect(captures.jobUpdateMany[0]?.data).toMatchObject({ status: 'running' });
    expect(captures.jobUpdateMany[0]?.where).toMatchObject({
      id: 'job_1',
      status: { in: ['queued', 'failed'] },
    });

    // 2. loadModelAssignment / loadActivePrompt が 7 役分呼ばれている (genre='business')
    expect(loadModelAssignmentCalls).toHaveLength(7);
    expect(loadActivePromptCalls).toHaveLength(7);
    for (const call of loadModelAssignmentCalls) {
      expect(call.genre).toBe('business');
    }

    // 3. Book.create が snapshot 込みで呼ばれている
    expect(captures.bookCreates).toHaveLength(1);
    const bookData = captures.bookCreates[0]?.data as Record<string, unknown>;
    expect(bookData).toMatchObject({
      account_id: 'acc_1',
      theme_id: 'theme_1',
      title: 'テスト書籍タイトル',
      subtitle: 'テスト副題',
      status: 'queued',
      cost_jpy_total: 0,
    });
    const snapshot = bookData.model_assignment_snapshot as Record<
      string,
      { provider: string; model: string }
    >;
    for (const role of SNAPSHOT_ROLES) {
      expect(snapshot[role]).toEqual(
        expect.objectContaining({
          provider: expect.any(String),
          model: expect.any(String),
        }),
      );
    }
    const promptSnapshot = bookData.prompt_version_ids_json as Record<string, string>;
    for (const role of SNAPSHOT_ROLES) {
      expect(typeof promptSnapshot[role]).toBe('string');
    }

    // 4. BookLock 取得 (holder=pipeline:<job_id>)
    expect(acquireCalls).toEqual([
      { bookId: 'book_new_1', holder: 'pipeline:job_1', ttlMinutes: 30 },
    ]);

    // 5. ThemeCandidate.status='accepted' へ遷移
    expect(captures.themeUpdates).toHaveLength(1);
    expect(captures.themeUpdates[0]?.where).toEqual({ id: 'theme_1' });
    expect(captures.themeUpdates[0]?.data).toMatchObject({ status: 'accepted' });

    // 6. 子 Job (pipeline.book.marketer) INSERT
    expect(captures.jobCreates).toHaveLength(1);
    expect(captures.jobCreates[0]?.data).toMatchObject({
      kind: 'pipeline.book.marketer',
      book_id: 'book_new_1',
      parent_job_id: 'job_1',
      status: 'queued',
      payload_json: { book_id: 'book_new_1' },
    });

    // 7. addJob (graphile-worker) の payload に子 Job.id が乗っている
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('pipeline.book.marketer');
    expect(addJobCalls[0]?.payload).toEqual({
      book_id: 'book_new_1',
      job_id: 'child_marketer_1',
    });

    // 8. kickoff Job を done に遷移
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.data).toMatchObject({
      status: 'done',
      result_json: { book_id: 'book_new_1', marketer_job_id: 'child_marketer_1' },
    });

    // 9. lock release は finally で必ず実行
    expect(releaseCalls).toEqual([{ bookId: 'book_new_1', holder: 'pipeline:job_1' }]);
  });

  it('model_assignment_overrides が指定された役は loadModelAssignment を呼ばず override 値を採用する', async () => {
    const { job, theme } = makeJobAndTheme();
    const { prisma, captures } = buildPrisma({ jobs: [job], themes: [theme] });
    const { deps, loadModelAssignmentCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookKickoff(
      {
        theme_id: 'theme_1',
        account_id: 'acc_1',
        job_id: 'job_1',
        model_assignment_overrides: {
          writer: { provider: 'google', model: 'gemini-2.5-flash' },
        },
      },
      addJob,
      deps,
    );

    // writer は loadModelAssignment 呼ばれず、他 6 役のみ
    expect(loadModelAssignmentCalls).toHaveLength(6);
    expect(loadModelAssignmentCalls.find((c) => c.role === 'writer')).toBeUndefined();

    const snapshot = (captures.bookCreates[0]?.data as Record<string, unknown>)
      .model_assignment_snapshot as Record<string, { provider: string; model: string }>;
    expect(snapshot.writer).toEqual({ provider: 'google', model: 'gemini-2.5-flash' });
  });

  it('batch_plan_item_id が指定されたら BatchPlanItem.book_id を更新する', async () => {
    const { job, theme } = makeJobAndTheme();
    const { prisma, captures } = buildPrisma({ jobs: [job], themes: [theme] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookKickoff(
      {
        theme_id: 'theme_1',
        account_id: 'acc_1',
        job_id: 'job_1',
        batch_plan_item_id: 'bpi_1',
      },
      addJob,
      deps,
    );

    expect(captures.batchPlanItemUpdates).toHaveLength(1);
    expect(captures.batchPlanItemUpdates[0]?.where).toEqual({ id: 'bpi_1' });
    expect(captures.batchPlanItemUpdates[0]?.data).toMatchObject({
      book_id: 'book_new_1',
      status: 'kicked',
    });
  });

  it('genre が不明値 (DB 揺れ) なら null fallback で loadModelAssignment / loadActivePrompt を呼ぶ', async () => {
    const { job, theme } = makeJobAndTheme();
    theme.genre = 'unknown_genre';
    const { prisma } = buildPrisma({ jobs: [job], themes: [theme] });
    const { deps, loadModelAssignmentCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookKickoff(
      { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    for (const c of loadModelAssignmentCalls) {
      expect(c.genre).toBeNull();
    }
  });
});

describe('runPipelineBookKickoff idempotency', () => {
  it('Job.status === done なら早期 return (Book 重複作成しない)', async () => {
    const { job, theme } = makeJobAndTheme({ jobStatus: 'done' });
    const { prisma, captures } = buildPrisma({ jobs: [job], themes: [theme] });
    const { deps, acquireCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookKickoff(
      { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    expect(captures.jobUpdateMany).toHaveLength(0);
    expect(captures.bookCreates).toHaveLength(0);
    expect(captures.jobCreates).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
  });

  it('CAS で count=0 (他 worker が running 化) なら Book 作成せず skip', async () => {
    const { job, theme } = makeJobAndTheme({ jobStatus: 'running' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      themes: [theme],
      forceUpdateManyCount: 0,
    });
    const { deps, acquireCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookKickoff(
      { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    expect(captures.bookCreates).toHaveLength(0);
    expect(captures.jobCreates).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
  });

  it('Job.book_id が既に紐付いている再実行では既存 Book を流用し snapshot を再生成しない', async () => {
    const { job, theme } = makeJobAndTheme({ bookId: 'book_existing_1' });
    job.status = 'failed'; // 1 度 failed したのを retry
    const existingBook: BookRecord = {
      id: 'book_existing_1',
      account_id: 'acc_1',
      theme_id: 'theme_1',
      title: 'テスト書籍タイトル',
      subtitle: 'テスト副題',
    };
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      themes: [theme],
      books: [existingBook],
    });
    const { deps, loadModelAssignmentCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookKickoff(
      { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    // Book.create 呼ばれない
    expect(captures.bookCreates).toHaveLength(0);
    // snapshot を作るために loadModelAssignment / loadActivePrompt も呼ばれない
    expect(loadModelAssignmentCalls).toHaveLength(0);

    // 子 enqueue は既存 book で行われている
    expect(captures.jobCreates).toHaveLength(1);
    expect(captures.jobCreates[0]?.data).toMatchObject({
      kind: 'pipeline.book.marketer',
      book_id: 'book_existing_1',
      parent_job_id: 'job_1',
    });
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.payload).toEqual({
      book_id: 'book_existing_1',
      job_id: 'child_marketer_1',
    });
  });

  it('Book.create 成功 → acquireLock ConflictError → retry で Book を流用 (重複作成しない)', async () => {
    // 1 回目: acquireLock が ConflictError → Job=failed 降格 + throw。
    //         Book.create は直前に成功しており、Job.book_id 確定済 (docs/05 §13 #5)。
    // 2 回目: 同じ jobId で再実行 → existingJob.book_id 経由で Book を流用 → Book.create 呼ばれない。
    const { ConflictError } = await import('@a2p/contracts/errors');
    const { job, theme } = makeJobAndTheme();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      themes: [theme],
    });
    const { deps } = buildDeps(prisma, {});
    // acquireLock は 1 回目だけ ConflictError、2 回目以降は成功
    const acquireCalls: Array<{ bookId: string; holder: string }> = [];
    let acquireAttempt = 0;
    deps.acquireLock = (async (args: { bookId: string; holder: string }) => {
      acquireAttempt += 1;
      acquireCalls.push(args);
      if (acquireAttempt === 1) {
        throw new ConflictError('book_locked', {
          details: { bookId: args.bookId },
        });
      }
      return {
        book_id: args.bookId,
        holder: args.holder,
        acquired_at: new Date('2026-05-23T00:00:00Z'),
        expires_at: new Date('2026-05-23T00:30:00Z'),
      };
    }) as unknown as typeof deps.acquireLock;
    const { addJob, calls: addJobCalls } = makeAddJob();

    // 1 回目: throw 期待
    await expect(
      runPipelineBookKickoff(
        { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toThrow();

    // Book.create は 1 回呼ばれた (snapshot 確定 + INSERT)
    expect(captures.bookCreates).toHaveLength(1);
    // Job.book_id が確定している (mock の job.update が反映している)
    expect(job.book_id).toBe('book_new_1');
    // Job は failed に降格
    expect(job.status).toBe('failed');

    // 2 回目: 同じ jobId で再実行 → 成功期待 (acquire は 2 回目で成功)
    await runPipelineBookKickoff(
      { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    // Book.create は累計 1 回のまま (重複作成しない)
    expect(captures.bookCreates).toHaveLength(1);
    // 子 Job INSERT は 2 回目で 1 回呼ばれた (1 回目は acquire 前で未到達)
    expect(captures.jobCreates).toHaveLength(1);
    expect(captures.jobCreates[0]?.data).toMatchObject({
      kind: 'pipeline.book.marketer',
      book_id: 'book_new_1',
      parent_job_id: 'job_1',
    });
    // addJob は 2 回目で 1 回呼ばれた
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.payload).toEqual({
      book_id: 'book_new_1',
      job_id: 'child_marketer_1',
    });
    // acquireLock は 2 回試行された
    expect(acquireCalls).toHaveLength(2);
  });
});

describe('runPipelineBookKickoff error paths', () => {
  it('payload zod 違反 → ValidationError (A2PError 派生)', async () => {
    const { prisma } = buildPrisma({ jobs: [], themes: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(runPipelineBookKickoff({}, addJob, deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(runPipelineBookKickoff({}, addJob, deps)).rejects.toBeInstanceOf(
      A2PError,
    );
  });

  it('Job が存在しない → NotFoundError, BookLock 取らない', async () => {
    const { prisma } = buildPrisma({ jobs: [], themes: [] });
    const { deps, acquireCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookKickoff(
        { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_missing' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(acquireCalls).toHaveLength(0);
  });

  it('ThemeCandidate が存在しない → NotFoundError, Book 作成しない, Job=failed', async () => {
    const { job } = makeJobAndTheme();
    const { prisma, captures } = buildPrisma({ jobs: [job], themes: [] });
    const { deps, acquireCalls, releaseCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookKickoff(
        { theme_id: 'theme_missing', account_id: 'acc_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(captures.bookCreates).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0); // lock 取得前
    expect(releaseCalls).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    // CAS 後の失敗 → Job=failed 降格
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('loadModelAssignment が ConfigError throw (役の active 行欠落) → 透過, Book 作成せず Job=failed', async () => {
    const { job, theme } = makeJobAndTheme();
    const { prisma, captures } = buildPrisma({ jobs: [job], themes: [theme] });
    const cfgErr = new ConfigError('no active ModelAssignment for role=judge genre=business');
    let callCount = 0;
    const { deps, acquireCalls } = buildDeps(prisma, {
      loadModelAssignment: (async () => {
        callCount += 1;
        if (callCount >= 4) throw cfgErr; // 4 役目で fail
        return {
          id: 'ma_x',
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          genre: 'business',
        };
      }) as unknown as PipelineBookKickoffDeps['loadModelAssignment'],
    });
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookKickoff(
        { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(cfgErr);

    expect(captures.bookCreates).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Book.create 失敗 → 透過, Job=failed, lock 取らないので release もなし', async () => {
    const { job, theme } = makeJobAndTheme();
    const dbErr = new Error('book.create db error');
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      themes: [theme],
      bookCreateThrow: dbErr,
    });
    const { deps, acquireCalls, releaseCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookKickoff(
        { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(dbErr);

    expect(acquireCalls).toHaveLength(0);
    expect(releaseCalls).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('acquireBookLock が ConflictError throw → 透過 (graphile-worker retry), Book は作成済だが Job=failed', async () => {
    const { job, theme } = makeJobAndTheme();
    const { prisma, captures } = buildPrisma({ jobs: [job], themes: [theme] });
    const lockErr = new ConflictError('book locked', { details: { bookId: 'book_new_1' } });
    const { deps, releaseCalls } = buildDeps(prisma, {
      acquireLock: (async () => {
        throw lockErr;
      }) as unknown as PipelineBookKickoffDeps['acquireLock'],
    });
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookKickoff(
        { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(lockErr);

    expect(captures.bookCreates).toHaveLength(1);
    expect(addJobCalls).toHaveLength(0);
    // lock 取れていないので release されない
    expect(releaseCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('子 Job INSERT が失敗 → 透過, Job=failed, lock は release される', async () => {
    const { job, theme } = makeJobAndTheme();
    const childErr = new Error('child job insert failed');
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      themes: [theme],
      childJobCreateThrow: childErr,
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookKickoff(
        { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(childErr);

    expect(captures.bookCreates).toHaveLength(1);
    expect(addJobCalls).toHaveLength(0);
    // lock は release される
    expect(releaseCalls).toHaveLength(1);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });
});

describe('runPipelineBookKickoff snapshot completeness', () => {
  it('model_assignment_snapshot に SNAPSHOT_ROLES の 7 役が全て含まれる', async () => {
    const { job, theme } = makeJobAndTheme();
    const { prisma, captures } = buildPrisma({ jobs: [job], themes: [theme] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookKickoff(
      { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    const snapshot = (captures.bookCreates[0]?.data as Record<string, unknown>)
      .model_assignment_snapshot as Record<string, unknown>;
    const promptSnapshot = (captures.bookCreates[0]?.data as Record<string, unknown>)
      .prompt_version_ids_json as Record<string, unknown>;

    for (const role of SNAPSHOT_ROLES) {
      expect(snapshot).toHaveProperty(role);
      expect(promptSnapshot).toHaveProperty(role);
    }
    expect(Object.keys(snapshot)).toHaveLength(SNAPSHOT_ROLES.length);
    expect(Object.keys(promptSnapshot)).toHaveLength(SNAPSHOT_ROLES.length);
  });
});

describe('runPipelineBookKickoff A/B distribution (T-11-06)', () => {
  it('ab_distribution_json に設定あり + rand 固定 → candidate/baseline が prompt_version_ids_json に反映される', async () => {
    const { job, theme } = makeJobAndTheme(); // genre='business'
    const abDistributionJson = [
      {
        role: 'writer',
        genre: 'business',
        baseline_id: 'prompt_baseline_writer',
        candidate_id: 'prompt_candidate_writer',
        ratio_candidate: 0.5,
      },
      {
        role: 'editor',
        genre: 'business',
        baseline_id: 'prompt_baseline_editor',
        candidate_id: 'prompt_candidate_editor',
        ratio_candidate: 0.5,
      },
    ];
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      themes: [theme],
      abDistributionJson,
    });

    // rand=0.3 < ratio_candidate(0.5) → candidate; rand=0.7 >= 0.5 → baseline
    let callCount = 0;
    const randValues = [0.3, 0.7]; // writer→candidate, editor→baseline
    const { deps } = buildDeps(prisma, {
      rand: () => {
        const v = randValues[callCount % randValues.length] ?? 0.5;
        callCount += 1;
        return v;
      },
    });
    const { addJob } = makeAddJob();

    await runPipelineBookKickoff(
      { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    const promptSnapshot = (captures.bookCreates[0]?.data as Record<string, unknown>)
      .prompt_version_ids_json as Record<string, string>;

    // writer: rand=0.3 < 0.5 → candidate
    expect(promptSnapshot['writer']).toBe('prompt_candidate_writer');
    // editor: rand=0.7 >= 0.5 → baseline
    expect(promptSnapshot['editor']).toBe('prompt_baseline_editor');
    // その他の role は loadActivePrompt が返す既定値のまま
    expect(promptSnapshot['marketer']).toBe('prompt_marketer_business');
  });

  it('genre=null book: ab_distribution_json の "default" キーと往復一致し A/B 配信が適用される', async () => {
    /**
     * 往復テスト: genre=null ThemeCandidate → normalizeAbGenre(null)='default' として
     * ab_distribution_json の genre='default' エントリと一致し、A/B 配信が適用される。
     * seed.ts の全 genre=null プロンプトが対象になるケースをカバー。
     */
    const { job, theme } = makeJobAndTheme();
    // ThemeCandidate.genre を未知値（→ Genre=null）に設定
    theme.genre = 'unknown_genre_for_null_test';

    // 保存キー = 'default'（normalizeAbGenre(null) の結果）
    const abDistributionJson = [
      {
        role: 'writer',
        genre: 'default',
        baseline_id: 'prompt_baseline_writer_default',
        candidate_id: 'prompt_candidate_writer_default',
        ratio_candidate: 0.5,
      },
    ];
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      themes: [theme],
      abDistributionJson,
    });

    // rand=0.3 < 0.5 → candidate
    const { deps } = buildDeps(prisma, { rand: () => 0.3 });
    const { addJob } = makeAddJob();

    await runPipelineBookKickoff(
      { theme_id: 'theme_1', account_id: 'acc_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    const promptSnapshot = (captures.bookCreates[0]?.data as Record<string, unknown>)
      .prompt_version_ids_json as Record<string, string>;

    // genre=null → 'default' で照合 → A/B 配信が適用されている
    expect(promptSnapshot['writer']).toBe('prompt_candidate_writer_default');
    // 他の role は active prompt のまま (genre=null → loadActivePrompt(role, null))
    expect(promptSnapshot['marketer']).toBe('prompt_marketer_all');
  });
});
