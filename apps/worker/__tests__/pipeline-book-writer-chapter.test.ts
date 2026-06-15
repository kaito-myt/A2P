import { describe, expect, it, vi } from 'vitest';

import { A2PError, NotFoundError, ValidationError } from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { WriterChapterOutput } from '@a2p/contracts/agents/writer';

import {
  PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
  PipelineBookWriterChapterPayloadSchema,
  runPipelineBookWriterChapter,
  type AddJobLike,
  type PipelineBookWriterChapterDeps,
  type PipelineBookWriterChapterPrisma,
} from '../src/tasks/pipeline-book-writer-chapter.js';

// ---------------------------------------------------------------------------
// テスト用ファクトリ (pipeline-book-writer-outline.test.ts と同形)
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

interface OutlineRecord {
  id: string;
  book_id: string;
  chapters_json: unknown;
  status: string;
}

interface ChapterRecord {
  id: string;
  book_id: string;
  index: number;
  heading: string;
  body_md: string;
  status: string;
  char_count: number;
  version: number;
}

interface PrismaCaptures {
  jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobUpdateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  jobCreates: Array<{ data: Record<string, unknown> }>;
  jobFindFirstCalls: Array<{ where: Record<string, unknown> }>;
  chapterUpserts: Array<{
    where: { book_id_index: { book_id: string; index: number } };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }>;
  chapterCounts: Array<{ where: { book_id: string } }>;
  chapterFindMany: Array<{
    where: { book_id: string; index: { lt: number } };
  }>;
  executeRawCalls: Array<{ sql: string; values: unknown[] }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  books: BookRecord[];
  themes: ThemeRecord[];
  outlines: OutlineRecord[];
  chapters?: ChapterRecord[];
  /** updateMany が返す count を強制 (CAS 失敗テスト用). */
  forceUpdateManyCount?: number;
  /** chapter.upsert を強制失敗. */
  upsertThrow?: Error;
  /** 既存 editor Job を返すモード (重複 enqueue 抑止テスト). */
  existingEditorJob?: { id: string } | null;
  /** chapter.count の返り値を強制 (テスト用). */
  forceChapterCount?: number;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineBookWriterChapterPrisma;
  captures: PrismaCaptures;
  state: { chapters: ChapterRecord[]; jobs: JobRecord[] };
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    jobCreates: [],
    jobFindFirstCalls: [],
    chapterUpserts: [],
    chapterCounts: [],
    chapterFindMany: [],
    executeRawCalls: [],
  };
  const jobs = [...args.jobs];
  const chapters: ChapterRecord[] = [...(args.chapters ?? [])];
  let chapterCounter = 0;
  let jobCreateCounter = 0;

  const prisma: PipelineBookWriterChapterPrisma = {
    $executeRawUnsafe: async (sql, ...values) => {
      captures.executeRawCalls.push({ sql, values });
      return 1;
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
        if (args.existingEditorJob !== undefined) {
          return args.existingEditorJob;
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
        const id = `editor_job_${jobCreateCounter}`;
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
    outline: {
      findUnique: async ({ where }) => {
        const o = args.outlines.find((x) => x.id === where.id);
        return o
          ? { id: o.id, book_id: o.book_id, chapters_json: o.chapters_json, status: o.status }
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
        captures.chapterFindMany.push({ where });
        return chapters
          .filter(
            (c) =>
              c.book_id === where.book_id && c.index < where.index.lt,
          )
          .sort((a, b) => a.index - b.index)
          .map((c) => ({ index: c.index, heading: c.heading, body_md: c.body_md }));
      },
      count: async ({ where }) => {
        captures.chapterCounts.push({ where });
        if (args.forceChapterCount !== undefined) return args.forceChapterCount;
        return chapters.filter((c) => c.book_id === where.book_id).length;
      },
      upsert: async ({ where, create, update }) => {
        if (args.upsertThrow) throw args.upsertThrow;
        captures.chapterUpserts.push({ where, create, update });
        const existing = chapters.find(
          (c) =>
            c.book_id === where.book_id_index.book_id &&
            c.index === where.book_id_index.index,
        );
        if (existing) {
          existing.heading = update.heading as string;
          existing.body_md = update.body_md as string;
          existing.status = update.status as string;
          existing.char_count = update.char_count as number;
          return { id: existing.id, book_id: existing.book_id, index: existing.index };
        }
        chapterCounter += 1;
        const id = `chapter_${where.book_id_index.book_id}_${where.book_id_index.index}_${chapterCounter}`;
        const rec: ChapterRecord = {
          id,
          book_id: create.book_id,
          index: create.index,
          heading: create.heading,
          body_md: create.body_md,
          status: create.status,
          char_count: create.char_count,
          version: create.version,
        };
        chapters.push(rec);
        return { id, book_id: rec.book_id, index: rec.index };
      },
    },
  };
  return { prisma, captures, state: { chapters, jobs } };
}

function makeOkChapterOutput(opts?: {
  heading?: string;
  charCount?: number;
}): WriterChapterOutput {
  const heading = opts?.heading ?? '第3章: テスト見出し';
  const body = 'これはテスト本文。'.repeat(700); // ~5600 codepoints
  return {
    heading,
    body_md: body,
    char_count: opts?.charCount ?? [...body].length,
  };
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
    subheadings: [`小見出し${i + 1}-1`, `小見出し${i + 1}-2`, `小見出し${i + 1}-3`],
  }));
}

function makeJobBookThemeOutline(opts?: {
  jobStatus?: string;
  outlineStatus?: string;
  chapterCount?: number;
}): {
  job: JobRecord;
  book: BookRecord;
  theme: ThemeRecord;
  outline: OutlineRecord;
} {
  const n = opts?.chapterCount ?? 8;
  const job: JobRecord = {
    id: 'job_chapter_3',
    status: opts?.jobStatus ?? 'queued',
    book_id: 'book_1',
    kind: 'pipeline.book.writer.chapter',
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
  const outline: OutlineRecord = {
    id: 'outline_1',
    book_id: 'book_1',
    chapters_json: makeChaptersJson(n),
    status: opts?.outlineStatus ?? 'approved',
  };
  return { job, book, theme, outline };
}

function buildDeps(
  prisma: PipelineBookWriterChapterPrisma,
  overrides: Partial<PipelineBookWriterChapterDeps> = {},
): {
  deps: PipelineBookWriterChapterDeps;
  generateCalls: Array<unknown>;
  notifyCalls: Array<{ payload: unknown }>;
  loggerCalls: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
} {
  const { logger, calls: loggerCalls } = makeLogger();
  const generateCalls: Array<unknown> = [];
  const notifyCalls: Array<{ payload: unknown }> = [];

  const baseDeps: PipelineBookWriterChapterDeps = {
    prisma,
    logger,
    now: () => new Date('2026-05-25T00:00:00Z'),
    generateChapter: (async (input: unknown) => {
      generateCalls.push(input);
      return makeOkChapterOutput();
    }) as unknown as PipelineBookWriterChapterDeps['generateChapter'],
    notifyJobChange: (async (payload: unknown) => {
      notifyCalls.push({ payload });
      return { ok: true };
    }) as unknown as PipelineBookWriterChapterDeps['notifyJobChange'],
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
    return { id: `child_${calls.length}` };
  };
  return { addJob, calls };
}

// ---------------------------------------------------------------------------
// payload schema
// ---------------------------------------------------------------------------

describe('pipeline.book.writer.chapter payload schema', () => {
  it('task identifier が docs/05 §5.3.4 と一致する', () => {
    expect(PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME).toBe('pipeline.book.writer.chapter');
  });

  it('book_id / job_id / outline_id / chapter_index を必須', () => {
    expect(
      PipelineBookWriterChapterPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
        outline_id: 'o1',
        chapter_index: 1,
      }).success,
    ).toBe(true);
    expect(
      PipelineBookWriterChapterPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
        outline_id: 'o1',
      }).success,
    ).toBe(false);
    expect(
      PipelineBookWriterChapterPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
        outline_id: 'o1',
        chapter_index: 0,
      }).success,
    ).toBe(false);
  });

  it('feedback は任意で priority enum を要求', () => {
    expect(
      PipelineBookWriterChapterPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
        outline_id: 'o1',
        chapter_index: 1,
        feedback: [{ body: '修正コメント', priority: 'must' }],
      }).success,
    ).toBe(true);
    expect(
      PipelineBookWriterChapterPayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
        outline_id: 'o1',
        chapter_index: 1,
        feedback: [{ body: 'x', priority: 'invalid' }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// happy path (1 章生成, 最終章ではない)
// ---------------------------------------------------------------------------

describe('runPipelineBookWriterChapter happy path', () => {
  it('CAS → generateChapter → Chapter upsert → editor enqueue されない (途中章) → Job done → notify', async () => {
    const { job, book, theme, outline } = makeJobBookThemeOutline({ chapterCount: 8 });
    // 第 3 章を書く。他章は未完 → editor は enqueue されない。
    const { prisma, captures, state } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [outline],
      chapters: [],
      // upsert 後に 1 件 → 8 章中 1 件 → 最終ではない
    });
    const { deps, generateCalls, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookWriterChapter(
      {
        book_id: 'book_1',
        job_id: 'job_chapter_3',
        outline_id: 'outline_1',
        chapter_index: 3,
      },
      addJob,
      deps,
    );

    // CAS
    expect(captures.jobUpdateMany).toHaveLength(1);
    expect(captures.jobUpdateMany[0]?.data).toMatchObject({ status: 'running' });

    // generateChapter 呼出
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]).toMatchObject({
      jobId: 'job_chapter_3',
      bookId: 'book_1',
      accountId: 'acc_1',
      genre: 'business',
      outlineChapter: {
        index: 3,
        heading: '第3章: タイトル',
      },
      themeContext: {
        title: 'テスト書籍タイトル',
        subtitle: 'テスト副題',
        hook: '実例と数値で語る差別化フック',
        target_reader: '副業を考えている 30-40 代会社員',
      },
    });
    expect(
      (generateCalls[0] as { previousChaptersSummary?: string }).previousChaptersSummary,
    ).toBeUndefined(); // 直前章 0 件
    expect((generateCalls[0] as { feedback?: unknown }).feedback).toBeUndefined();

    // Chapter.upsert (book_id_index PK)
    expect(captures.chapterUpserts).toHaveLength(1);
    expect(captures.chapterUpserts[0]?.where).toEqual({
      book_id_index: { book_id: 'book_1', index: 3 },
    });
    expect(captures.chapterUpserts[0]?.create).toMatchObject({
      book_id: 'book_1',
      index: 3,
      status: 'done',
      version: 1,
    });
    expect(state.chapters).toHaveLength(1);

    // chapter.count で完了監視 → 1 < 8 → editor enqueue されない
    expect(captures.chapterCounts).toHaveLength(1);
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
        chapter_index: 3,
        is_last: false,
        editor_job_id: null,
      },
    });

    // notify (phase なし、途中章のため)
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.payload).toEqual({
      jobId: 'job_chapter_3',
      status: 'done',
      kind: 'pipeline.book.writer.chapter',
      bookId: 'book_1',
    });
  });

  it('最終章 (8/8 完了) で pipeline.book.editor を enqueue + phase=chapters_complete で notify', async () => {
    const { job, book, theme, outline } = makeJobBookThemeOutline({ chapterCount: 8 });
    // 既に 1〜7 章は done、いま 8 章目を書く
    const preChapters: ChapterRecord[] = Array.from({ length: 7 }, (_, i) => ({
      id: `chapter_book_1_${i + 1}`,
      book_id: 'book_1',
      index: i + 1,
      heading: `第${i + 1}章: タイトル`,
      body_md: 'すでに書かれた本文'.repeat(500),
      status: 'done',
      char_count: 4500,
      version: 1,
    }));
    job.id = 'job_chapter_8';
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [outline],
      chapters: preChapters,
    });
    const { deps, generateCalls, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookWriterChapter(
      {
        book_id: 'book_1',
        job_id: 'job_chapter_8',
        outline_id: 'outline_1',
        chapter_index: 8,
      },
      addJob,
      deps,
    );

    // generateChapter — previousChaptersSummary に 7 章分の抜粋
    expect(generateCalls).toHaveLength(1);
    const prevSummary = (generateCalls[0] as { previousChaptersSummary?: string })
      .previousChaptersSummary;
    expect(typeof prevSummary).toBe('string');
    expect(prevSummary).toContain('第1章: 第1章: タイトル');
    expect(prevSummary).toContain('第7章: 第7章: タイトル');

    // 8 章完成 (7 既存 + 1 新規 = 8 = total) → editor enqueue
    expect(captures.jobCreates).toHaveLength(1);
    expect(captures.jobCreates[0]?.data).toMatchObject({
      kind: 'pipeline.book.editor',
      book_id: 'book_1',
      parent_job_id: 'job_chapter_8',
      status: 'queued',
      payload_json: { book_id: 'book_1' },
    });
    expect(addJobCalls).toHaveLength(2);
    expect(addJobCalls[0]?.identifier).toBe('pipeline.book.editor');
    expect(addJobCalls[0]?.payload).toMatchObject({
      book_id: 'book_1',
      job_id: 'editor_job_1',
    });
    // cost check enqueue (F-034 / T-07-02)
    expect(addJobCalls[1]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[1]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    // result_json.is_last=true + editor_job_id
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall?.data).toMatchObject({
      result_json: {
        is_last: true,
        editor_job_id: 'editor_job_1',
      },
    });

    // notify (phase=chapters_complete)
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.payload).toMatchObject({
      phase: 'chapters_complete',
    });
  });

  it('最終章だが既に editor Job が存在 → 重複 enqueue しない', async () => {
    const { job, book, theme, outline } = makeJobBookThemeOutline({ chapterCount: 8 });
    const preChapters: ChapterRecord[] = Array.from({ length: 7 }, (_, i) => ({
      id: `chapter_book_1_${i + 1}`,
      book_id: 'book_1',
      index: i + 1,
      heading: `第${i + 1}章: タイトル`,
      body_md: '既存本文'.repeat(500),
      status: 'done',
      char_count: 4500,
      version: 1,
    }));
    job.id = 'job_chapter_8';
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [outline],
      chapters: preChapters,
      existingEditorJob: { id: 'editor_existing_1' },
    });
    const { deps, loggerCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookWriterChapter(
      {
        book_id: 'book_1',
        job_id: 'job_chapter_8',
        outline_id: 'outline_1',
        chapter_index: 8,
      },
      addJob,
      deps,
    );

    expect(captures.jobCreates).toHaveLength(0);
    // cost check enqueue only (F-034 / T-07-02), editor skipped
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[0]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall?.data).toMatchObject({
      result_json: {
        is_last: true,
        editor_job_id: null, // 自分は enqueue していない
      },
    });

    const skipLog = loggerCalls.find((c) =>
      (c.msg as string).includes('editor Job already enqueued'),
    );
    expect(skipLog).toBeDefined();
  });

  it('feedback を generateChapter に forward', async () => {
    const { job, book, theme, outline } = makeJobBookThemeOutline();
    const { prisma } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [outline],
    });
    const { deps, generateCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookWriterChapter(
      {
        book_id: 'book_1',
        job_id: 'job_chapter_3',
        outline_id: 'outline_1',
        chapter_index: 3,
        feedback: [
          { body: '導入の数値を 2 件追加して', priority: 'must' },
          { body: '結論を 1 段強めて', priority: 'should' },
        ],
      },
      addJob,
      deps,
    );

    expect(generateCalls).toHaveLength(1);
    expect((generateCalls[0] as { feedback?: unknown }).feedback).toEqual([
      { body: '導入の数値を 2 件追加して', priority: 'must' },
      { body: '結論を 1 段強めて', priority: 'should' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

describe('runPipelineBookWriterChapter idempotency', () => {
  it('Job.status === done なら早期 return', async () => {
    const { job, book, theme, outline } = makeJobBookThemeOutline({ jobStatus: 'done' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [outline],
    });
    const { deps, generateCalls, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookWriterChapter(
      {
        book_id: 'book_1',
        job_id: 'job_chapter_3',
        outline_id: 'outline_1',
        chapter_index: 3,
      },
      addJob,
      deps,
    );

    expect(captures.jobUpdateMany).toHaveLength(0);
    expect(captures.chapterUpserts).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
  });

  it('CAS で count=0 (他 worker が先取り) なら skip', async () => {
    const { job, book, theme, outline } = makeJobBookThemeOutline({ jobStatus: 'running' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [outline],
      forceUpdateManyCount: 0,
    });
    const { deps, generateCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookWriterChapter(
      {
        book_id: 'book_1',
        job_id: 'job_chapter_3',
        outline_id: 'outline_1',
        chapter_index: 3,
      },
      addJob,
      deps,
    );

    expect(captures.chapterUpserts).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

describe('runPipelineBookWriterChapter error paths', () => {
  it('payload zod 違反 → ValidationError', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [], outlines: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChapter({}, addJob, deps),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runPipelineBookWriterChapter({}, addJob, deps),
    ).rejects.toBeInstanceOf(A2PError);
  });

  it('Job 不在 → NotFoundError (CAS 前)', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [], outlines: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChapter(
        {
          book_id: 'book_1',
          job_id: 'job_missing',
          outline_id: 'outline_1',
          chapter_index: 1,
        },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('Outline 不在 → NotFoundError, Job=failed', async () => {
    const { job, book, theme } = makeJobBookThemeOutline();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [],
    });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChapter(
        {
          book_id: 'book_1',
          job_id: 'job_chapter_3',
          outline_id: 'outline_missing',
          chapter_index: 3,
        },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('chapter_index が outline.chapters_json に存在しない → NotFoundError', async () => {
    const { job, book, theme, outline } = makeJobBookThemeOutline({ chapterCount: 5 });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [outline],
    });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChapter(
        {
          book_id: 'book_1',
          job_id: 'job_chapter_3',
          outline_id: 'outline_1',
          chapter_index: 99,
        },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Outline.book_id 不一致 → ValidationError', async () => {
    const { job, book, theme, outline } = makeJobBookThemeOutline();
    outline.book_id = 'book_other'; // mismatch
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [outline],
    });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterChapter(
        {
          book_id: 'book_1',
          job_id: 'job_chapter_3',
          outline_id: 'outline_1',
          chapter_index: 3,
        },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('generateChapter throw → 透過, Job failed, Chapter は保存されない', async () => {
    const { job, book, theme, outline } = makeJobBookThemeOutline();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [outline],
    });
    const boom = new Error('boom from generateChapter');
    const { deps } = buildDeps(prisma, {
      generateChapter: (async () => {
        throw boom;
      }) as unknown as PipelineBookWriterChapterDeps['generateChapter'],
    });
    const { addJob, calls: addJobCalls } = makeAddJob();

    await expect(
      runPipelineBookWriterChapter(
        {
          book_id: 'book_1',
          job_id: 'job_chapter_3',
          outline_id: 'outline_1',
          chapter_index: 3,
        },
        addJob,
        deps,
      ),
    ).rejects.toBe(boom);

    expect(captures.chapterUpserts).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect((failedCall?.data.error as string).includes('boom from generateChapter')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// previousChaptersSummary 構築
// ---------------------------------------------------------------------------

describe('runPipelineBookWriterChapter previousChaptersSummary', () => {
  it('直前章の heading + body_md 先頭 200 字を含む', async () => {
    const { job, book, theme, outline } = makeJobBookThemeOutline({ chapterCount: 8 });
    // 第 1〜2 章は done。本文先頭 200 字 + heading が previousChaptersSummary に入る想定。
    const preChapters: ChapterRecord[] = [
      {
        id: 'c1',
        book_id: 'book_1',
        index: 1,
        heading: '第1章: 導入',
        body_md: 'あ'.repeat(500), // 500 文字の本文
        status: 'done',
        char_count: 500,
        version: 1,
      },
      {
        id: 'c2',
        book_id: 'book_1',
        index: 2,
        heading: '第2章: 展開',
        body_md: 'い'.repeat(500),
        status: 'done',
        char_count: 500,
        version: 1,
      },
    ];
    job.id = 'job_chapter_3';
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      outlines: [outline],
      chapters: preChapters,
    });
    const { deps, generateCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookWriterChapter(
      {
        book_id: 'book_1',
        job_id: 'job_chapter_3',
        outline_id: 'outline_1',
        chapter_index: 3,
      },
      addJob,
      deps,
    );

    // findMany で index < 3 を取った
    expect(captures.chapterFindMany).toHaveLength(1);
    expect(captures.chapterFindMany[0]?.where).toEqual({
      book_id: 'book_1',
      index: { lt: 3 },
    });

    // generateChapter.input.previousChaptersSummary が両章を含む
    const prev = (generateCalls[0] as { previousChaptersSummary?: string })
      .previousChaptersSummary;
    expect(typeof prev).toBe('string');
    expect(prev).toContain('第1章: 第1章: 導入');
    expect(prev).toContain('第2章: 第2章: 展開');
    // 各章 200 字抜粋なので 'あ'×200 と 'い'×200 が入る
    expect(prev).toContain('あ'.repeat(200));
    expect(prev).toContain('い'.repeat(200));
    // しかし 500 字全部は入らない (201 字目以降は切られている)
    expect(prev).not.toContain('あ'.repeat(201));
  });
});
