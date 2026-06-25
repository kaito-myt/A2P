import { describe, expect, it, vi } from 'vitest';

import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { JudgeOutput } from '@a2p/contracts/agents/judge';

import {
  PIPELINE_BOOK_JUDGE_TASK_NAME,
  PipelineBookJudgePayloadSchema,
  runPipelineBookJudge,
  type AddJobLike,
  type PipelineBookJudgeDeps,
  type PipelineBookJudgePrisma,
} from '../src/tasks/pipeline-book-judge.js';

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
  payload_json?: unknown;
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
  index: number;
  heading: string;
  body_md: string;
  version: number;
}

interface EvalResultRecord {
  id: string;
  book_id: string;
  score_total: number;
  retry_count: number;
}

interface AlertRecord {
  id: string;
  kind: string;
}

interface PrismaCaptures {
  jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobUpdateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  jobCreates: Array<{ data: Record<string, unknown> }>;
  jobFindFirstCalls: Array<{ where: Record<string, unknown> }>;
  evalResultCreates: Array<{ data: Record<string, unknown> }>;
  alertCreates: Array<{ data: Record<string, unknown> }>;
  executeRawCalls: Array<{ sql: string; values: unknown[] }>;
  bookUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  books: BookRecord[];
  themes: ThemeRecord[];
  chapters: ChapterRecord[];
  existingExportJob?: { id: string } | null;
  forceUpdateManyCount?: number;
  executeRawThrow?: Error;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineBookJudgePrisma;
  captures: PrismaCaptures;
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    jobCreates: [],
    jobFindFirstCalls: [],
    evalResultCreates: [],
    alertCreates: [],
    executeRawCalls: [],
    bookUpdates: [],
  };
  const jobs = [...args.jobs];
  let jobCreateCounter = 0;
  let evalCounter = 0;
  let alertCounter = 0;

  const prisma: PipelineBookJudgePrisma = {
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
      findFirst: async ({ where }) => {
        captures.jobFindFirstCalls.push({
          where: where as unknown as Record<string, unknown>,
        });
        if (args.existingExportJob !== undefined) {
          return args.existingExportJob;
        }
        const w = where as { book_id: string; kind: string; status: { in: string[] } };
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
        jobCreateCounter += 1;
        const id = `created_job_${jobCreateCounter}`;
        const record: JobRecord = {
          id,
          status: data.status,
          book_id: data.book_id,
          kind: data.kind,
          payload_json: data.payload_json,
        };
        jobs.push(record);
        captures.jobCreates.push({
          data: data as unknown as Record<string, unknown>,
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
      update: async ({ where, data }) => {
        captures.bookUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        return {};
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
    outline: {
      findUnique: async ({ where }) => {
        if (args.chapters.length === 0) return null;
        return {
          id: `outline_${where.book_id}`,
          chapters_json: { chapters: [] },
        };
      },
    },
    chapter: {
      findMany: async ({ where }) => {
        return args.chapters
          .map((c) => ({
            id: c.id,
            index: c.index,
            heading: c.heading,
            body_md: c.body_md,
            version: c.version,
          }));
      },
    },
    evalResult: {
      create: async ({ data }) => {
        evalCounter += 1;
        const id = `eval_${evalCounter}`;
        captures.evalResultCreates.push({
          data: data as unknown as Record<string, unknown>,
        });
        return { id };
      },
    },
    alert: {
      create: async ({ data }) => {
        alertCounter += 1;
        const id = `alert_${alertCounter}`;
        captures.alertCreates.push({
          data: data as unknown as Record<string, unknown>,
        });
        return { id };
      },
    },
  };

  return { prisma, captures };
}

function makeDefaultJudgeOutput(scoreTotal: number, useEditorPath = false): JudgeOutput {
  const editorScore = useEditorPath ? 60 : 85;
  return {
    score_total: scoreTotal,
    score_breakdown: {
      benefit_clarity: scoreTotal,
      logical_consistency: useEditorPath ? editorScore : scoreTotal,
      style_consistency: useEditorPath ? editorScore : scoreTotal,
      japanese_naturalness: useEditorPath ? editorScore : scoreTotal,
      title_alignment: scoreTotal,
      genre_fit: scoreTotal,
    },
    judge_comments: {
      overall: 'テスト総評',
      ...(useEditorPath ? { style_consistency: '文体の一貫性に問題あり' } : {}),
    },
  };
}

function makeChapters(n: number): ChapterRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ch_${i + 1}`,
    index: i + 1,
    heading: `第${i + 1}章: テスト`,
    body_md: 'テスト本文。'.repeat(100),
    version: 1,
  }));
}

function makeBaseData(opts?: { jobStatus?: string; retryCount?: number }) {
  const job: JobRecord = {
    id: 'job_judge_1',
    status: opts?.jobStatus ?? 'queued',
    book_id: 'book_1',
    kind: 'pipeline.book.judge',
  };
  const book: BookRecord = {
    id: 'book_1',
    account_id: 'acc_1',
    theme_id: 'theme_1',
    title: 'テスト書籍',
    subtitle: null,
  };
  const theme: ThemeRecord = {
    id: 'theme_1',
    genre: 'business',
    title: 'テスト書籍タイトル',
    subtitle: null,
    hook: 'テストフック',
    target_reader: 'テスト読者',
  };
  const chapters = makeChapters(3);
  const payload = {
    book_id: 'book_1',
    job_id: 'job_judge_1',
    retry_count: opts?.retryCount ?? 0,
  };
  return { job, book, theme, chapters, payload };
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
    return {};
  };
  return { addJob, calls };
}

function buildDeps(
  prisma: PipelineBookJudgePrisma,
  judgeOutput: JudgeOutput,
  overrides: Partial<PipelineBookJudgeDeps> = {},
): {
  deps: PipelineBookJudgeDeps;
  acquireCalls: Array<{ bookId: string; holder: string; ttlMinutes?: number }>;
  releaseCalls: Array<{ bookId: string; holder: string }>;
  judgeCalls: Array<unknown>;
  notifyCalls: Array<{ payload: unknown }>;
  sendEmailCalls: Array<unknown>;
} {
  const { logger } = makeLogger();
  const acquireCalls: Array<{ bookId: string; holder: string; ttlMinutes?: number }> = [];
  const releaseCalls: Array<{ bookId: string; holder: string }> = [];
  const judgeCalls: Array<unknown> = [];
  const notifyCalls: Array<{ payload: unknown }> = [];
  const sendEmailCalls: Array<unknown> = [];

  const baseDeps: PipelineBookJudgeDeps = {
    prisma,
    logger,
    now: () => new Date('2026-06-01T00:00:00Z'),
    acquireLock: (async (args: { bookId: string; holder: string; ttlMinutes?: number }) => {
      acquireCalls.push(args);
      return {
        book_id: args.bookId,
        holder: args.holder,
        acquired_at: new Date('2026-06-01T00:00:00Z'),
        expires_at: new Date('2026-06-01T00:30:00Z'),
      };
    }) as unknown as PipelineBookJudgeDeps['acquireLock'],
    releaseLock: (async (args: { bookId: string; holder: string }) => {
      releaseCalls.push(args);
    }) as unknown as PipelineBookJudgeDeps['releaseLock'],
    judgeBook: async (input: unknown) => {
      judgeCalls.push(input);
      return judgeOutput;
    },
    notifyJobChange: async (payload: unknown) => {
      notifyCalls.push({ payload });
      return { ok: true };
    },
    sendEmail: async (params: unknown) => {
      sendEmailCalls.push(params);
      return { id: 'email_1' };
    },
  };

  return {
    deps: { ...baseDeps, ...overrides },
    acquireCalls,
    releaseCalls,
    judgeCalls,
    notifyCalls,
    sendEmailCalls,
  };
}

// ---------------------------------------------------------------------------
// payload schema
// ---------------------------------------------------------------------------

describe('pipeline.book.judge payload schema', () => {
  it('task identifier が docs/05 §5.3.8 と一致する', () => {
    expect(PIPELINE_BOOK_JUDGE_TASK_NAME).toBe('pipeline.book.judge');
  });

  it('book_id / job_id 必須、retry_count はデフォルト 0', () => {
    expect(
      PipelineBookJudgePayloadSchema.safeParse({ book_id: 'b1', job_id: 'j1' }).success,
    ).toBe(true);
    const parsed = PipelineBookJudgePayloadSchema.safeParse({ book_id: 'b1', job_id: 'j1' });
    expect(parsed.success && parsed.data.retry_count).toBe(0);
    expect(PipelineBookJudgePayloadSchema.safeParse({ book_id: 'b1' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (a) EvalResult が 1 件 INSERT される
// ---------------------------------------------------------------------------

describe('runPipelineBookJudge — EvalResult INSERT', () => {
  it('(a) 採点完了後に EvalResult が 1 件 INSERT される', async () => {
    const { job, book, theme, chapters, payload } = makeBaseData();
    const judgeOutput = makeDefaultJudgeOutput(85);
    const { prisma, captures } = buildPrisma({ jobs: [job], books: [book], themes: [theme], chapters });
    const { deps } = buildDeps(prisma, judgeOutput);
    const { addJob } = makeAddJob();

    await runPipelineBookJudge(payload, addJob, deps);

    expect(captures.evalResultCreates).toHaveLength(1);
    expect(captures.evalResultCreates[0]?.data).toMatchObject({
      book_id: 'book_1',
      score_total: 85,
      retry_count: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// (b) score_total >= 80 で pipeline.book.export が enqueue される
// ---------------------------------------------------------------------------

describe('runPipelineBookJudge — score >= 80 → サムネ承認ゲート', () => {
  it('(b) score_total >= 80 で Book.status=thumbnail (承認待ち) + export は自動起動しない', async () => {
    const { job, book, theme, chapters, payload } = makeBaseData();
    const judgeOutput = makeDefaultJudgeOutput(85);
    const { prisma, captures } = buildPrisma({ jobs: [job], books: [book], themes: [theme], chapters });
    const { deps, judgeCalls } = buildDeps(prisma, judgeOutput);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookJudge(payload, addJob, deps);

    // 合格でも自動 export せず、Book.status='thumbnail' (カバー採用待ち) で停止する。
    const bookUpdate = captures.bookUpdates.find((u) => u.data.status === 'thumbnail');
    expect(bookUpdate).toBeDefined();

    // pipeline.book.export は enqueue されない (採用時に bulkAdoptCovers が起動する)。
    expect(addJobCalls.some((c) => c.identifier === 'pipeline.book.export')).toBe(false);

    // judgeBook が呼ばれた (採点は実施)
    expect(judgeCalls).toHaveLength(1);

    // Job が done になる
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (c) score_total < 80 かつ retry_count=0 → editor または writer.chapter enqueue、DB payload に retry_count=1
// ---------------------------------------------------------------------------

describe('runPipelineBookJudge — score < 80 retry_count=0 → re-kick', () => {
  it('(c-editor) style/japanese/logical が低い場合は pipeline.book.editor enqueue + DB payload_json.retry_count=1', async () => {
    const { job, book, theme, chapters, payload } = makeBaseData({ retryCount: 0 });
    // style_consistency < 70 → editor パス
    const judgeOutput: JudgeOutput = {
      score_total: 60,
      score_breakdown: {
        benefit_clarity: 80,
        logical_consistency: 80,
        style_consistency: 60,
        japanese_naturalness: 80,
        title_alignment: 80,
        genre_fit: 80,
      },
      judge_comments: { overall: '文体の統一が必要' },
    };
    const { prisma, captures } = buildPrisma({ jobs: [job], books: [book], themes: [theme], chapters });
    const { deps } = buildDeps(prisma, judgeOutput);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookJudge(payload, addJob, deps);

    // Book.status = 'judging'
    const bookUpdate = captures.bookUpdates.find((u) => u.data.status === 'judging');
    expect(bookUpdate).toBeDefined();

    // editor が enqueue される
    const editorCall = addJobCalls.find((c) => c.identifier === 'pipeline.book.editor');
    expect(editorCall).toBeDefined();

    // addJob payload に retry_count が含まれない（schema 準拠）
    expect((editorCall?.payload as Record<string, unknown>)['retry_count']).toBeUndefined();

    // DB の payload_json に retry_count=1 が入る
    const editorJobCreate = captures.jobCreates.find((c) => c.data.kind === 'pipeline.book.editor');
    expect(editorJobCreate).toBeDefined();
    expect((editorJobCreate?.data.payload_json as Record<string, unknown>)['retry_count']).toBe(1);
  });

  it('(c-writer) style/japanese/logical が高い場合は pipeline.book.writer.chapter enqueue + DB payload_json.retry_count=1', async () => {
    const { job, book, theme, chapters, payload } = makeBaseData({ retryCount: 0 });
    // benefit_clarity/title_alignment/genre_fit が低い → writer パス
    const judgeOutput: JudgeOutput = {
      score_total: 55,
      score_breakdown: {
        benefit_clarity: 50,
        logical_consistency: 80,
        style_consistency: 80,
        japanese_naturalness: 80,
        title_alignment: 50,
        genre_fit: 50,
      },
      judge_comments: { overall: 'ベネフィットが不明確' },
    };
    const { prisma, captures } = buildPrisma({ jobs: [job], books: [book], themes: [theme], chapters });
    const { deps } = buildDeps(prisma, judgeOutput);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookJudge(payload, addJob, deps);

    // Book.status = 'judging'
    const bookUpdate = captures.bookUpdates.find((u) => u.data.status === 'judging');
    expect(bookUpdate).toBeDefined();

    // 全章分の writer.chapter が enqueue される
    const writerCalls = addJobCalls.filter((c) => c.identifier === 'pipeline.book.writer.chapter');
    expect(writerCalls).toHaveLength(chapters.length);

    // addJob payload に retry_count が含まれない
    writerCalls.forEach((c) => {
      expect((c.payload as Record<string, unknown>)['retry_count']).toBeUndefined();
    });

    // DB の payload_json に retry_count=1 が入る
    const writerJobCreates = captures.jobCreates.filter(
      (c) => c.data.kind === 'pipeline.book.writer.chapter',
    );
    expect(writerJobCreates).toHaveLength(chapters.length);
    writerJobCreates.forEach((jc) => {
      expect((jc.data.payload_json as Record<string, unknown>)['retry_count']).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// (d) score_total < 80 かつ retry_count=2 → needs_human_review + Alert + sendEmail
// ---------------------------------------------------------------------------

describe('runPipelineBookJudge — score < 80 retry_count=2 → needs_human_review', () => {
  it('(d) Book.status=needs_human_review + Alert(judge_failed) INSERT + sendEmail 呼出', async () => {
    const { job, book, theme, chapters } = makeBaseData({ retryCount: 2 });
    const payload = { book_id: 'book_1', job_id: 'job_judge_1', retry_count: 2 };
    const judgeOutput = makeDefaultJudgeOutput(55);
    const { prisma, captures } = buildPrisma({ jobs: [job], books: [book], themes: [theme], chapters });
    const { deps, sendEmailCalls } = buildDeps(prisma, judgeOutput);
    const { addJob } = makeAddJob();

    await runPipelineBookJudge(payload, addJob, deps);

    // Book.status = 'needs_human_review'
    const bookUpdate = captures.bookUpdates.find((u) => u.data.status === 'needs_human_review');
    expect(bookUpdate).toBeDefined();

    // Alert(kind='judge_failed') が INSERT される
    expect(captures.alertCreates).toHaveLength(1);
    expect(captures.alertCreates[0]?.data).toMatchObject({ kind: 'judge_failed' });

    // sendEmail が呼ばれる（from を渡していないことを確認）
    expect(sendEmailCalls).toHaveLength(1);
    const emailParams = sendEmailCalls[0] as Record<string, unknown>;
    expect(emailParams['from']).toBeUndefined();
    expect(typeof emailParams['subject']).toBe('string');
    expect(emailParams['react']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (e) deps.judgeBook 差替で実 LLM 不要（mock が呼ばれることを assert）
// ---------------------------------------------------------------------------

describe('runPipelineBookJudge — judgeBook DI', () => {
  it('(e) deps.judgeBook に渡した mock が呼ばれ、実 LLM は不要', async () => {
    const { job, book, theme, chapters, payload } = makeBaseData();
    const judgeOutput = makeDefaultJudgeOutput(90);
    const { prisma } = buildPrisma({ jobs: [job], books: [book], themes: [theme], chapters });
    const mockJudge = vi.fn(async (): Promise<JudgeOutput> => judgeOutput);
    const { deps } = buildDeps(prisma, judgeOutput, { judgeBook: mockJudge });
    const { addJob } = makeAddJob();

    await runPipelineBookJudge(payload, addJob, deps);

    expect(mockJudge).toHaveBeenCalledOnce();
    expect(mockJudge).toHaveBeenCalledWith(
      expect.objectContaining({ book_id: 'book_1', job_id: 'job_judge_1' }),
    );
  });
});

// ---------------------------------------------------------------------------
// (f) 冪等チェック — Job.status=done なら早期 return
// ---------------------------------------------------------------------------

describe('runPipelineBookJudge — idempotency', () => {
  it('(f-done) Job.status=done なら early return (judgeBook / addJob 未呼出)', async () => {
    const { job, book, theme, chapters, payload } = makeBaseData({ jobStatus: 'done' });
    const judgeOutput = makeDefaultJudgeOutput(85);
    const { prisma, captures } = buildPrisma({ jobs: [job], books: [book], themes: [theme], chapters });
    const { deps, judgeCalls, acquireCalls } = buildDeps(prisma, judgeOutput);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookJudge(payload, addJob, deps);

    expect(judgeCalls).toHaveLength(0);
    expect(addJobCalls).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(captures.evalResultCreates).toHaveLength(0);
    expect(captures.jobUpdateMany).toHaveLength(0);
  });

  it('(f-cas) CAS count=0 (他 worker が先取り) なら skip', async () => {
    const { job, book, theme, chapters, payload } = makeBaseData({ jobStatus: 'running' });
    const judgeOutput = makeDefaultJudgeOutput(85);
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      books: [book],
      themes: [theme],
      chapters,
      forceUpdateManyCount: 0,
    });
    const { deps, judgeCalls, acquireCalls } = buildDeps(prisma, judgeOutput);
    const { addJob } = makeAddJob();

    await runPipelineBookJudge(payload, addJob, deps);

    expect(judgeCalls).toHaveLength(0);
    expect(acquireCalls).toHaveLength(0);
    expect(captures.evalResultCreates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

describe('runPipelineBookJudge error paths', () => {
  it('payload zod 違反 → ValidationError', async () => {
    const { prisma } = buildPrisma({ jobs: [], books: [], themes: [], chapters: [] });
    const { deps } = buildDeps(prisma, makeDefaultJudgeOutput(85));
    const { addJob } = makeAddJob();

    await expect(runPipelineBookJudge({}, addJob, deps)).rejects.toBeInstanceOf(ValidationError);
  });

  it('Job 不在 → NotFoundError', async () => {
    const { book, theme, chapters } = makeBaseData();
    const { prisma } = buildPrisma({ jobs: [], books: [book], themes: [theme], chapters });
    const { deps } = buildDeps(prisma, makeDefaultJudgeOutput(85));
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookJudge({ book_id: 'book_1', job_id: 'job_missing' }, addJob, deps),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('Book 不在 → NotFoundError + Job=failed', async () => {
    const { job, theme, chapters, payload } = makeBaseData();
    const { prisma, captures } = buildPrisma({ jobs: [job], books: [], themes: [theme], chapters });
    const { deps } = buildDeps(prisma, makeDefaultJudgeOutput(85));
    const { addJob } = makeAddJob();

    await expect(runPipelineBookJudge(payload, addJob, deps)).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Chapter 0 件 → NotFoundError + Job=failed', async () => {
    const { job, book, theme, payload } = makeBaseData();
    const { prisma, captures } = buildPrisma({ jobs: [job], books: [book], themes: [theme], chapters: [] });
    const { deps } = buildDeps(prisma, makeDefaultJudgeOutput(85));
    const { addJob } = makeAddJob();

    await expect(runPipelineBookJudge(payload, addJob, deps)).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });
});
