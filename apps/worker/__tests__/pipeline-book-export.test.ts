import { describe, expect, it, vi } from 'vitest';

import {
  A2PError,
  NotFoundError,
  ValidationError,
} from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { UploadResult } from '@a2p/storage';

import {
  OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
} from '../src/tasks/optimizer-prompt-generate.js';
import {
  PIPELINE_BOOK_EXPORT_TASK_NAME,
  PipelineBookExportPayloadSchema,
  runPipelineBookExport,
  type AddJobLike,
  type PipelineBookExportDeps,
  type PipelineBookExportPrisma,
} from '../src/tasks/pipeline-book-export.js';

// ---------------------------------------------------------------------------
// test helpers
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

interface BookRecord {
  id: string;
  title: string;
  subtitle: string | null;
}

interface ChapterRecord {
  id: string;
  index: number;
  heading: string;
  body_md: string;
}

interface CoverRecord {
  id: string;
  book_id: string;
  status: string;
  r2_key: string;
}

interface ArtifactRecord {
  id: string;
  book_id: string;
  kind: string;
  r2_key: string;
  byte_size: number;
  checksum: string;
}

interface PrismaCaptures {
  jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobUpdateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  jobCreates: Array<{ data: Record<string, unknown> }>;
  artifactCreates: Array<{ data: Record<string, unknown> }>;
  bookUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  executeRawCalls: Array<{ sql: string; values: unknown[] }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  book?: BookRecord | null;
  chapters?: ChapterRecord[];
  covers?: CoverRecord[];
  forceUpdateManyCount?: number;
  /** book.count({ where: { status: 'done' } }) が返す値 (default: 0) */
  doneBookCount?: number;
  /** job.findFirst で返す既存 optimizer Job (default: null = 存在しない) */
  existingOptimizerJob?: { id: string } | null;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineBookExportPrisma;
  captures: PrismaCaptures;
  state: { jobs: JobRecord[]; artifacts: ArtifactRecord[] };
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    jobCreates: [],
    artifactCreates: [],
    bookUpdates: [],
    executeRawCalls: [],
  };
  const jobs = [...args.jobs];
  const artifacts: ArtifactRecord[] = [];
  let artifactCounter = 0;
  let jobCreateCounter = 0;

  const prisma: PipelineBookExportPrisma = {
    $executeRawUnsafe: async (sql, ...values) => {
      captures.executeRawCalls.push({ sql, values });
      return 1;
    },
    job: {
      findUnique: async ({ where }) => {
        const j = jobs.find((x) => x.id === where.id);
        return j ? { status: j.status, book_id: j.book_id } : null;
      },
      findFirst: async () => {
        // existingOptimizerJob が明示的に設定されていれば返す、なければ null
        return args.existingOptimizerJob ?? null;
      },
      create: async ({ data }) => {
        captures.jobCreates.push({ data: data as unknown as Record<string, unknown> });
        jobCreateCounter += 1;
        const id = `optimizer_job_${jobCreateCounter}`;
        return { id };
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
      findUnique: async () => {
        return args.book ?? null;
      },
      update: async ({ where, data }) => {
        captures.bookUpdates.push({
          where,
          data: data as unknown as Record<string, unknown>,
        });
        return {};
      },
      count: async () => {
        return args.doneBookCount ?? 0;
      },
    },
    chapter: {
      findMany: async () => {
        return args.chapters ?? [];
      },
    },
    cover: {
      findFirst: async ({ where }) => {
        const c = (args.covers ?? []).find(
          (x) => x.book_id === where.book_id && x.status === where.status,
        );
        return c ? { id: c.id, r2_key: c.r2_key } : null;
      },
    },
    artifact: {
      deleteMany: async ({ where }: { where: { book_id: string; kind: { in: string[] } } }) => {
        const before = artifacts.length;
        for (let i = artifacts.length - 1; i >= 0; i--) {
          if (artifacts[i]!.book_id === where.book_id && where.kind.in.includes(artifacts[i]!.kind)) {
            artifacts.splice(i, 1);
          }
        }
        return { count: before - artifacts.length };
      },
      create: async ({ data }) => {
        captures.artifactCreates.push({ data: data as unknown as Record<string, unknown> });
        artifactCounter += 1;
        const id = `artifact_${artifactCounter}`;
        artifacts.push({
          id,
          book_id: data.book_id,
          kind: data.kind,
          r2_key: data.r2_key,
          byte_size: data.byte_size,
          checksum: data.checksum,
        });
        return { id };
      },
    },
  };

  return { prisma, captures, state: { jobs, artifacts } };
}

function makeDefaultFixtures(opts?: { jobStatus?: string }): {
  job: JobRecord;
  book: BookRecord;
  chapters: ChapterRecord[];
  covers: CoverRecord[];
} {
  const job: JobRecord = {
    id: 'job_export_1',
    status: opts?.jobStatus ?? 'queued',
    book_id: 'book_1',
  };
  const book: BookRecord = {
    id: 'book_1',
    title: 'テスト書籍タイトル',
    subtitle: 'テストサブタイトル',
  };
  const chapters: ChapterRecord[] = [
    { id: 'ch_1', index: 0, heading: '第1章 はじめに', body_md: '# はじめに\n\nテスト本文です。' },
    { id: 'ch_2', index: 1, heading: '第2章 本論', body_md: '# 本論\n\n詳細な内容です。' },
  ];
  const covers: CoverRecord[] = [
    {
      id: 'cover_adopted_1',
      book_id: 'book_1',
      status: 'adopted',
      r2_key: 'books/book_1/covers/raw/cover_adopted_1.jpg',
    },
  ];
  return { job, book, chapters, covers };
}

function makeUploadResult(key: string, size = 1024): UploadResult {
  return {
    key,
    sha256: `sha256_${key.replace(/[^a-zA-Z0-9]/g, '_')}`,
    size,
    contentType: 'application/octet-stream',
  };
}

function buildDeps(
  prisma: PipelineBookExportPrisma,
  overrides: Partial<PipelineBookExportDeps> = {},
): {
  deps: PipelineBookExportDeps;
  buildDocxCalls: Array<unknown>;
  buildPdfCalls: Array<unknown>;
  resizeCoverCalls: Array<unknown>;
  uploadCalls: Array<{ key: string; contentType: string }>;
  downloadCalls: Array<{ key: string }>;
  notifyCalls: Array<{ payload: unknown }>;
  sendMailCalls: Array<{ template: string; data: Record<string, unknown> }>;
  loggerCalls: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
} {
  const { logger, calls: loggerCalls } = makeLogger();
  const buildDocxCalls: Array<unknown> = [];
  const buildPdfCalls: Array<unknown> = [];
  const resizeCoverCalls: Array<unknown> = [];
  const uploadCalls: Array<{ key: string; contentType: string }> = [];
  const downloadCalls: Array<{ key: string }> = [];
  const notifyCalls: Array<{ payload: unknown }> = [];
  const sendMailCalls: Array<{ template: string; data: Record<string, unknown> }> = [];

  const baseDeps: PipelineBookExportDeps = {
    prisma,
    logger,
    now: () => new Date('2026-05-25T00:00:00Z'),
    acquireLock: vi.fn().mockResolvedValue({
      book_id: 'book_1',
      holder: 'pipeline:job_export_1',
      acquired_at: new Date(),
      expires_at: new Date(),
    }),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    buildDocx: (async (...args: unknown[]) => {
      buildDocxCalls.push(args);
      return Buffer.from('docx-content');
    }) as unknown as PipelineBookExportDeps['buildDocx'],
    buildPdf: (async (...args: unknown[]) => {
      buildPdfCalls.push(args);
      return Buffer.from('pdf-content');
    }) as unknown as PipelineBookExportDeps['buildPdf'],
    resizeCover: (async (...args: unknown[]) => {
      resizeCoverCalls.push(args);
      return Buffer.from('resized-cover');
    }) as unknown as PipelineBookExportDeps['resizeCover'],
    uploadBuffer: (async (key: string, _buf: Buffer, contentType: string) => {
      uploadCalls.push({ key, contentType });
      return makeUploadResult(key, 1024);
    }) as unknown as PipelineBookExportDeps['uploadBuffer'],
    downloadBuffer: (async (key: string) => {
      downloadCalls.push({ key });
      return Buffer.from('raw-cover-image');
    }) as unknown as PipelineBookExportDeps['downloadBuffer'],
    notifyJobChange: (async (payload: unknown) => {
      notifyCalls.push({ payload });
      return { ok: true };
    }) as unknown as PipelineBookExportDeps['notifyJobChange'],
    sendMail: async (params: { template: string; data: Record<string, unknown> }) => {
      sendMailCalls.push(params);
    },
  };
  return {
    deps: { ...baseDeps, ...overrides },
    buildDocxCalls,
    buildPdfCalls,
    resizeCoverCalls,
    uploadCalls,
    downloadCalls,
    notifyCalls,
    sendMailCalls,
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

describe('pipeline.book.export payload schema', () => {
  it('task identifier が docs/05 ss5.3.9 と一致する', () => {
    expect(PIPELINE_BOOK_EXPORT_TASK_NAME).toBe('pipeline.book.export');
  });

  it('book_id / job_id を必須', () => {
    expect(
      PipelineBookExportPayloadSchema.safeParse({ book_id: 'b1', job_id: 'j1' }).success,
    ).toBe(true);
    expect(PipelineBookExportPayloadSchema.safeParse({ book_id: 'b1' }).success).toBe(false);
    expect(PipelineBookExportPayloadSchema.safeParse({ job_id: 'j1' }).success).toBe(false);
    expect(PipelineBookExportPayloadSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// happy path: 3 artifacts (docx + pdf + cover_png)
// ---------------------------------------------------------------------------

describe('runPipelineBookExport happy path (3 artifacts)', () => {
  it('docx / pdf / cover_png 全て生成 + Artifact x3 INSERT + Book.status=done', async () => {
    const { job, book, chapters, covers } = makeDefaultFixtures();
    const { prisma, captures, state } = buildPrisma({
      jobs: [job],
      book,
      chapters,
      covers,
    });
    const {
      deps,
      buildDocxCalls,
      buildPdfCalls,
      resizeCoverCalls,
      uploadCalls,
      downloadCalls,
      notifyCalls,
      sendMailCalls,
    } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps);

    // CAS
    expect(captures.jobUpdateMany).toHaveLength(1);
    expect(captures.jobUpdateMany[0]?.data).toMatchObject({ status: 'running' });

    // buildDocx called with correct args
    expect(buildDocxCalls).toHaveLength(1);
    const docxArgs = buildDocxCalls[0] as unknown[];
    expect(docxArgs[0]).toMatchObject({ title: 'テスト書籍タイトル', subtitle: 'テストサブタイトル' });
    expect(docxArgs[1]).toHaveLength(2);

    // buildPdf called with correct args
    expect(buildPdfCalls).toHaveLength(1);
    const pdfArgs = buildPdfCalls[0] as unknown[];
    expect(pdfArgs[0]).toMatchObject({ title: 'テスト書籍タイトル' });
    expect(pdfArgs[1]).toHaveLength(2);

    // Cover download + resize
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0]).toMatchObject({
      key: 'books/book_1/covers/raw/cover_adopted_1.jpg',
    });
    expect(resizeCoverCalls).toHaveLength(1);

    // 3 uploads: docx + pdf + cover_png
    expect(uploadCalls).toHaveLength(3);
    expect(uploadCalls[0]?.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(uploadCalls[1]?.contentType).toBe('application/pdf');
    expect(uploadCalls[2]?.contentType).toBe('image/jpeg');
    expect(uploadCalls[2]?.key).toMatch(/\.jpg$/);

    // 3 Artifact INSERTs
    expect(captures.artifactCreates).toHaveLength(3);
    expect(captures.artifactCreates[0]?.data).toMatchObject({
      book_id: 'book_1',
      kind: 'docx',
    });
    expect(captures.artifactCreates[1]?.data).toMatchObject({
      book_id: 'book_1',
      kind: 'pdf',
    });
    expect(captures.artifactCreates[2]?.data).toMatchObject({
      book_id: 'book_1',
      kind: 'cover_png',
    });
    expect(state.artifacts).toHaveLength(3);

    // Book.status='done'
    expect(captures.bookUpdates).toHaveLength(1);
    expect(captures.bookUpdates[0]?.data).toMatchObject({
      status: 'done',
    });
    expect(captures.bookUpdates[0]?.data.done_at).toBeDefined();

    // Job.status='done' with result_json
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.data).toMatchObject({
      status: 'done',
      result_json: {
        artifact_ids: ['artifact_1', 'artifact_2', 'artifact_3'],
        cover_artifact_id: 'artifact_3',
      },
    });

    // alert.cost.check per_book enqueue (F-034 / T-07-02)
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[0]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    // SSE notify
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.payload).toMatchObject({
      jobId: 'job_export_1',
      status: 'done',
      kind: 'pipeline.book.export',
      bookId: 'book_1',
      phase: 'export_done',
    });

    // BookLock released
    expect(deps.releaseLock).toHaveBeenCalledWith({
      bookId: 'book_1',
      holder: 'pipeline:job_export_1',
    });

    // Completion email sent
    expect(sendMailCalls).toHaveLength(1);
    expect(sendMailCalls[0]).toMatchObject({
      template: 'book-done',
      data: { bookId: 'book_1', title: 'テスト書籍タイトル', artifactCount: 3 },
    });
  });
});

// ---------------------------------------------------------------------------
// happy path: no adopted cover (2 artifacts only)
// ---------------------------------------------------------------------------

describe('runPipelineBookExport no adopted cover (2 artifacts)', () => {
  it('adopted cover がなければ cover_png をスキップ、docx + pdf のみ', async () => {
    const { job, book, chapters } = makeDefaultFixtures();
    const { prisma, captures, state } = buildPrisma({
      jobs: [job],
      book,
      chapters,
      covers: [], // no adopted cover
    });
    const { deps, resizeCoverCalls, downloadCalls, uploadCalls } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps);

    // No cover processing
    expect(downloadCalls).toHaveLength(0);
    expect(resizeCoverCalls).toHaveLength(0);

    // 2 uploads: docx + pdf only
    expect(uploadCalls).toHaveLength(2);

    // 2 Artifact INSERTs
    expect(captures.artifactCreates).toHaveLength(2);
    expect(state.artifacts).toHaveLength(2);

    // Job done with cover_artifact_id=null
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall?.data).toMatchObject({
      result_json: {
        artifact_ids: ['artifact_1', 'artifact_2'],
        cover_artifact_id: null,
      },
    });

    // alert.cost.check per_book enqueue (F-034 / T-07-02)
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(addJobCalls[0]?.payload).toEqual({ scope: 'per_book', book_id: 'book_1' });

    // Book still set to done
    expect(captures.bookUpdates).toHaveLength(1);
    expect(captures.bookUpdates[0]?.data).toMatchObject({ status: 'done' });
  });
});

// ---------------------------------------------------------------------------
// cover raw image missing from R2 (skip cover_png gracefully)
// ---------------------------------------------------------------------------

describe('runPipelineBookExport cover raw missing from R2', () => {
  it('R2 に raw 画像がない場合は cover_png をスキップ', async () => {
    const { job, book, chapters, covers } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      book,
      chapters,
      covers,
    });
    const { deps, resizeCoverCalls, loggerCalls } = buildDeps(prisma, {
      downloadBuffer: (async () => null) as unknown as PipelineBookExportDeps['downloadBuffer'],
    });
    const { addJob } = makeAddJob();

    await runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps);

    expect(resizeCoverCalls).toHaveLength(0);
    expect(captures.artifactCreates).toHaveLength(2); // docx + pdf only
    expect(loggerCalls.some((c) => c.level === 'warn' && c.msg.includes('skipping cover_png'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

describe('runPipelineBookExport idempotency', () => {
  it('Job.status === done なら早期 return', async () => {
    const { job, book, chapters, covers } = makeDefaultFixtures({ jobStatus: 'done' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      book,
      chapters,
      covers,
    });
    const { deps, buildDocxCalls, buildPdfCalls, notifyCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps);

    expect(captures.jobUpdateMany).toHaveLength(0);
    expect(buildDocxCalls).toHaveLength(0);
    expect(buildPdfCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
    expect(captures.artifactCreates).toHaveLength(0);
  });

  it('CAS で count=0 (他 worker が先取り) なら skip', async () => {
    const { job, book, chapters, covers } = makeDefaultFixtures({ jobStatus: 'running' });
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      book,
      chapters,
      covers,
      forceUpdateManyCount: 0,
    });
    const { deps, buildDocxCalls } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps);

    expect(buildDocxCalls).toHaveLength(0);
    expect(captures.jobUpdates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

describe('runPipelineBookExport error paths', () => {
  it('payload zod 違反 -> ValidationError', async () => {
    const { prisma } = buildPrisma({ jobs: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(runPipelineBookExport({}, addJob, deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(runPipelineBookExport({}, addJob, deps)).rejects.toBeInstanceOf(A2PError);
  });

  it('Job 不在 -> NotFoundError', async () => {
    const { prisma } = buildPrisma({ jobs: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookExport({ book_id: 'book_1', job_id: 'job_missing' }, addJob, deps),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('Book 不在 -> NotFoundError, Job=failed', async () => {
    const { job } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({ jobs: [job], book: null });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Chapter 0 件 -> NotFoundError, Job=failed', async () => {
    const { job, book } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({ jobs: [job], book, chapters: [] });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps),
    ).rejects.toBeInstanceOf(NotFoundError);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('buildDocx throw -> 透過, Job=failed', async () => {
    const { job, book, chapters } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({ jobs: [job], book, chapters });
    const boom = new Error('docx generation failed');
    const { deps } = buildDeps(prisma, {
      buildDocx: (async () => {
        throw boom;
      }) as unknown as PipelineBookExportDeps['buildDocx'],
    });
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps),
    ).rejects.toBe(boom);

    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect((failedCall?.data.error as string).includes('docx generation failed')).toBe(true);
  });

  it('buildPdf throw -> 透過, Job=failed', async () => {
    const { job, book, chapters } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({ jobs: [job], book, chapters });
    const boom = new Error('pdf generation failed');
    const { deps } = buildDeps(prisma, {
      buildPdf: (async () => {
        throw boom;
      }) as unknown as PipelineBookExportDeps['buildPdf'],
    });
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps),
    ).rejects.toBe(boom);

    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('uploadBuffer throw -> 透過, Job=failed', async () => {
    const { job, book, chapters } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({ jobs: [job], book, chapters });
    const boom = new Error('R2 upload failed');
    const { deps } = buildDeps(prisma, {
      uploadBuffer: (async () => {
        throw boom;
      }) as unknown as PipelineBookExportDeps['uploadBuffer'],
    });
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps),
    ).rejects.toBe(boom);

    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// BookLock release in finally
// ---------------------------------------------------------------------------

describe('runPipelineBookExport BookLock release', () => {
  it('正常完了後に BookLock が解放される', async () => {
    const { job, book, chapters, covers } = makeDefaultFixtures();
    const { prisma } = buildPrisma({ jobs: [job], book, chapters, covers });
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps);

    expect(deps.releaseLock).toHaveBeenCalledTimes(1);
    expect(deps.releaseLock).toHaveBeenCalledWith({
      bookId: 'book_1',
      holder: 'pipeline:job_export_1',
    });
  });

  it('エラー時にも BookLock が解放される', async () => {
    const { job, book } = makeDefaultFixtures();
    const { prisma } = buildPrisma({ jobs: [job], book, chapters: [] }); // chapters empty causes error
    const { deps } = buildDeps(prisma);
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps),
    ).rejects.toThrow();

    expect(deps.releaseLock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// notify 失敗時の warn 継続
// ---------------------------------------------------------------------------

describe('runPipelineBookExport notify failure', () => {
  it('notifyJobChange が ok=false でも本処理は完走', async () => {
    const { job, book, chapters } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({ jobs: [job], book, chapters, covers: [] });
    const { deps } = buildDeps(prisma, {
      notifyJobChange: (async () => ({ ok: false })) as unknown as PipelineBookExportDeps['notifyJobChange'],
    });
    const { addJob } = makeAddJob();

    await runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps);

    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// sendMail failure is non-fatal
// ---------------------------------------------------------------------------

describe('runPipelineBookExport sendMail failure', () => {
  it('sendMail 失敗でも本処理は完走 (Job=done のまま)', async () => {
    const { job, book, chapters } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({ jobs: [job], book, chapters, covers: [] });
    const { deps, loggerCalls } = buildDeps(prisma, {
      sendMail: async () => {
        throw new Error('mail service unavailable');
      },
    });
    const { addJob } = makeAddJob();

    await runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps);

    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(
      loggerCalls.some((c) => c.level === 'warn' && c.msg.includes('completion email failed')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lock acquire failure
// ---------------------------------------------------------------------------

describe('runPipelineBookExport lock acquire failure', () => {
  it('acquireLock 失敗 -> Job=failed + throw', async () => {
    const { job, book, chapters, covers } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({ jobs: [job], book, chapters, covers });
    const lockErr = new Error('ConflictError: lock held');
    const { deps } = buildDeps(prisma, {
      acquireLock: (async () => {
        throw lockErr;
      }) as unknown as PipelineBookExportDeps['acquireLock'],
    });
    const { addJob } = makeAddJob();

    await expect(
      runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps),
    ).rejects.toBe(lockErr);

    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T-11-03: 10 冊出版完了トリガー
// ---------------------------------------------------------------------------

describe('runPipelineBookExport 10-book optimizer trigger (T-11-03)', () => {
  async function runWithDoneCount(doneCount: number, existingOptimizerJob?: { id: string } | null) {
    const { job, book, chapters, covers } = makeDefaultFixtures();
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      book,
      chapters,
      covers: [], // cover なし (2 artifacts) — シンプルケース
      doneBookCount: doneCount,
      existingOptimizerJob: existingOptimizerJob ?? null,
    });
    const { deps } = buildDeps(prisma);
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps);

    return { captures, addJobCalls };
  }

  it('doneCount=10 のとき optimizer.prompt.generate が 1 回 enqueue される', async () => {
    const { addJobCalls, captures } = await runWithDoneCount(10);

    // alert.cost.check + optimizer.prompt.generate の 2 呼び出し
    expect(addJobCalls).toHaveLength(2);
    const optimizerCall = addJobCalls.find(
      (c) => c.identifier === OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
    );
    expect(optimizerCall).toBeDefined();
    expect(optimizerCall?.payload).toMatchObject({
      trigger: 'cron_10_books',
      job_id: 'optimizer_job_1',
    });
    expect(optimizerCall?.spec).toMatchObject({ maxAttempts: 2 });

    // job.create が 1 回呼ばれた
    expect(captures.jobCreates).toHaveLength(1);
    expect(captures.jobCreates[0]?.data).toMatchObject({
      kind: OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
      book_id: null,
      status: 'queued',
    });
  });

  it('doneCount=11 のときは optimizer が enqueue されない', async () => {
    const { addJobCalls, captures } = await runWithDoneCount(11);

    // alert.cost.check のみ
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(captures.jobCreates).toHaveLength(0);
  });

  it('doneCount=20 のとき再度 optimizer が enqueue される', async () => {
    const { addJobCalls, captures } = await runWithDoneCount(20);

    expect(addJobCalls).toHaveLength(2);
    const optimizerCall = addJobCalls.find(
      (c) => c.identifier === OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
    );
    expect(optimizerCall).toBeDefined();
    expect(captures.jobCreates).toHaveLength(1);
  });

  it('doneCount=0 のときは optimizer が enqueue されない', async () => {
    const { addJobCalls } = await runWithDoneCount(0);

    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
  });

  it('doneCount=9 のときは optimizer が enqueue されない', async () => {
    const { addJobCalls } = await runWithDoneCount(9);

    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
  });

  it('既存 optimizer Job が queued のときは重複 enqueue しない', async () => {
    const { addJobCalls, captures } = await runWithDoneCount(10, { id: 'existing_optimizer_job' });

    // alert.cost.check のみ (optimizer はスキップ)
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(captures.jobCreates).toHaveLength(0);
  });

  it('既存 optimizer Job が running のときも重複 enqueue しない', async () => {
    // findFirst の返値が non-null であればステータスに関わらずスキップ
    const { addJobCalls, captures } = await runWithDoneCount(10, { id: 'running_optimizer_job' });

    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
    expect(captures.jobCreates).toHaveLength(0);
  });

  it('skipOptimizerTrigger=true のとき optimizer は enqueue されない', async () => {
    const { job, book, chapters } = makeDefaultFixtures();
    const { prisma } = buildPrisma({
      jobs: [job],
      book,
      chapters,
      covers: [],
      doneBookCount: 10,
    });
    const { deps } = buildDeps(prisma, { skipOptimizerTrigger: true });
    const { addJob, calls: addJobCalls } = makeAddJob();

    await runPipelineBookExport({ book_id: 'book_1', job_id: 'job_export_1' }, addJob, deps);

    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]?.identifier).toBe('alert.cost.check');
  });
});

// ---------------------------------------------------------------------------
// T-11-03: best-effort — トリガー失敗が export の done 状態を壊さない
// ---------------------------------------------------------------------------

describe('runPipelineBookExport optimizer trigger best-effort (T-11-03)', () => {
  async function runWithThrowingTrigger(
    throwOn: 'book.count' | 'job.create' | 'addJob',
  ) {
    const { job, book, chapters } = makeDefaultFixtures();
    const { prisma: basePrisma, captures } = buildPrisma({
      jobs: [job],
      book,
      chapters,
      covers: [],
      doneBookCount: 10, // %10===0 → trigger 実行パスへ
    });

    const boom = new Error(`${throwOn} throw`);

    // 必要なメソッドだけ throw するように上書き
    const prisma: PipelineBookExportPrisma = {
      ...basePrisma,
      book: {
        ...basePrisma.book,
        count: throwOn === 'book.count'
          ? async () => { throw boom; }
          : basePrisma.book.count,
      },
      job: {
        ...basePrisma.job,
        create: throwOn === 'job.create'
          ? async () => { throw boom; }
          : basePrisma.job.create,
      },
    };

    const throwingAddJob: AddJobLike = throwOn === 'addJob'
      ? async (identifier) => {
          if (identifier === OPTIMIZER_PROMPT_GENERATE_TASK_NAME) throw boom;
          return { id: 'gw_cost' };
        }
      : makeAddJob().addJob;

    const { deps, loggerCalls } = buildDeps(prisma);

    await runPipelineBookExport(
      { book_id: 'book_1', job_id: 'job_export_1' },
      throwingAddJob,
      deps,
    );

    return { captures, loggerCalls };
  }

  it('book.count が throw しても例外が外に伝播しない', async () => {
    await expect(runWithThrowingTrigger('book.count')).resolves.toBeDefined();
  });

  it('book.count が throw しても Job が done のまま (status:failed が現れない)', async () => {
    const { captures } = await runWithThrowingTrigger('book.count');
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeUndefined();
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
  });

  it('book.count が throw したとき warn ログが出る', async () => {
    const { loggerCalls } = await runWithThrowingTrigger('book.count');
    expect(
      loggerCalls.some((c) => c.level === 'warn' && c.msg.includes('optimizer trigger failed (non-fatal)')),
    ).toBe(true);
  });

  it('job.create が throw しても例外が外に伝播しない', async () => {
    await expect(runWithThrowingTrigger('job.create')).resolves.toBeDefined();
  });

  it('job.create が throw しても Job が done のまま', async () => {
    const { captures } = await runWithThrowingTrigger('job.create');
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeUndefined();
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
  });

  it('job.create が throw したとき warn ログが出る', async () => {
    const { loggerCalls } = await runWithThrowingTrigger('job.create');
    expect(
      loggerCalls.some((c) => c.level === 'warn' && c.msg.includes('optimizer trigger failed (non-fatal)')),
    ).toBe(true);
  });

  it('addJob(optimizer) が throw しても例外が外に伝播しない', async () => {
    await expect(runWithThrowingTrigger('addJob')).resolves.toBeDefined();
  });

  it('addJob(optimizer) が throw しても Job が done のまま', async () => {
    const { captures } = await runWithThrowingTrigger('addJob');
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeUndefined();
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
  });

  it('addJob(optimizer) が throw したとき warn ログが出る', async () => {
    const { loggerCalls } = await runWithThrowingTrigger('addJob');
    expect(
      loggerCalls.some((c) => c.level === 'warn' && c.msg.includes('optimizer trigger failed (non-fatal)')),
    ).toBe(true);
  });
});
