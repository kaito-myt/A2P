import { describe, expect, it, vi } from 'vitest';

import { ConflictError, NotFoundError, ValidationError } from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { WriterChapterOutput, WriterOutlineOutput } from '@a2p/contracts/agents/writer';

import {
  REVISION_BOOK_APPLY_TASK_NAME,
  RevisionBookApplyPayloadSchema,
  runRevisionBookApply,
  type RevisionBookApplyDeps,
  type RevisionBookApplyPrisma,
  type RevisionBookApplyTxClient,
} from '../src/tasks/revision-book-apply.js';
import { PIPELINE_BOOK_JUDGE_TASK_NAME } from '../src/tasks/pipeline-book-judge.js';

// ---------------------------------------------------------------------------
// Test helpers
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

interface CommentRecord {
  id: string;
  target_kind: string;
  target_id: string;
  body: string;
  priority: string;
  status: string;
  range_json: unknown;
  book_id: string;
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

interface RunRecord {
  id: string;
  status: string;
  result_summary_json: unknown;
  error: string | null;
}

interface PrismaCaptures {
  commentUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  runUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  revisionCreates: Array<{ data: Record<string, unknown> }>;
  chapterUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  outlineUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobCreates: Array<{ data: Record<string, unknown> }>;
  bookUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  commentCounts: Array<{ where: { book_id: string; status: string; priority?: string } }>;
  txCalls: number;
  executeRawCalls: Array<{ sql: string; values: unknown[] }>;
}

interface JobRecord {
  id: string;
  kind: string;
  book_id: string;
  parent_job_id: string;
  status: string;
  payload_json: unknown;
}

interface BuildPrismaArgs {
  comments: CommentRecord[];
  chapters: ChapterRecord[];
  books: BookRecord[];
  themes: ThemeRecord[];
  outlines?: OutlineRecord[];
  runs?: RunRecord[];
  executeRawThrow?: Error;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: RevisionBookApplyPrisma;
  captures: PrismaCaptures;
  state: {
    chapters: ChapterRecord[];
    chapterRevisions: ChapterRevisionRecord[];
    comments: CommentRecord[];
    runs: RunRecord[];
    jobs: JobRecord[];
  };
} {
  const captures: PrismaCaptures = {
    commentUpdates: [],
    runUpdates: [],
    revisionCreates: [],
    chapterUpdates: [],
    outlineUpdates: [],
    jobCreates: [],
    bookUpdates: [],
    commentCounts: [],
    txCalls: 0,
    executeRawCalls: [],
  };
  const chapters = [...args.chapters];
  const chapterRevisions: ChapterRevisionRecord[] = [];
  const comments = [...args.comments];
  const runs: RunRecord[] = [...(args.runs ?? [])];
  const jobs: JobRecord[] = [];
  let revisionCounter = 0;
  let jobCounter = 0;

  const txClient: RevisionBookApplyTxClient = {
    chapterRevision: {
      create: async ({ data }) => {
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

  const prisma: RevisionBookApplyPrisma = {
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
      create: async ({ data }) => {
        captures.jobCreates.push({ data: data as unknown as Record<string, unknown> });
        jobCounter += 1;
        const id = `judge_job_${jobCounter}`;
        jobs.push({
          id,
          kind: data.kind,
          book_id: data.book_id,
          parent_job_id: data.parent_job_id,
          status: data.status,
          payload_json: data.payload_json,
        });
        return { id };
      },
    },
    revisionComment: {
      findMany: async ({ where }) => {
        const ids = where.id.in;
        const bookId = where.book_id;
        return comments
          .filter((c) => ids.includes(c.id) && c.book_id === bookId)
          .map((c) => ({
            id: c.id,
            target_kind: c.target_kind,
            target_id: c.target_id,
            body: c.body,
            priority: c.priority,
            status: c.status,
            range_json: c.range_json,
          }));
      },
      update: async ({ where, data }) => {
        captures.commentUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        const c = comments.find((x) => x.id === where.id);
        if (c && typeof data.status === 'string') {
          c.status = data.status;
        }
        return { id: where.id };
      },
      count: async ({ where }) => {
        captures.commentCounts.push({ where });
        return comments.filter(
          (c) =>
            c.book_id === where.book_id &&
            c.status === where.status &&
            (where.priority === undefined || c.priority === where.priority),
        ).length;
      },
    },
    revisionRun: {
      update: async ({ where, data }) => {
        captures.runUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        const r = runs.find((x) => x.id === where.id);
        if (r) {
          if (typeof data.status === 'string') r.status = data.status;
          if (data.result_summary_json !== undefined) {
            r.result_summary_json = data.result_summary_json;
          }
          if (data.error !== undefined) r.error = data.error ?? null;
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
      update: async ({ where, data }) => {
        captures.bookUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        return { id: where.id };
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
      findUnique: async ({ where }) => {
        const ch = chapters.find((c) => c.id === where.id);
        return ch
          ? {
              id: ch.id,
              book_id: ch.book_id,
              index: ch.index,
              heading: ch.heading,
              body_md: ch.body_md,
              version: ch.version,
            }
          : null;
      },
    },
    outline: {
      findFirst: async ({ where }) => {
        const o = (args.outlines ?? []).find((x) => x.book_id === where.book_id);
        return o
          ? {
              id: o.id,
              book_id: o.book_id,
              chapters_json: o.chapters_json,
              status: o.status,
            }
          : null;
      },
      update: async ({ where, data }) => {
        captures.outlineUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        return { id: where.id };
      },
    },
  };

  return { prisma, captures, state: { chapters, chapterRevisions, comments, runs, jobs } };
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const BOOK_ID = 'book_1';
const RUN_ID = 'run_1';
const JOB_ID = 'job_1';
const CHAPTER_ID = 'ch_1';
const COMMENT_CHAPTER_ID = 'cmt_ch_1';
const COMMENT_COVER_ID = 'cmt_cover_1';
const THEME_ID = 'theme_1';
const ACCOUNT_ID = 'account_1';
const OUTLINE_ID = 'outline_1';
const COMMENT_OUTLINE_ID = 'cmt_outline_1';

const defaultBook: BookRecord = {
  id: BOOK_ID,
  account_id: ACCOUNT_ID,
  theme_id: THEME_ID,
  title: 'テスト書籍',
  subtitle: 'テスト副題',
};

const defaultTheme: ThemeRecord = {
  id: THEME_ID,
  genre: 'practical',
  title: 'テスト書籍',
  subtitle: 'テスト副題',
  hook: 'テストフック',
  target_reader: 'テスト読者',
};

const defaultChapter: ChapterRecord = {
  id: CHAPTER_ID,
  book_id: BOOK_ID,
  index: 1,
  heading: '第1章 はじめに',
  body_md: '## 概要\nこれは第1章の本文です。テスト用コンテンツですが十分な長さがあります。\n\n## まとめ\nまとめの内容です。',
  version: 1,
};

const defaultRun: RunRecord = {
  id: RUN_ID,
  status: 'queued',
  result_summary_json: null,
  error: null,
};

const defaultOutline: OutlineRecord = {
  id: OUTLINE_ID,
  book_id: BOOK_ID,
  chapters_json: [
    { index: 1, heading: '第1章', summary: '概要', target_chars: 5000, subheadings: ['概要'] },
    { index: 2, heading: '第2章', summary: '本題', target_chars: 5000, subheadings: ['本題'] },
    { index: 3, heading: '第3章', summary: '応用', target_chars: 5000, subheadings: ['応用'] },
    { index: 4, heading: '第4章', summary: '事例', target_chars: 5000, subheadings: ['事例'] },
    { index: 5, heading: '第5章', summary: '戦略', target_chars: 5000, subheadings: ['戦略'] },
    { index: 6, heading: '第6章', summary: '実践', target_chars: 5000, subheadings: ['実践'] },
    { index: 7, heading: '第7章', summary: 'まとめ', target_chars: 5000, subheadings: ['まとめ'] },
  ],
  status: 'approved',
};

function makeOutlineComment(overrides?: Partial<CommentRecord>): CommentRecord {
  return {
    id: COMMENT_OUTLINE_ID,
    target_kind: 'outline',
    target_id: OUTLINE_ID,
    body: 'アウトラインの構成を見直してください',
    priority: 'should',
    status: 'pending',
    range_json: null,
    book_id: BOOK_ID,
    ...overrides,
  };
}

function makeChapterComment(overrides?: Partial<CommentRecord>): CommentRecord {
  return {
    id: COMMENT_CHAPTER_ID,
    target_kind: 'chapter',
    target_id: CHAPTER_ID,
    body: 'この章の導入部分をもっと具体的にしてください',
    priority: 'must',
    status: 'pending',
    range_json: null,
    book_id: BOOK_ID,
    ...overrides,
  };
}

function makeCoverComment(overrides?: Partial<CommentRecord>): CommentRecord {
  return {
    id: COMMENT_COVER_ID,
    target_kind: 'cover',
    target_id: 'cover_1',
    body: 'カバーの色を変更してください',
    priority: 'should',
    status: 'pending',
    range_json: null,
    book_id: BOOK_ID,
    ...overrides,
  };
}

function makePayload(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    book_id: BOOK_ID,
    comment_ids: [COMMENT_CHAPTER_ID],
    job_id: JOB_ID,
    ...overrides,
  };
}

// Generate a body_md string of a given codepoint length
function makeBodyMd(length: number): string {
  const base = 'あ'.repeat(length);
  return base;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RevisionBookApplyPayloadSchema', () => {
  it('accepts a valid payload', () => {
    const result = RevisionBookApplyPayloadSchema.safeParse(makePayload());
    expect(result.success).toBe(true);
  });

  it('rejects missing run_id', () => {
    const result = RevisionBookApplyPayloadSchema.safeParse(
      makePayload({ run_id: undefined }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects empty comment_ids', () => {
    const result = RevisionBookApplyPayloadSchema.safeParse(
      makePayload({ comment_ids: [] }),
    );
    expect(result.success).toBe(false);
  });
});

describe('runRevisionBookApply', () => {
  const fixedNow = new Date('2026-05-26T00:00:00Z');
  const nowFn = () => fixedNow;

  // Successful lock that does nothing
  const acquireLockOk = vi.fn().mockResolvedValue({
    book_id: BOOK_ID,
    holder: `revision_run:${RUN_ID}`,
    acquired_at: fixedNow,
    expires_at: new Date(fixedNow.getTime() + 30 * 60_000),
  });
  const releaseLockOk = vi.fn().mockResolvedValue(undefined);
  const addJobOk = vi.fn().mockResolvedValue(undefined);

  // Fake generateChapter that returns a valid chapter
  const fakeGenerateChapter = vi.fn().mockImplementation(async () => {
    const bodyMd = makeBodyMd(5000);
    return {
      heading: '第1章 はじめに (修正版)',
      body_md: bodyMd,
      char_count: [...bodyMd].length,
    } satisfies WriterChapterOutput;
  });

  // Fake generateOutline that returns a valid outline
  const fakeGenerateOutline = vi.fn().mockImplementation(async () => {
    return {
      chapters: [
        { index: 1, heading: '改訂第1章', summary: '改訂概要', target_chars: 6000, subheadings: ['改訂概要'] },
        { index: 2, heading: '改訂第2章', summary: '改訂本題', target_chars: 6000, subheadings: ['改訂本題'] },
        { index: 3, heading: '改訂第3章', summary: '改訂応用', target_chars: 6000, subheadings: ['改訂応用'] },
        { index: 4, heading: '改訂第4章', summary: '改訂事例', target_chars: 6000, subheadings: ['改訂事例'] },
        { index: 5, heading: '改訂第5章', summary: '改訂戦略', target_chars: 6000, subheadings: ['改訂戦略'] },
        { index: 6, heading: '改訂第6章', summary: '改訂実践', target_chars: 6000, subheadings: ['改訂実践'] },
        { index: 7, heading: '改訂第7章', summary: '改訂まとめ', target_chars: 6000, subheadings: ['改訂まとめ'] },
      ],
      totalCharsEstimate: 42000,
      notes: 'テスト用改訂アウトライン',
    } satisfies WriterOutlineOutput;
  });

  function baseDeps(overrides?: Partial<RevisionBookApplyDeps>): RevisionBookApplyDeps {
    const { logger } = makeLogger();
    return {
      logger,
      acquireLock: acquireLockOk,
      releaseLock: releaseLockOk,
      generateChapter: fakeGenerateChapter,
      generateOutline: fakeGenerateOutline,
      now: nowFn,
      addJob: addJobOk,
      ...overrides,
    };
  }

  // ----------------------------------------------------------
  // 1. chapter comment -> Chapter version++ + ChapterRevision
  // ----------------------------------------------------------
  it('applies chapter comment: version++, ChapterRevision created', async () => {
    const { logger } = makeLogger();
    const { prisma, captures, state } = buildPrisma({
      comments: [makeChapterComment()],
      chapters: [{ ...defaultChapter }],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(makePayload(), {
      ...baseDeps({ logger, prisma }),
      prisma,
    });

    // ChapterRevision created with old version
    expect(captures.revisionCreates).toHaveLength(1);
    expect(captures.revisionCreates[0]!.data).toMatchObject({
      chapter_id: CHAPTER_ID,
      book_id: BOOK_ID,
      version: 1,
      reason: `revision_run:${RUN_ID}`,
    });
    expect(captures.revisionCreates[0]!.data.body_md).toBe(defaultChapter.body_md);

    // Chapter updated with version+1
    expect(captures.chapterUpdates).toHaveLength(1);
    expect(captures.chapterUpdates[0]!.data.version).toBe(2);
    expect(captures.chapterUpdates[0]!.data.char_count).toBe(5000);

    // Comment marked as applied
    const commentUpdate = captures.commentUpdates.find(
      (u) => u.where.id === COMMENT_CHAPTER_ID,
    );
    expect(commentUpdate).toBeDefined();
    expect(commentUpdate!.data.status).toBe('applied');
    expect(commentUpdate!.data.applied_at).toEqual(fixedNow);

    // Run marked as done
    const runUpdate = captures.runUpdates.find(
      (u) => (u.data as Record<string, unknown>).status === 'done',
    );
    expect(runUpdate).toBeDefined();

    // Transaction was called
    expect(captures.txCalls).toBe(1);

    // pg_notify was called for progress
    expect(captures.executeRawCalls.length).toBeGreaterThanOrEqual(1);

    // Lock was acquired and released
    expect(acquireLockOk).toHaveBeenCalledWith({
      bookId: BOOK_ID,
      holder: `revision_run:${RUN_ID}`,
      ttlMinutes: 30,
    });
    expect(releaseLockOk).toHaveBeenCalledWith({
      bookId: BOOK_ID,
      holder: `revision_run:${RUN_ID}`,
    });

    // State: chapter version updated
    expect(state.chapters[0]!.version).toBe(2);

    // State: revision created
    expect(state.chapterRevisions).toHaveLength(1);
    expect(state.chapterRevisions[0]!.version).toBe(1);
  });

  // ----------------------------------------------------------
  // 2. Mixed chapter + cover comments -> all comments applied
  // ----------------------------------------------------------
  it('applies mixed chapter+cover comments: all become applied', async () => {
    const { logger } = makeLogger();
    const chapterComment = makeChapterComment();
    const coverComment = makeCoverComment();
    const { prisma, captures, state } = buildPrisma({
      comments: [chapterComment, coverComment],
      chapters: [{ ...defaultChapter }],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(
      makePayload({ comment_ids: [COMMENT_CHAPTER_ID, COMMENT_COVER_ID] }),
      { ...baseDeps({ logger, prisma }), prisma },
    );

    // Both comments applied
    expect(state.comments.filter((c) => c.status === 'applied')).toHaveLength(2);

    // Chapter comment went through generateChapter path
    expect(captures.txCalls).toBe(1);
    expect(captures.revisionCreates).toHaveLength(1);

    // Cover comment triggers a real cover regeneration with feedback (not a no-op placeholder).
    const coverUpdate = captures.commentUpdates.find(
      (u) => u.where.id === COMMENT_COVER_ID,
    );
    expect(coverUpdate).toBeDefined();
    expect(coverUpdate!.data.status).toBe('applied');
    const coverResult = coverUpdate!.data.application_result_json as Record<string, unknown>;
    expect(coverResult.action).toBe('cover_regenerate_enqueued');
    expect(coverResult.regenerate_job_id).toBeTruthy();

    // Run summary
    const finalRunUpdate = captures.runUpdates.find(
      (u) => (u.data as Record<string, unknown>).finished_at !== undefined,
    );
    expect(finalRunUpdate).toBeDefined();
    const resultSummary = (finalRunUpdate!.data as Record<string, unknown>)
      .result_summary_json as Record<string, unknown>;
    expect(resultSummary.applied).toBe(2);
  });

  // ----------------------------------------------------------
  // 3. BookLock conflict -> blocked_books
  // ----------------------------------------------------------
  it('BookLock conflict: adds to blocked_books and returns normally', async () => {
    const { logger, calls } = makeLogger();
    const lockConflict = vi.fn().mockRejectedValue(
      new ConflictError('BookLock conflict: book_1 already held', {
        details: { reason: 'book_locked', bookId: BOOK_ID },
      }),
    );
    const { prisma, captures } = buildPrisma({
      comments: [makeChapterComment()],
      chapters: [{ ...defaultChapter }],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    // Should NOT throw
    await runRevisionBookApply(makePayload(), {
      ...baseDeps({ logger, prisma, acquireLock: lockConflict }),
      prisma,
    });

    // Run summary updated with blocked_books
    expect(captures.runUpdates).toHaveLength(1);
    const summary = captures.runUpdates[0]!.data
      .result_summary_json as Record<string, unknown>;
    expect(summary.blocked_books).toEqual([BOOK_ID]);

    // No chapter modifications
    expect(captures.txCalls).toBe(0);
    expect(captures.revisionCreates).toHaveLength(0);

    // Info log about conflict
    const conflictLog = calls.find((c) => c.msg.includes('blocked_books'));
    expect(conflictLog).toBeDefined();
  });

  // ----------------------------------------------------------
  // 4. Invalid payload -> ValidationError
  // ----------------------------------------------------------
  it('throws ValidationError for invalid payload', async () => {
    await expect(
      runRevisionBookApply({ run_id: '' }, baseDeps()),
    ).rejects.toThrow(ValidationError);
  });

  // ----------------------------------------------------------
  // 5. Book not found -> NotFoundError
  // ----------------------------------------------------------
  it('throws NotFoundError when book does not exist', async () => {
    const { logger } = makeLogger();
    const { prisma } = buildPrisma({
      comments: [makeChapterComment()],
      chapters: [],
      books: [], // no books
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await expect(
      runRevisionBookApply(makePayload(), {
        ...baseDeps({ logger, prisma }),
        prisma,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  // ----------------------------------------------------------
  // 6. cover_text / metadata / theme -> placeholder applied
  // ----------------------------------------------------------
  it('placeholder target_kinds (cover_text, metadata, theme) are applied', async () => {
    const { logger } = makeLogger();
    const coverTextComment = makeCoverComment({
      id: 'cmt_ct_1',
      target_kind: 'cover_text',
    });
    const metadataComment = makeCoverComment({
      id: 'cmt_md_1',
      target_kind: 'metadata',
    });
    const themeComment = makeCoverComment({
      id: 'cmt_th_1',
      target_kind: 'theme',
    });
    const { prisma, captures, state } = buildPrisma({
      comments: [coverTextComment, metadataComment, themeComment],
      chapters: [],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(
      makePayload({
        comment_ids: ['cmt_ct_1', 'cmt_md_1', 'cmt_th_1'],
      }),
      { ...baseDeps({ logger, prisma }), prisma },
    );

    // All 3 comments applied
    expect(state.comments.filter((c) => c.status === 'applied')).toHaveLength(3);

    // All have placeholder reason
    for (const upd of captures.commentUpdates) {
      const result = upd.data.application_result_json as Record<string, unknown>;
      expect(result.reason).toBe('Phase 1: placeholder implementation');
    }

    // No transactions (no chapter work)
    expect(captures.txCalls).toBe(0);
  });

  // ----------------------------------------------------------
  // 7. Non-pending comments are skipped
  // ----------------------------------------------------------
  it('skips already-applied comments', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = buildPrisma({
      comments: [makeChapterComment({ status: 'applied' })],
      chapters: [{ ...defaultChapter }],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(makePayload(), {
      ...baseDeps({ logger, prisma }),
      prisma,
    });

    // No chapter processing
    expect(captures.txCalls).toBe(0);
    expect(captures.revisionCreates).toHaveLength(0);

    // Run completed (non-pending counts as not_applicable in summary)
    const finalUpdate = captures.runUpdates.find(
      (u) => (u.data as Record<string, unknown>).finished_at !== undefined,
    );
    expect(finalUpdate).toBeDefined();
  });

  // ----------------------------------------------------------
  // 8. generateChapter failure -> comment marked not_applicable
  // ----------------------------------------------------------
  it('marks comment as not_applicable when generateChapter fails', async () => {
    const { logger } = makeLogger();
    const failingGenerate = vi.fn().mockRejectedValue(
      new Error('LLM provider timeout'),
    );
    const { prisma, captures, state } = buildPrisma({
      comments: [makeChapterComment()],
      chapters: [{ ...defaultChapter }],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(makePayload(), {
      ...baseDeps({ logger, prisma, generateChapter: failingGenerate }),
      prisma,
    });

    // Comment marked not_applicable
    expect(state.comments[0]!.status).toBe('not_applicable');

    // Run has partial status (0 applied, 1 not_applicable)
    const finalUpdate = captures.runUpdates.find(
      (u) => (u.data as Record<string, unknown>).finished_at !== undefined,
    );
    expect(finalUpdate).toBeDefined();
    const summary = (finalUpdate!.data as Record<string, unknown>)
      .result_summary_json as Record<string, unknown>;
    expect(summary.not_applicable).toBe(1);
    expect(summary.applied).toBe(0);
  });

  // ----------------------------------------------------------
  // 9. pg_notify is called per comment
  // ----------------------------------------------------------
  it('sends pg_notify progress per comment', async () => {
    const { logger } = makeLogger();
    const chapterComment = makeChapterComment();
    const coverComment = makeCoverComment();
    const { prisma, captures } = buildPrisma({
      comments: [chapterComment, coverComment],
      chapters: [{ ...defaultChapter }],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(
      makePayload({ comment_ids: [COMMENT_CHAPTER_ID, COMMENT_COVER_ID] }),
      { ...baseDeps({ logger, prisma }), prisma },
    );

    // pg_notify called at least twice (once per comment)
    const notifyCalls = captures.executeRawCalls.filter(
      (c) => c.sql === 'SELECT pg_notify($1, $2)',
    );
    expect(notifyCalls.length).toBeGreaterThanOrEqual(2);

    // Each has the correct channel
    for (const call of notifyCalls) {
      expect(call.values[0]).toBe('revision_runs_progress');
    }
  });

  // ----------------------------------------------------------
  // 10. Lock released in finally even on error
  // ----------------------------------------------------------
  it('releases lock even when processing throws', async () => {
    const { logger } = makeLogger();
    const { prisma } = buildPrisma({
      comments: [makeChapterComment()],
      chapters: [{ ...defaultChapter }],
      books: [], // Book not found will throw
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await expect(
      runRevisionBookApply(makePayload(), {
        ...baseDeps({ logger, prisma }),
        prisma,
      }),
    ).rejects.toThrow(NotFoundError);

    // Lock was still released
    expect(releaseLockOk).toHaveBeenCalledWith({
      bookId: BOOK_ID,
      holder: `revision_run:${RUN_ID}`,
    });
  });

  // ----------------------------------------------------------
  // 11. outline comment -> generateOutline called, outline updated, comment applied
  // ----------------------------------------------------------
  it('applies outline comment: generateOutline called, outline updated', async () => {
    const { logger } = makeLogger();
    const outlineComment = makeOutlineComment();
    const { prisma, captures, state } = buildPrisma({
      comments: [outlineComment],
      chapters: [],
      books: [defaultBook],
      themes: [defaultTheme],
      outlines: [{ ...defaultOutline }],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(
      makePayload({ comment_ids: [COMMENT_OUTLINE_ID] }),
      { ...baseDeps({ logger, prisma }), prisma },
    );

    // generateOutline was called with correct input
    expect(fakeGenerateOutline).toHaveBeenCalledTimes(1);
    const outlineInput = fakeGenerateOutline.mock.calls[0]![0];
    expect(outlineInput.bookId).toBe(BOOK_ID);
    expect(outlineInput.rejectNote).toContain(outlineComment.body);

    // Outline was updated with new chapters_json
    expect(captures.outlineUpdates).toHaveLength(1);
    expect(captures.outlineUpdates[0]!.where.id).toBe(OUTLINE_ID);
    expect(captures.outlineUpdates[0]!.data.status).toBe('pending_review');
    expect(captures.outlineUpdates[0]!.data.reject_note).toBe(outlineComment.body);

    // Comment marked as applied
    const commentUpdate = captures.commentUpdates.find(
      (u) => u.where.id === COMMENT_OUTLINE_ID,
    );
    expect(commentUpdate).toBeDefined();
    expect(commentUpdate!.data.status).toBe('applied');
    expect(commentUpdate!.data.applied_at).toEqual(fixedNow);
    const resultJson = commentUpdate!.data.application_result_json as Record<string, unknown>;
    expect(resultJson.outline_id).toBe(OUTLINE_ID);
    expect(resultJson.chapters_count).toBe(7);

    // Run marked as done (all applied, no failures)
    const runUpdate = captures.runUpdates.find(
      (u) => (u.data as Record<string, unknown>).status === 'done',
    );
    expect(runUpdate).toBeDefined();
  });

  // ----------------------------------------------------------
  // 12. outline not found -> NotFoundError -> comment marked not_applicable
  // ----------------------------------------------------------
  it('marks outline comment as not_applicable when outline not found', async () => {
    const { logger } = makeLogger();
    const outlineComment = makeOutlineComment();
    const { prisma, captures, state } = buildPrisma({
      comments: [outlineComment],
      chapters: [],
      books: [defaultBook],
      themes: [defaultTheme],
      outlines: [], // no outlines
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(
      makePayload({ comment_ids: [COMMENT_OUTLINE_ID] }),
      { ...baseDeps({ logger, prisma }), prisma },
    );

    // Comment marked not_applicable
    expect(state.comments[0]!.status).toBe('not_applicable');

    // Run has partial status (0 applied, 1 not_applicable)
    const finalUpdate = captures.runUpdates.find(
      (u) => (u.data as Record<string, unknown>).finished_at !== undefined,
    );
    expect(finalUpdate).toBeDefined();
    const summary = (finalUpdate!.data as Record<string, unknown>)
      .result_summary_json as Record<string, unknown>;
    expect(summary.not_applicable).toBe(1);
    expect(summary.applied).toBe(0);
    expect((finalUpdate!.data as Record<string, unknown>).status).toBe('partial');
  });

  // ----------------------------------------------------------
  // 13. generateOutline failure -> comment marked not_applicable
  // ----------------------------------------------------------
  it('marks outline comment as not_applicable when generateOutline fails', async () => {
    const { logger } = makeLogger();
    const failingOutline = vi.fn().mockRejectedValue(
      new Error('LLM outline generation timeout'),
    );
    const outlineComment = makeOutlineComment();
    const { prisma, captures, state } = buildPrisma({
      comments: [outlineComment],
      chapters: [],
      books: [defaultBook],
      themes: [defaultTheme],
      outlines: [{ ...defaultOutline }],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(
      makePayload({ comment_ids: [COMMENT_OUTLINE_ID] }),
      { ...baseDeps({ logger, prisma, generateOutline: failingOutline }), prisma },
    );

    // generateOutline was called
    expect(failingOutline).toHaveBeenCalledTimes(1);

    // Comment marked not_applicable
    expect(state.comments[0]!.status).toBe('not_applicable');

    // Run has partial status
    const finalUpdate = captures.runUpdates.find(
      (u) => (u.data as Record<string, unknown>).finished_at !== undefined,
    );
    expect(finalUpdate).toBeDefined();
    const summary = (finalUpdate!.data as Record<string, unknown>)
      .result_summary_json as Record<string, unknown>;
    expect(summary.not_applicable).toBe(1);
    expect(summary.applied).toBe(0);
    expect((finalUpdate!.data as Record<string, unknown>).status).toBe('partial');
  });

  // ----------------------------------------------------------
  // 14. Judge rescore enqueue (Phase 2 hook)
  // ----------------------------------------------------------
  it('enqueues pipeline.book.judge with triggered_by=revision_run:<run_id> after all comments applied', async () => {
    const { logger } = makeLogger();
    const addJobMock = vi.fn().mockResolvedValue(undefined);
    const { prisma, captures, state } = buildPrisma({
      comments: [makeChapterComment()],
      chapters: [{ ...defaultChapter }],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(makePayload(), {
      ...baseDeps({ logger, prisma, addJob: addJobMock }),
      prisma,
    });

    // Job was created for judge rescore
    expect(captures.jobCreates).toHaveLength(1);
    const jobCreate = captures.jobCreates[0]!.data;
    expect(jobCreate.kind).toBe(PIPELINE_BOOK_JUDGE_TASK_NAME);
    expect(jobCreate.book_id).toBe(BOOK_ID);
    expect(jobCreate.parent_job_id).toBe(JOB_ID);
    expect(jobCreate.status).toBe('queued');
    const jobPayload = jobCreate.payload_json as Record<string, unknown>;
    expect(jobPayload.retry_count).toBe(0);
    expect(jobPayload.triggered_by).toBe(`revision_run:${RUN_ID}`);

    // addJob was called with correct args
    expect(addJobMock).toHaveBeenCalledOnce();
    const [taskName, addJobPayload] = addJobMock.mock.calls[0]!;
    expect(taskName).toBe(PIPELINE_BOOK_JUDGE_TASK_NAME);
    expect((addJobPayload as Record<string, unknown>).book_id).toBe(BOOK_ID);
    expect((addJobPayload as Record<string, unknown>).job_id).toBe('judge_job_1');
    expect((addJobPayload as Record<string, unknown>).retry_count).toBe(0);
    expect((addJobPayload as Record<string, unknown>).triggered_by).toBe(
      `revision_run:${RUN_ID}`,
    );

    // result_summary_json contains rescore_job_id
    const finalRunUpdate = captures.runUpdates.find(
      (u) => (u.data as Record<string, unknown>).finished_at !== undefined,
    );
    expect(finalRunUpdate).toBeDefined();
    const resultSummary = (finalRunUpdate!.data as Record<string, unknown>)
      .result_summary_json as Record<string, unknown>;
    expect(resultSummary.rescore_job_id).toBe('judge_job_1');

    // State: judge job stored in state
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]!.kind).toBe(PIPELINE_BOOK_JUDGE_TASK_NAME);
  });

  // ----------------------------------------------------------
  // 15. No addJob dep -> rescore not enqueued (backwards compat)
  // ----------------------------------------------------------
  it('does not enqueue rescore when addJob is not provided', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = buildPrisma({
      comments: [makeChapterComment()],
      chapters: [{ ...defaultChapter }],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(makePayload(), {
      ...baseDeps({ logger, prisma, addJob: undefined }),
      prisma,
    });

    // No judge Job created
    expect(captures.jobCreates).toHaveLength(0);

    // Run still completes normally without rescore_job_id
    const finalRunUpdate = captures.runUpdates.find(
      (u) => (u.data as Record<string, unknown>).finished_at !== undefined,
    );
    expect(finalRunUpdate).toBeDefined();
    const resultSummary = (finalRunUpdate!.data as Record<string, unknown>)
      .result_summary_json as Record<string, unknown>;
    expect(resultSummary.rescore_job_id).toBeUndefined();
  });

  // ----------------------------------------------------------
  // 16. Book comment flags are recomputed after applying the last must comment
  //     (regression: library "must ブロック中" badge went stale)
  // ----------------------------------------------------------
  it('recomputes has_blocking/has_pending to false when the last pending must comment is applied', async () => {
    const { logger } = makeLogger();
    // Single pending must chapter comment — book started with has_blocking_comments=true.
    const { prisma, captures } = buildPrisma({
      comments: [makeChapterComment({ priority: 'must', status: 'pending' })],
      chapters: [{ ...defaultChapter }],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    await runRevisionBookApply(makePayload(), {
      ...baseDeps({ logger, prisma }),
      prisma,
    });

    // book.update was called to recompute the denormalized flags.
    expect(captures.bookUpdates).toHaveLength(1);
    expect(captures.bookUpdates[0]!.where.id).toBe(BOOK_ID);
    // After the only must comment transitioned pending -> applied, both flags fall to false.
    expect(captures.bookUpdates[0]!.data.has_blocking_comments).toBe(false);
    expect(captures.bookUpdates[0]!.data.has_pending_comments).toBe(false);

    // Recompute predicate: counted pending, and pending+must, for this book.
    expect(captures.commentCounts).toEqual(
      expect.arrayContaining([
        { where: { book_id: BOOK_ID, status: 'pending' } },
        { where: { book_id: BOOK_ID, status: 'pending', priority: 'must' } },
      ]),
    );
  });

  // ----------------------------------------------------------
  // 17. Blocking clears but pending remains when a non-must comment is still pending
  // ----------------------------------------------------------
  it('clears has_blocking but keeps has_pending when a non-must comment stays pending', async () => {
    const { logger } = makeLogger();
    // must comment (chapter) gets applied; a should comment (cover_text) is NOT in this run and stays pending.
    const mustComment = makeChapterComment({ priority: 'must', status: 'pending' });
    const pendingShould = makeCoverComment({
      id: 'cmt_pending_should',
      target_kind: 'cover_text',
      priority: 'should',
      status: 'pending',
    });
    const { prisma, captures } = buildPrisma({
      comments: [mustComment, pendingShould],
      chapters: [{ ...defaultChapter }],
      books: [defaultBook],
      themes: [defaultTheme],
      runs: [{ ...defaultRun }],
    });

    // Only the must comment is targeted by this run.
    await runRevisionBookApply(
      makePayload({ comment_ids: [COMMENT_CHAPTER_ID] }),
      { ...baseDeps({ logger, prisma }), prisma },
    );

    expect(captures.bookUpdates).toHaveLength(1);
    // No pending must left -> blocking false; but the should comment is still pending.
    expect(captures.bookUpdates[0]!.data.has_blocking_comments).toBe(false);
    expect(captures.bookUpdates[0]!.data.has_pending_comments).toBe(true);
  });
});
