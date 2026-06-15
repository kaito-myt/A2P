import { describe, expect, it, vi } from 'vitest';

import {
  A2PError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { EditorOutput } from '@a2p/contracts/agents/editor';

import {
  PIPELINE_BOOK_EDITOR_TASK_NAME,
  PipelineBookEditorPayloadSchema,
  runPipelineBookEditor,
  type AddJobLike,
  type PipelineBookEditorDeps,
  type PipelineBookEditorPrisma,
  type PipelineBookEditorTxClient,
} from '../src/tasks/pipeline-book-editor.js';

// ---------------------------------------------------------------------------
// テスト用ファクトリ (pipeline-book-writer-outline.test.ts と同形)
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

interface ChapterRecord {
  id: string;
  book_id: string;
  index: number;
  heading: string;
  body_md: string;
  version: number;
}

interface ChapterRevisionRecord {
  id: string;
  chapter_id: string;
  book_id: string;
  version: number;
  body_md: string;
  reason: string;
}

interface AppSettingsRecord {
  id: string;
  ai_disclosure_text: string;
}

interface PrismaCaptures {
  jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobUpdateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  jobCreates: Array<{ data: Record<string, unknown> }>;
  jobFindFirstCalls: Array<{ where: Record<string, unknown> }>;
  revisionCreates: Array<{ data: Record<string, unknown> }>;
  chapterUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  txCalls: number;
  executeRawCalls: Array<{ sql: string; values: unknown[] }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  books: BookRecord[];
  themes: ThemeRecord[];
  chapters: ChapterRecord[];
  appSettings?: AppSettingsRecord | null;
  /** updateMany が返す count を強制 (CAS 失敗テスト用). */
  forceUpdateManyCount?: number;
  /** 既存 thumbnail Job を返すモード (重複 enqueue 抑止テスト). */
  existingThumbnailJob?: { id: string } | null;
  /** $executeRawUnsafe を強制失敗 (notify 失敗の検証). */
  executeRawThrow?: Error;
  /** Chapter.findMany を強制空配列で返す. */
  forceEmptyChapters?: boolean;
  /** Transaction 内の chapterRevision.create を強制失敗. */
  revisionCreateThrow?: Error;
  /** Transaction 内の chapter.update を強制失敗. */
  chapterUpdateThrow?: Error;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineBookEditorPrisma;
  captures: PrismaCaptures;
  state: {
    chapters: ChapterRecord[];
    chapterRevisions: ChapterRevisionRecord[];
    jobs: JobRecord[];
  };
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    jobCreates: [],
    jobFindFirstCalls: [],
    revisionCreates: [],
    chapterUpdates: [],
    txCalls: 0,
    executeRawCalls: [],
  };
  const jobs = [...args.jobs];
  const chapters: ChapterRecord[] = [...args.chapters];
  const chapterRevisions: ChapterRevisionRecord[] = [];
  let jobCreateCounter = 0;
  let revisionCounter = 0;

  const txClient: PipelineBookEditorTxClient = {
    chapterRevision: {
      create: async ({ data }) => {
        if (args.revisionCreateThrow) throw args.revisionCreateThrow;
        captures.revisionCreates.push({
          data: data as unknown as Record<string, unknown>,
        });
        revisionCounter += 1;
        const id = `rev_${revisionCounter}`;
        chapterRevisions.push({
          id,
          chapter_id: data.chapter_id,
          book_id: data.book_id,
          version: data.version,
          body_md: data.body_md,
          reason: data.reason,
        });
        return { id };
      },
    },
    chapter: {
      update: async ({ where, data }) => {
        if (args.chapterUpdateThrow) throw args.chapterUpdateThrow;
        captures.chapterUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        const ch = chapters.find((c) => c.id === where.id);
        if (ch) {
          ch.body_md = data.body_md as string;
          ch.version = data.version as number;
        }
        return { id: where.id };
      },
    },
  };

  const prisma: PipelineBookEditorPrisma = {
    $executeRawUnsafe: async (sql, ...values) => {
      captures.executeRawCalls.push({ sql, values });
      if (args.executeRawThrow) throw args.executeRawThrow;
      return 1;
    },
    $transaction: async (fn) => {
      captures.txCalls += 1;
      return fn(txClient);
    },
    job: {
      findUnique: async ({ where }) => {
        const j = jobs.find((x) => x.id === where.id);
        return j ? { status: j.status, book_id: j.book_id } : null;
      },
      findFirst: async ({ where }) => {
        captures.jobFindFirstCalls.push({
          where: where as unknown as Record<string, unknown>,
        });
        if (args.existingThumbnailJob !== undefined) {
          return args.existingThumbnailJob;
        }
        const w = where as {
          book_id: string;
          kind: string;
          status: { in: string[] };
        };
        const found = jobs.find(
          (j) =>
            j.book_id === w.book_id &&
            (j.kind ?? '') === w.kind &&
            w.status.in.includes(j.status),
        );
        return found ? { id: found.id } : null;
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
        const id = `thumbnail_job_${jobCreateCounter}`;
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
    chapter: {
      findMany: async ({ where }) => {
        if (args.forceEmptyChapters) return [];
        return chapters
          .filter((c) => c.book_id === where.book_id)
          .sort((a, b) => a.index - b.index)
          .map((c) => ({
            id: c.id,
            index: c.index,
            heading: c.heading,
            body_md: c.body_md,
            version: c.version,
          }));
      },
    },
    appSettings: {
      findUnique: async () => {
        if (args.appSettings === null) return null;
        if (args.appSettings === undefined) {
          return { ai_disclosure_text: '本書は生成 AI で作成されました。' };
        }
        return { ai_disclosure_text: args.appSettings.ai_disclosure_text };
      },
    },
  };
  return { prisma, captures, state: { chapters, chapterRevisions, jobs } };
}

function makeEditorOutput(chapters: ChapterRecord[]): EditorOutput {
  return {
    chapters: chapters.map((c) => ({
      index: c.index,
      heading: c.heading,
      body_md: '(校閲後) ' + c.body_md, // 旧との差分があるとわかりやすく
      diff_summary: `第${c.index}章で表記ゆれを統一`,
    })),
    ai_disclosure_appended: true,
    ai_disclosure_text: '本書は生成 AI で作成されました。',
    overall_notes: '全体的に文体を統一しました。',
  };
}

function makeChapters(n: number, bookId = 'book_1'): ChapterRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ch_${i + 1}`,
    book_id: bookId,
    index: i + 1,
    heading: `第${i + 1}章: タイトル`,
    body_md: 'これは執筆済みの章本文です。'.repeat(300), // ~3600 文字
    version: 1,
  }));
}

function makeJobBookThemeChapters(opts?: {
  jobStatus?: string;
  chapterCount?: number;
}): {
  job: JobRecord;
  book: BookRecord;
  theme: ThemeRecord;
  chapters: ChapterRecord[];
} {
  const n = opts?.chapterCount ?? 7;
  const job: JobRecord = {
    id: 'job_editor_1',
    status: opts?.jobStatus ?? 'queued',
    book_id: 'book_1',
    kind: 'pipeline.book.editor',
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
  const chapters = makeChapters(n, 'book_1');
  return { job, book, theme, chapters };
}

function buildDeps(
  prisma: PipelineBookEditorPrisma,
  overrides: Partial<PipelineBookEditorDeps> = {},
): {
  deps: PipelineBookEditorDeps;
  acquireCalls: Array<{ bookId: string; holder: string; ttlMinutes?: number }>;
  releaseCalls: Array<{ bookId: string; holder: string }>;
  editCalls: Array<unknown>;
  notifyCalls: Array<{ payload: unknown }>;
  loggerCalls: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
} {
  const { logger, calls: loggerCalls } = makeLogger();
  const acquireCalls: Array<{ bookId: string; holder: string; ttlMinutes?: number }> = [];
  const releaseCalls: Array<{ bookId: string; holder: string }> = [];
  const editCalls: Array<unknown> = [];
  const notifyCalls: Array<{ payload: unknown }> = [];

  const baseDeps: PipelineBookEditorDeps = {
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
    }) as unknown as PipelineBookEditorDeps['acquireLock'],
    releaseLock: (async (args: { bookId: string; holder: string }) => {
      releaseCalls.push(args);
    }) as unknown as PipelineBookEditorDeps['releaseLock'],
    editBook: (async (input: unknown) => {
      editCalls.push(input);
      const inp = input as {
        chapters: Array<{ index: number; heading: string; body_md: string }>;
      };
      return makeEditorOutput(
        inp.chapters.map((c) => ({
          id: `ch_${c.index}`,
          book_id: 'book_1',
          index: c.index,
          heading: c.heading,
          body_md: c.body_md,
          version: 1,
        })),
      );
    }) as unknown as PipelineBookEditorDeps['editBook'],
    notifyJobChange: (async (payload: unknown) => {
      notifyCalls.push({ payload });
      return { ok: true };
    }) as unknown as PipelineBookEditorDeps['notifyJobChange'],
  };
  return {
    deps: { ...baseDeps, ...overrides },
    acquireCalls,
    releaseCalls,
    editCalls,
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

describe('pipeline.book.editor payload schema', () => {
  it('task identifier が docs/05 §5.3.5 と一致する', () => {
    expect(PIPELINE_BOOK_EDITOR_TASK_NAME).toBe('pipeline.book.editor');
  });

  it('book_id / job_id を必須', () => {
    expect(
      PipelineBookEditorPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
      }).success,
    ).toBe(true);
    expect(
      PipelineBookEditorPayloadSchema.safeParse({ book_id: 'b1' }).success,
    ).toBe(false);
    expect(
      PipelineBookEditorPayloadSchema.safeParse({ job_id: 'j1' }).success,
    ).toBe(false);
  });

  it('feedback は任意で priority enum を要求', () => {
    expect(
      PipelineBookEditorPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
        feedback: [{ body: 'コメント', priority: 'must' }],
      }).success,
    ).toBe(true);
    expect(
      PipelineBookEditorPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
        feedback: [{ body: 'x', priority: 'invalid' }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

describe('runPipelineBookEditor happy path', () => {
  it('7 章を校閲 → ChapterRevision 7 件 + Chapter 7 件 update(version=2) + thumbnail enqueue + Job done + notify', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters({ chapterCount: 7 });
    const { prisma, captures, state } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
    });
    const { deps, acquireCalls, releaseCalls, editCalls, notifyCalls } =
      buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookEditor(
      { book_id: 'book_1', job_id: 'job_editor_1' },
      addJob,
      deps,
    );

    // CAS
    expect(captures.jobUpdateMany).toHaveLength(1);
    expect(captures.jobUpdateMany[0]?.data).toMatchObject({ status: 'running' });

    // BookLock acquire/release
    expect(acquireCalls).toEqual([
      { bookId: 'book_1', holder: 'pipeline:job_editor_1', ttlMinutes: 30 },
    ]);
    expect(releaseCalls).toEqual([
      { bookId: 'book_1', holder: 'pipeline:job_editor_1' },
    ]);

    // editBook 呼出
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]).toMatchObject({
      jobId: 'job_editor_1',
      bookId: 'book_1',
      accountId: 'acc_1',
      genre: 'business',
      aiDisclosureText: '本書は生成 AI で作成されました。',
      themeContext: {
        title: 'テスト書籍タイトル',
        subtitle: 'テスト副題',
        hook: '実例と数値で語る差別化フック',
        target_reader: '副業を考えている 30-40 代会社員',
      },
    });
    const editInputChapters = (
      editCalls[0] as { chapters: Array<{ index: number }> }
    ).chapters;
    expect(editInputChapters).toHaveLength(7);
    expect(editInputChapters.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // ChapterRevision 7 件 + Chapter 7 件 update + tx 7 回
    expect(captures.txCalls).toBe(7);
    expect(captures.revisionCreates).toHaveLength(7);
    expect(captures.chapterUpdates).toHaveLength(7);

    // 各 revision は旧 version=1, 旧 body_md を退避
    captures.revisionCreates.forEach((r, i) => {
      expect(r.data).toMatchObject({
        chapter_id: `ch_${i + 1}`,
        book_id: 'book_1',
        version: 1,
        reason: 'editor:job_editor_1',
      });
      expect(typeof r.data.body_md).toBe('string');
    });

    // 各 chapter は version=2 + 校閲後 body_md
    captures.chapterUpdates.forEach((u, i) => {
      expect(u.where).toEqual({ id: `ch_${i + 1}` });
      expect(u.data).toMatchObject({ version: 2 });
      expect(u.data.body_md as string).toContain('(校閲後)');
    });
    // 状態確認: chapter.version=2 になっている
    state.chapters.forEach((c) => {
      expect(c.version).toBe(2);
    });

    // thumbnail.text enqueue
    expect(captures.jobCreates).toHaveLength(1);
    expect(captures.jobCreates[0]?.data).toMatchObject({
      kind: 'pipeline.book.thumbnail.text',
      book_id: 'book_1',
      parent_job_id: 'job_editor_1',
      status: 'queued',
      payload_json: { book_id: 'book_1' },
    });
    expect(addJobCalls).toHaveLength(2);
    expect(addJobCalls[0]?.identifier).toBe('pipeline.book.thumbnail.text');
    expect(addJobCalls[0]?.payload).toMatchObject({
      book_id: 'book_1',
      job_id: 'thumbnail_job_1',
    });
    // cost check enqueue (F-034 / T-07-02)
    expect(addJobCalls[1]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[1]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    // Job done + result_json
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.data).toMatchObject({
      status: 'done',
      result_json: {
        revisions_count: 7,
        ai_disclosure_appended: true,
        thumbnail_text_job_id: 'thumbnail_job_1',
      },
    });

    // notify phase=editor_done
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.payload).toMatchObject({
      jobId: 'job_editor_1',
      status: 'done',
      kind: 'pipeline.book.editor',
      bookId: 'book_1',
      phase: 'editor_done',
    });
  });

  it('既存 thumbnail.text Job が存在 → 重複 enqueue しない (thumbnail_text_job_id=null)', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters({ chapterCount: 7 });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
      existingThumbnailJob: { id: 'thumbnail_existing' },
    });
    const { deps, loggerCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookEditor(
      { book_id: 'book_1', job_id: 'job_editor_1' },
      addJob,
      deps,
    );

    expect(captures.jobCreates).toHaveLength(0);
    // cost check enqueue only (F-034 / T-07-02), thumbnail skipped
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[0]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall?.data).toMatchObject({
      result_json: {
        revisions_count: 7,
        thumbnail_text_job_id: null,
      },
    });

    const skipLog = loggerCalls.find((c) =>
      c.msg.includes('thumbnail.text Job already enqueued'),
    );
    expect(skipLog).toBeDefined();
  });

  it('feedback を editBook へ forward', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters({ chapterCount: 7 });
    const { prisma } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
    });
    const { deps, editCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookEditor(
      {
        book_id: 'book_1',
        job_id: 'job_editor_1',
        feedback: [
          { body: '導入を 1 段短く', priority: 'must' },
          { body: '結論を強める', priority: 'should' },
        ],
      },
      addJob,
      deps,
    );

    expect(editCalls).toHaveLength(1);
    expect((editCalls[0] as { feedback?: unknown }).feedback).toEqual([
      { body: '導入を 1 段短く', priority: 'must' },
      { body: '結論を強める', priority: 'should' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

describe('runPipelineBookEditor idempotency', () => {
  it('Job.status === done なら早期 return (no lock / no editBook / no notify)', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters({ jobStatus: 'done' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
    });
    const { deps, acquireCalls, editCalls, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookEditor(
      { book_id: 'book_1', job_id: 'job_editor_1' },
      addJob,
      deps,
    );

    expect(captures.jobUpdateMany).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(editCalls).toHaveLength(0);
    expect(captures.revisionCreates).toHaveLength(0);
    expect(captures.chapterUpdates).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
  });

  it('CAS で count=0 (他 worker が先取り) なら skip', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters({
      jobStatus: 'running',
    });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
      forceUpdateManyCount: 0,
    });
    const { deps, acquireCalls, editCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookEditor(
      { book_id: 'book_1', job_id: 'job_editor_1' },
      addJob,
      deps,
    );

    expect(captures.revisionCreates).toHaveLength(0);
    expect(captures.chapterUpdates).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(editCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

describe('runPipelineBookEditor error paths', () => {
  it('payload zod 違反 → ValidationError (A2PError 派生)', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [], chapters: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(runPipelineBookEditor({}, addJob, deps)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(runPipelineBookEditor({}, addJob, deps)).rejects.toBeInstanceOf(
      A2PError,
    );
  });

  it('Job 不在 → NotFoundError (CAS 前)', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [], chapters: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookEditor(
        { book_id: 'book_1', job_id: 'job_missing' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('Book 不在 → NotFoundError, Job=failed, lock released', async () => {
    const { job, theme, chapters } = makeJobBookThemeChapters();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [],
      themes: [theme],
      chapters,
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookEditor(
        { book_id: 'book_1', job_id: 'job_editor_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect(releaseCalls).toHaveLength(1); // finally で release
  });

  it('Chapter 0 件 (writer.chapter 未実行) → NotFoundError, Job=failed', async () => {
    const { job, book, theme } = makeJobBookThemeChapters();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters: [],
      forceEmptyChapters: true,
    });
    const { deps, editCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookEditor(
        { book_id: 'book_1', job_id: 'job_editor_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(editCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('AppSettings 行不在 → NotFoundError, Job=failed', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
      appSettings: null,
    });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookEditor(
        { book_id: 'book_1', job_id: 'job_editor_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('ai_disclosure_text 空文字 → ValidationError, Job=failed (R-05 違反防止)', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
      appSettings: { id: 'singleton', ai_disclosure_text: '   ' },
    });
    const { deps, editCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookEditor(
        { book_id: 'book_1', job_id: 'job_editor_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(editCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('editBook throw → 透過, Job failed, ChapterRevision 0 件', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
    });
    const boom = new Error('boom from editBook');
    const { deps, releaseCalls } = buildDeps(prisma, {
      editBook: (async () => {
        throw boom;
      }) as unknown as PipelineBookEditorDeps['editBook'],
    });
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookEditor(
        { book_id: 'book_1', job_id: 'job_editor_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(boom);

    expect(captures.revisionCreates).toHaveLength(0);
    expect(captures.chapterUpdates).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect((failedCall?.data.error as string).includes('boom from editBook')).toBe(
      true,
    );
    expect(releaseCalls).toHaveLength(1); // finally で release
  });

  it('transaction 内 ChapterRevision.create 失敗 → 透過 throw, Job=failed', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters();
    const txBoom = new Error('rev insert failed');
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
      revisionCreateThrow: txBoom,
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookEditor(
        { book_id: 'book_1', job_id: 'job_editor_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(txBoom);

    // 1 章目で失敗 → revision 0 件 (tx は throw でロールバック相当扱い、本テストの mock では state も更新されない)
    expect(captures.revisionCreates).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect(releaseCalls).toHaveLength(1);
  });

  it('transaction 内 Chapter.update 失敗 → 透過 throw, Job=failed', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters();
    const updBoom = new Error('chapter update failed');
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
      chapterUpdateThrow: updBoom,
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookEditor(
        { book_id: 'book_1', job_id: 'job_editor_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(updBoom);

    expect(captures.chapterUpdates).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect(releaseCalls).toHaveLength(1);
  });

  it('BookLock acquire 失敗 (ConflictError) → Job=failed + 透過 throw, editBook 未呼出', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
    });
    const conflict = new ConflictError('book locked');
    const { deps, editCalls, releaseCalls } = buildDeps(prisma, {
      acquireLock: (async () => {
        throw conflict;
      }) as unknown as PipelineBookEditorDeps['acquireLock'],
    });
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookEditor(
        { book_id: 'book_1', job_id: 'job_editor_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(conflict);

    expect(editCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    // acquire 失敗時は finally 入らない (try 前で throw) → releaseLock は呼ばれない
    expect(releaseCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// notify 失敗時の warn 継続
// ---------------------------------------------------------------------------

describe('runPipelineBookEditor notify failure', () => {
  it('notifyJobChange が ok=false でも本処理は完走 (Job=done のまま)', async () => {
    const { job, book, theme, chapters } = makeJobBookThemeChapters();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
    });
    const { deps, notifyCalls } = buildDeps(prisma, {
      notifyJobChange: (async (payload: unknown) => {
        notifyCallsLocal.push({ payload });
        return { ok: false };
      }) as unknown as PipelineBookEditorDeps['notifyJobChange'],
    });
    const notifyCallsLocal: Array<{ payload: unknown }> = [];
    const { addJob } = makeAddJob();

    await runPipelineBookEditor(
      { book_id: 'book_1', job_id: 'job_editor_1' },
      addJob,
      deps,
    );

    // notifyCalls 配列は buildDeps の default は使わず override 経由なので未使用
    void notifyCalls;
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.data).toMatchObject({ status: 'done' });
    expect(notifyCallsLocal).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ChapterRevision の version_from / version_to が正しい (旧 version 退避)
// ---------------------------------------------------------------------------

describe('runPipelineBookEditor revision version semantics', () => {
  it('旧 version=N で ChapterRevision 退避 + Chapter.version=N+1 に bump', async () => {
    const { job, book, theme } = makeJobBookThemeChapters();
    // すでに 2 回校閲済 (version=3) の章を 4 に上げる ケース
    const chapters: ChapterRecord[] = [
      {
        id: 'ch_1',
        book_id: 'book_1',
        index: 1,
        heading: '第1章: 旧タイトル',
        body_md: '校閲前の本文'.repeat(300),
        version: 3,
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `ch_${i + 2}`,
        book_id: 'book_1',
        index: i + 2,
        heading: `第${i + 2}章: タイトル`,
        body_md: '別の本文'.repeat(300),
        version: 1,
      })),
    ];
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
    });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookEditor(
      { book_id: 'book_1', job_id: 'job_editor_1' },
      addJob,
      deps,
    );

    // 第 1 章 revision は version=3 (旧)、Chapter.update は version=4 (新)
    const rev1 = captures.revisionCreates.find(
      (r) => r.data.chapter_id === 'ch_1',
    );
    expect(rev1?.data).toMatchObject({
      chapter_id: 'ch_1',
      version: 3,
      reason: 'editor:job_editor_1',
    });
    expect(rev1?.data.body_md as string).toContain('校閲前の本文');

    const upd1 = captures.chapterUpdates.find((u) => u.where.id === 'ch_1');
    expect(upd1?.data).toMatchObject({ version: 4 });

    // 第 2 章は version=1 → revision.version=1 + Chapter.update.version=2
    const rev2 = captures.revisionCreates.find(
      (r) => r.data.chapter_id === 'ch_2',
    );
    expect(rev2?.data).toMatchObject({ version: 1 });
    const upd2 = captures.chapterUpdates.find((u) => u.where.id === 'ch_2');
    expect(upd2?.data).toMatchObject({ version: 2 });
  });
});
