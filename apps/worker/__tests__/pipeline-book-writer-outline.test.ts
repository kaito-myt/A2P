import { describe, expect, it, vi } from 'vitest';

import { A2PError, ConflictError, NotFoundError, ValidationError } from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { WriterOutlineOutput } from '@a2p/contracts/agents/writer';

import {
  PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
  PipelineBookWriterOutlinePayloadSchema,
  runPipelineBookWriterOutline,
  type AddJobLike,
  type PipelineBookWriterOutlineDeps,
  type PipelineBookWriterOutlinePrisma,
} from '../src/tasks/pipeline-book-writer-outline.js';

// ---------------------------------------------------------------------------
// テスト用ファクトリ (pipeline-book-marketer.test.ts と同形)
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
}

interface KdpMetaRecord {
  book_id: string;
  description: string;
  keywords: string[];
}

interface OutlineRecord {
  id: string;
  book_id: string;
  chapters_json: unknown;
  status: string;
  reject_note: string | null;
  approved_at: Date | null;
}

interface PrismaCaptures {
  jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobUpdateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  outlineUpserts: Array<{
    where: { book_id: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }>;
  executeRawCalls: Array<{ sql: string; values: unknown[] }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  books: BookRecord[];
  themes: ThemeRecord[];
  kdpMetas?: KdpMetaRecord[];
  outlines?: OutlineRecord[];
  /** updateMany が返す count を強制する場合 (CAS 失敗テスト用). */
  forceUpdateManyCount?: number;
  /** outline.upsert を強制失敗させる場合. */
  outlineUpsertThrow?: Error;
  /** $executeRawUnsafe を強制失敗させる場合 (notify 失敗の検証). */
  executeRawThrow?: Error;
  /** outline.upsert が返す id seed (省略時 'outline_book_<book_id>'). */
  outlineIdSeed?: string;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineBookWriterOutlinePrisma;
  captures: PrismaCaptures;
  state: { outlines: OutlineRecord[] };
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    outlineUpserts: [],
    executeRawCalls: [],
  };
  const jobs = [...args.jobs];
  const outlines: OutlineRecord[] = [...(args.outlines ?? [])];
  let outlineCounter = 0;

  const prisma: PipelineBookWriterOutlinePrisma = {
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
    kdpMetadata: {
      findUnique: async ({ where }) => {
        const m = (args.kdpMetas ?? []).find((x) => x.book_id === where.book_id);
        return m
          ? { description: m.description, keywords: m.keywords }
          : null;
      },
    },
    outline: {
      upsert: async ({ where, create, update }) => {
        if (args.outlineUpsertThrow) throw args.outlineUpsertThrow;
        captures.outlineUpserts.push({ where, create, update });
        const existing = outlines.find((o) => o.book_id === where.book_id);
        if (existing) {
          existing.chapters_json = update.chapters_json;
          existing.status = update.status as string;
          existing.reject_note = update.reject_note as string | null;
          existing.approved_at = update.approved_at as Date | null;
          return { id: existing.id, book_id: existing.book_id };
        }
        outlineCounter += 1;
        const id =
          args.outlineIdSeed ?? `outline_${where.book_id}_${outlineCounter}`;
        const rec: OutlineRecord = {
          id,
          book_id: where.book_id,
          chapters_json: create.chapters_json,
          status: create.status as string,
          reject_note: create.reject_note as string | null,
          approved_at: null,
        };
        outlines.push(rec);
        return { id, book_id: where.book_id };
      },
    },
  };
  return { prisma, captures, state: { outlines } };
}

function makeOkOutline(opts?: { chapterCount?: number }): WriterOutlineOutput {
  const n = opts?.chapterCount ?? 8;
  // 50000 / 8 = 6250 字/章 — F-003 ±15% 範囲内 (合計 50000)
  const perChapter = Math.floor(50_000 / n);
  const chapters = Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    heading: `第${i + 1}章タイトル`,
    summary: `第${i + 1}章の要旨説明テキスト`,
    target_chars: perChapter,
    subheadings: [`小見出し${i + 1}-1`, `小見出し${i + 1}-2`],
  }));
  const totalCharsEstimate = chapters.reduce((acc, c) => acc + c.target_chars, 0);
  return { chapters, totalCharsEstimate };
}

function makeJobBookThemeMeta(opts?: {
  jobStatus?: string;
  themeId?: string | null;
  withKdpMeta?: boolean;
}): {
  job: JobRecord;
  book: BookRecord;
  theme: ThemeRecord;
  kdpMeta?: KdpMetaRecord;
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
  };
  const withKdpMeta = opts?.withKdpMeta !== false;
  const kdpMeta: KdpMetaRecord | undefined = withKdpMeta
    ? {
        book_id: 'book_1',
        description: 'テスト用書籍紹介文',
        keywords: ['副業', '起業', 'マーケティング'],
      }
    : undefined;
  return kdpMeta !== undefined
    ? { job, book, theme, kdpMeta }
    : { job, book, theme };
}

function buildDeps(
  prisma: PipelineBookWriterOutlinePrisma,
  overrides: Partial<PipelineBookWriterOutlineDeps> = {},
): {
  deps: PipelineBookWriterOutlineDeps;
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

  const baseDeps: PipelineBookWriterOutlineDeps = {
    prisma,
    logger,
    now: () => new Date('2026-05-25T00:00:00Z'),
    acquireLock: (async (args: { bookId: string; holder: string; ttlMinutes?: number }) => {
      acquireCalls.push(args);
      return {
        book_id: args.bookId,
        holder: args.holder,
        acquired_at: new Date('2026-05-25T00:00:00Z'),
        expires_at: new Date('2026-05-25T00:30:00Z'),
      };
    }) as unknown as PipelineBookWriterOutlineDeps['acquireLock'],
    releaseLock: (async (args: { bookId: string; holder: string }) => {
      releaseCalls.push(args);
    }) as unknown as PipelineBookWriterOutlineDeps['releaseLock'],
    generateOutline: (async (input: unknown) => {
      generateCalls.push(input);
      return makeOkOutline();
    }) as unknown as PipelineBookWriterOutlineDeps['generateOutline'],
    notifyJobChange: (async (payload: unknown) => {
      notifyCalls.push({ payload });
      return { ok: true };
    }) as unknown as PipelineBookWriterOutlineDeps['notifyJobChange'],
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
// payload schema テスト
// ---------------------------------------------------------------------------

describe('pipeline.book.writer.outline payload schema', () => {
  it('task identifier が docs/05 §5.3.3 と一致する', () => {
    expect(PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME).toBe('pipeline.book.writer.outline');
  });

  it('book_id / job_id を必須、reject_note は任意', () => {
    expect(
      PipelineBookWriterOutlinePayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
      }).success,
    ).toBe(true);
    expect(
      PipelineBookWriterOutlinePayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
        reject_note: '導入が弱い',
      }).success,
    ).toBe(true);
    expect(
      PipelineBookWriterOutlinePayloadSchema.safeParse({ job_id: 'j1' }).success,
    ).toBe(false);
    expect(
      PipelineBookWriterOutlinePayloadSchema.safeParse({ book_id: '' , job_id: 'j1' }).success,
    ).toBe(false);
    // reject_note は 2000 字を超えると拒否
    expect(
      PipelineBookWriterOutlinePayloadSchema.safeParse({
        book_id: 'b1',
        job_id: 'j1',
        reject_note: 'a'.repeat(2001),
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

describe('runPipelineBookWriterOutline happy path', () => {
  it('Job CAS → generateOutline 呼出 → Outline upsert (pending_review) → notifyJobChange → Job done → lock release', async () => {
    const { job, book, theme, kdpMeta } = makeJobBookThemeMeta();
    const { prisma, captures, state } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      kdpMetas: kdpMeta ? [kdpMeta] : [],
    });
    const { deps, acquireCalls, releaseCalls, generateCalls, notifyCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookWriterOutline(
      { book_id: 'book_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    // 1. CAS で running
    expect(captures.jobUpdateMany).toHaveLength(1);
    expect(captures.jobUpdateMany[0]?.data).toMatchObject({ status: 'running' });
    expect(captures.jobUpdateMany[0]?.where).toMatchObject({
      id: 'job_1',
      status: { in: ['queued', 'failed'] },
    });

    // 2. acquireLock (holder=pipeline:<job_id>, ttl 30)
    expect(acquireCalls).toEqual([
      { bookId: 'book_1', holder: 'pipeline:job_1', ttlMinutes: 30 },
    ]);

    // 3. generateOutline 呼出 — jobId/bookId/accountId/genre/themeContext/kdpMetadata 注入
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
      kdpMetadata: {
        description: 'テスト用書籍紹介文',
        keywords: ['副業', '起業', 'マーケティング'],
      },
      targetChapterCount: 8,
      targetTotalChars: 50_000,
    });
    // rejectNote は payload に無いので forward されない
    expect((generateCalls[0] as { rejectNote?: string }).rejectNote).toBeUndefined();

    // 4. Outline.upsert — book_id @unique で 1 行
    expect(captures.outlineUpserts).toHaveLength(1);
    expect(captures.outlineUpserts[0]?.where).toEqual({ book_id: 'book_1' });
    expect(captures.outlineUpserts[0]?.create).toMatchObject({
      book_id: 'book_1',
      status: 'pending_review',
      reject_note: null,
    });
    expect(
      (captures.outlineUpserts[0]?.create.chapters_json as Array<{ index: number }>).length,
    ).toBe(8);
    // state 反映
    expect(state.outlines).toHaveLength(1);
    expect(state.outlines[0]?.status).toBe('pending_review');

    // 5. Job.update で done に遷移、result_json に outline_id/chapters_count
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.where).toEqual({ id: 'job_1' });
    expect(doneCall?.data).toMatchObject({
      status: 'done',
      result_json: {
        outline_id: expect.any(String),
        chapters_count: 8,
        total_chars_estimate: expect.any(Number),
        regenerated_from_rejected: false,
      },
    });

    // 5a. alert.cost.check per_book enqueue (F-034 / T-07-02)
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[0]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    // 6. notifyJobChange (status=done, phase=awaiting_outline_approval, kind=task name)
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.payload).toEqual({
      jobId: 'job_1',
      status: 'done',
      kind: 'pipeline.book.writer.outline',
      bookId: 'book_1',
      phase: 'awaiting_outline_approval',
    });

    // 7. release は finally で必ず実行
    expect(releaseCalls).toEqual([{ bookId: 'book_1', holder: 'pipeline:job_1' }]);
  });

  it('Outline 既存行ありの再呼出 (差戻し再生成) では同行 update + reject_note 反映', async () => {
    const { job, book, theme, kdpMeta } = makeJobBookThemeMeta();
    const existingOutline: OutlineRecord = {
      id: 'outline_existing_1',
      book_id: 'book_1',
      chapters_json: [{ index: 1, heading: '旧章', summary: '旧要旨', target_chars: 5000, subheadings: ['a', 'b'] }],
      status: 'rejected',
      reject_note: '前回差戻し済',
      approved_at: null,
    };
    const { prisma, captures, state } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      kdpMetas: kdpMeta ? [kdpMeta] : [],
      outlines: [existingOutline],
    });
    const { deps, generateCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookWriterOutline(
      {
        book_id: 'book_1',
        job_id: 'job_1',
        reject_note: '導入章のフックが弱い。具体例を 2 件追加して。',
      },
      addJob,
      deps,
    );

    // generateOutline.input.rejectNote に forward
    expect(generateCalls).toHaveLength(1);
    expect((generateCalls[0] as { rejectNote?: string }).rejectNote).toBe(
      '導入章のフックが弱い。具体例を 2 件追加して。',
    );

    // upsert 1 回 → 既存行が update された
    expect(captures.outlineUpserts).toHaveLength(1);
    expect(captures.outlineUpserts[0]?.update).toMatchObject({
      status: 'pending_review',
      reject_note: '導入章のフックが弱い。具体例を 2 件追加して。',
      approved_at: null,
    });

    // outlines は 1 件のまま (新規 INSERT されない)
    expect(state.outlines).toHaveLength(1);
    expect(state.outlines[0]?.id).toBe('outline_existing_1');
    expect(state.outlines[0]?.status).toBe('pending_review');
    expect(state.outlines[0]?.reject_note).toBe('導入章のフックが弱い。具体例を 2 件追加して。');

    // result_json.regenerated_from_rejected=true
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall?.data.result_json).toMatchObject({
      regenerated_from_rejected: true,
    });
  });

  it('KdpMetadata 不在でも warn 継続 — generateOutline.input.kdpMetadata は undefined', async () => {
    const { job, book, theme } = makeJobBookThemeMeta({ withKdpMeta: false });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      kdpMetas: [],
    });
    const { deps, generateCalls, loggerCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookWriterOutline(
      { book_id: 'book_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    // generateOutline は呼ばれ、kdpMetadata は undefined
    expect(generateCalls).toHaveLength(1);
    expect((generateCalls[0] as { kdpMetadata?: unknown }).kdpMetadata).toBeUndefined();

    // warn ログ
    const warnCall = loggerCalls.find(
      (c) => c.level === 'warn' && (c.msg as string).includes('KdpMetadata not found'),
    );
    expect(warnCall).toBeDefined();

    // Outline は通常通り upsert
    expect(captures.outlineUpserts).toHaveLength(1);
  });

  it('notifyJobChange が ok=false (pg_notify 失敗) でも本処理は継続', async () => {
    const { job, book, theme, kdpMeta } = makeJobBookThemeMeta();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      kdpMetas: kdpMeta ? [kdpMeta] : [],
    });
    const { deps, releaseCalls } = buildDeps(prisma, {
      notifyJobChange: (async () => ({ ok: false })) as unknown as PipelineBookWriterOutlineDeps['notifyJobChange'],
    });
    const { addJob } = makeAddJob();

    await runPipelineBookWriterOutline(
      { book_id: 'book_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    // Outline 保存 + Job done + lock release は実行される
    expect(captures.outlineUpserts).toHaveLength(1);
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(releaseCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

describe('runPipelineBookWriterOutline idempotency', () => {
  it('Job.status === done なら早期 return (generateOutline 呼ばれず、upsert もされない)', async () => {
    const { job, book, theme, kdpMeta } = makeJobBookThemeMeta({ jobStatus: 'done' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      kdpMetas: kdpMeta ? [kdpMeta] : [],
    });
    const { deps, acquireCalls, generateCalls, notifyCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookWriterOutline(
      { book_id: 'book_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    expect(captures.jobUpdateMany).toHaveLength(0);
    expect(captures.outlineUpserts).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
  });

  it('CAS で count=0 (他 worker が先に running 化) なら skip', async () => {
    const { job, book, theme, kdpMeta } = makeJobBookThemeMeta({ jobStatus: 'running' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      kdpMetas: kdpMeta ? [kdpMeta] : [],
      forceUpdateManyCount: 0,
    });
    const { deps, acquireCalls, generateCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookWriterOutline(
      { book_id: 'book_1', job_id: 'job_1' },
      addJob,
      deps,
    );

    expect(captures.outlineUpserts).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

describe('runPipelineBookWriterOutline error paths', () => {
  it('payload zod 違反 → ValidationError', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterOutline({}, addJob, deps),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runPipelineBookWriterOutline({}, addJob, deps),
    ).rejects.toBeInstanceOf(A2PError);
  });

  it('Job が存在しない → NotFoundError, BookLock 取らない', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [] });
    const { deps, acquireCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterOutline(
        { book_id: 'book_1', job_id: 'job_missing' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(acquireCalls).toHaveLength(0);
  });

  it('Book が存在しない → NotFoundError, Job=failed 降格, lock release', async () => {
    const { job, theme } = makeJobBookThemeMeta();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [], // book を欠落
      themes: [theme],
    });
    const { deps, acquireCalls, releaseCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterOutline(
        { book_id: 'book_missing', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(acquireCalls).toHaveLength(1);
    expect(releaseCalls).toHaveLength(1);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Book.theme_id が null → NotFoundError, Job=failed, lock release', async () => {
    const { job, book, theme } = makeJobBookThemeMeta({ themeId: null });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterOutline(
        { book_id: 'book_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(releaseCalls).toHaveLength(1);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('ThemeCandidate が存在しない → NotFoundError, lock release', async () => {
    const { job, book } = makeJobBookThemeMeta();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [], // theme 欠落
    });
    const { deps, releaseCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterOutline(
        { book_id: 'book_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(releaseCalls).toHaveLength(1);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('generateOutline throw → 透過, Job failed, Outline は保存されない, lock 解放', async () => {
    const { job, book, theme, kdpMeta } = makeJobBookThemeMeta();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      kdpMetas: kdpMeta ? [kdpMeta] : [],
    });
    const boom = new Error('boom from generateOutline');
    const { deps, releaseCalls } = buildDeps(prisma, {
      generateOutline: (async () => {
        throw boom;
      }) as unknown as PipelineBookWriterOutlineDeps['generateOutline'],
    });
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterOutline(
        { book_id: 'book_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(boom);

    expect(captures.outlineUpserts).toHaveLength(0);
    expect(releaseCalls).toHaveLength(1);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect((failedCall?.data.error as string).includes('boom from generateOutline')).toBe(true);
  });

  it('Outline.upsert throw → 透過, Job failed, lock 解放', async () => {
    const { job, book, theme, kdpMeta } = makeJobBookThemeMeta();
    const dbErr = new Error('outline insert failed');
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      kdpMetas: kdpMeta ? [kdpMeta] : [],
      outlineUpsertThrow: dbErr,
    });
    const { deps, releaseCalls, notifyCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterOutline(
        { book_id: 'book_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(dbErr);

    expect(notifyCalls).toHaveLength(0); // notify は Outline 保存後でのみ実行
    expect(releaseCalls).toHaveLength(1);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('acquireBookLock ConflictError → 透過, Job=failed, release されない', async () => {
    const { job, book, theme, kdpMeta } = makeJobBookThemeMeta();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      kdpMetas: kdpMeta ? [kdpMeta] : [],
    });
    const lockErr = new ConflictError('book locked', { details: { bookId: 'book_1' } });
    const { deps, releaseCalls, generateCalls } = buildDeps(prisma, {
      acquireLock: (async () => {
        throw lockErr;
      }) as unknown as PipelineBookWriterOutlineDeps['acquireLock'],
    });
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterOutline(
        { book_id: 'book_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).rejects.toBe(lockErr);

    // lock 取得前なので generateOutline は呼ばれない
    expect(generateCalls).toHaveLength(0);
    // lock を取れていないので release も呼ばない
    expect(releaseCalls).toHaveLength(0);
    // CAS で running に上げた後の失敗なので Job は failed に戻す
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('releaseLock throw → warn のみで本処理失敗にならない (happy path 中)', async () => {
    const { job, book, theme, kdpMeta } = makeJobBookThemeMeta();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      kdpMetas: kdpMeta ? [kdpMeta] : [],
    });
    const releaseErr = new Error('release boom');
    const { deps, loggerCalls } = buildDeps(prisma, {
      releaseLock: (async () => {
        throw releaseErr;
      }) as unknown as PipelineBookWriterOutlineDeps['releaseLock'],
    });
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookWriterOutline(
        { book_id: 'book_1', job_id: 'job_1' },
        addJob,
        deps,
      ),
    ).resolves.toBeUndefined();

    // happy path 完走
    expect(captures.outlineUpserts).toHaveLength(1);
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();

    // warn ログが残る
    const warnCall = loggerCalls.find(
      (c) => c.level === 'warn' && (c.msg as string).includes('failed to release BookLock'),
    );
    expect(warnCall).toBeDefined();
  });
});
