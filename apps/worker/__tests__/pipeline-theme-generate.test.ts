import { describe, expect, it, vi } from 'vitest';

import { A2PError, NotFoundError, ValidationError } from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { MarketerThemeOutput } from '@a2p/contracts/agents/marketer';

import {
  PIPELINE_THEME_GENERATE_TASK_NAME,
  PipelineThemeGeneratePayloadSchema,
  runPipelineThemeGenerate,
  type PipelineThemeGenerateDeps,
  type PipelineThemeGeneratePrisma,
} from '../src/tasks/pipeline-theme-generate.js';

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
  payload_json: unknown;
}

interface RecentTitleRecord {
  account_id: string;
  status: string;
  decided_at: Date;
  title: string;
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
  candidateCreateMany: Array<{ data: unknown[] }>;
  themeFindMany: Array<{ where: Record<string, unknown> }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  recentTitles?: RecentTitleRecord[];
  /** updateMany が返す count を強制する (CAS 失敗テスト用)。 */
  forceUpdateManyCount?: number;
  /** themeCandidate.createMany を強制失敗させる。 */
  createManyThrow?: Error;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: PipelineThemeGeneratePrisma;
  captures: PrismaCaptures;
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    candidateCreateMany: [],
    themeFindMany: [],
  };
  const jobs = [...args.jobs];
  const titles = args.recentTitles ?? [];

  const prisma: PipelineThemeGeneratePrisma = {
    job: {
      findUnique: async ({ where }) => {
        const j = jobs.find((x) => x.id === where.id);
        return j ? { status: j.status, payload_json: j.payload_json } : null;
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
    themeCandidate: {
      findMany: async ({ where }) => {
        captures.themeFindMany.push({
          where: where as unknown as Record<string, unknown>,
        });
        const w = where as {
          account_id: string;
          status: { in: string[] };
          decided_at?: { gte: Date };
        };
        return titles
          .filter(
            (t) =>
              t.account_id === w.account_id
              && w.status.in.includes(t.status)
              && (w.decided_at?.gte ? t.decided_at >= w.decided_at.gte : true),
          )
          .map((t) => ({ title: t.title }));
      },
      createMany: async ({ data }) => {
        if (args.createManyThrow) throw args.createManyThrow;
        captures.candidateCreateMany.push({ data });
        return { count: data.length };
      },
    },
  };
  return { prisma, captures };
}

function makeOkThemes(count = 10): MarketerThemeOutput {
  const candidates = Array.from({ length: count }, (_, i) => ({
    title: `テストテーマ ${i + 1}`,
    subtitle: i % 2 === 0 ? `副題 ${i + 1}` : undefined,
    hook: `差別化フック ${i + 1}`,
    target_reader: `想定読者 ${i + 1}`,
    competitors: [
      { title: `競合 ${i + 1}-A`, url: `https://example.com/${i}` },
    ],
    signals: {
      reasoning: `根拠 ${i + 1}`,
      market_score: 70,
      predicted_chapters: 8,
      search_keywords: ['副業', '時間術'],
      sources: [`https://example.com/${i}`],
      bestseller_evidence: [],
    },
  }));
  return { candidates, notes: `total ${count}` };
}

function makeJobPayload(overrides: Partial<{
  theme_session_id: string;
  account_id: string;
  genre: 'practical' | 'business' | 'self_help' | null;
  keyword_or_brief: string;
  count: number;
  exclude_titles_recent?: string[];
}> = {}): Record<string, unknown> {
  return {
    theme_session_id: 'tses_1',
    account_id: 'acc_1',
    genre: 'business',
    keyword_or_brief: '副業で月 10 万を稼ぐ',
    count: 10,
    ...overrides,
  };
}

function buildDeps(
  prisma: PipelineThemeGeneratePrisma,
  overrides: Partial<PipelineThemeGenerateDeps> = {},
): {
  deps: PipelineThemeGenerateDeps;
  generateCalls: Array<unknown>;
} {
  const { logger } = makeLogger();
  const generateCalls: Array<unknown> = [];

  const baseDeps: PipelineThemeGenerateDeps = {
    prisma,
    logger,
    now: () => new Date('2026-05-23T00:00:00Z'),
    generateThemes: (async (input: unknown) => {
      generateCalls.push(input);
      return makeOkThemes(10);
    }) as unknown as PipelineThemeGenerateDeps['generateThemes'],
  };
  return {
    deps: { ...baseDeps, ...overrides },
    generateCalls,
  };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('pipeline.theme.generate payload schema', () => {
  it('task identifier が pipeline.theme.generate に一致する', () => {
    expect(PIPELINE_THEME_GENERATE_TASK_NAME).toBe('pipeline.theme.generate');
  });

  it('theme_session_id / job_id を必須にする', () => {
    expect(
      PipelineThemeGeneratePayloadSchema.safeParse({
        theme_session_id: 'tses_1',
        job_id: 'job_1',
      }).success,
    ).toBe(true);
    expect(
      PipelineThemeGeneratePayloadSchema.safeParse({ job_id: 'job_1' }).success,
    ).toBe(false);
    expect(
      PipelineThemeGeneratePayloadSchema.safeParse({
        theme_session_id: 'tses_1',
      }).success,
    ).toBe(false);
    expect(
      PipelineThemeGeneratePayloadSchema.safeParse({
        theme_session_id: '',
        job_id: 'job_1',
      }).success,
    ).toBe(false);
  });
});

describe('runPipelineThemeGenerate happy path', () => {
  it('Job CAS → 直近採用済 fetch → Marketer 呼出 → ThemeCandidate.createMany → Job done', async () => {
    const job: JobRecord = {
      id: 'job_1',
      status: 'queued',
      payload_json: makeJobPayload(),
    };
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      recentTitles: [
        {
          account_id: 'acc_1',
          status: 'accepted',
          decided_at: new Date('2026-05-20T00:00:00Z'),
          title: '既出版タイトル A',
        },
      ],
    });
    const { deps, generateCalls } = buildDeps(prisma);

    await runPipelineThemeGenerate(
      { theme_session_id: 'tses_1', job_id: 'job_1' },
      deps,
    );

    // 1. CAS で running 化
    expect(captures.jobUpdateMany).toHaveLength(1);
    expect(captures.jobUpdateMany[0]?.data).toMatchObject({ status: 'running' });

    // 2. 直近 90 日 accepted の集計
    expect(captures.themeFindMany).toHaveLength(1);
    const findArg = captures.themeFindMany[0]?.where;
    expect(findArg).toMatchObject({
      account_id: 'acc_1',
      status: { in: ['accepted'] },
    });
    // decided_at >= now - 90d
    expect(findArg?.decided_at).toBeDefined();

    // 3. Marketer 呼出 (jobId は内部 Job.id, themeSessionId / accountId / genre 紐付け)
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]).toMatchObject({
      themeSessionId: 'tses_1',
      accountId: 'acc_1',
      jobId: 'job_1',
      genre: 'business',
      keywordOrBrief: '副業で月 10 万を稼ぐ',
      count: 10,
      excludeTitlesRecent: ['既出版タイトル A'],
    });

    // 4. ThemeCandidate.createMany (10 件)
    expect(captures.candidateCreateMany).toHaveLength(1);
    const rows = captures.candidateCreateMany[0]?.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(10);
    // 各行が schema 列名で書き込まれていること (snake_case)
    expect(rows[0]).toMatchObject({
      account_id: 'acc_1',
      theme_session_id: 'tses_1',
      genre: 'business',
      title: 'テストテーマ 1',
      hook: '差別化フック 1',
      target_reader: '想定読者 1',
      status: 'pending',
    });
    // competitors_json / signals_json は raw object のまま入っている
    expect((rows[0] as { competitors_json: unknown[] }).competitors_json).toHaveLength(1);
    expect((rows[0] as { signals_json: { market_score: number } }).signals_json.market_score).toBe(
      70,
    );

    // 5. Job.update で done に遷移
    const doneCall = captures.jobUpdates.find((c) => c.data.status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall?.where).toEqual({ id: 'job_1' });
    expect(doneCall?.data).toMatchObject({
      status: 'done',
      result_json: {
        theme_session_id: 'tses_1',
        candidate_count: 10,
        notes: 'total 10',
      },
    });
  });

  it('exclude_titles_recent が Job.payload_json に明示指定なら DB 集計は走らない', async () => {
    const job: JobRecord = {
      id: 'job_1',
      status: 'queued',
      payload_json: makeJobPayload({
        exclude_titles_recent: ['明示タイトル X', '明示タイトル Y'],
      }),
    };
    const { prisma, captures } = buildPrisma({ jobs: [job] });
    const { deps, generateCalls } = buildDeps(prisma);

    await runPipelineThemeGenerate(
      { theme_session_id: 'tses_1', job_id: 'job_1' },
      deps,
    );

    // DB 集計はスキップされる
    expect(captures.themeFindMany).toHaveLength(0);
    // Marketer には明示指定が渡る
    expect(generateCalls[0]).toMatchObject({
      excludeTitlesRecent: ['明示タイトル X', '明示タイトル Y'],
    });
  });

  it('genre=null の候補は DB.theme_candidates.genre に practical fallback で INSERT される', async () => {
    const job: JobRecord = {
      id: 'job_1',
      status: 'queued',
      payload_json: makeJobPayload({ genre: null }),
    };
    const { prisma, captures } = buildPrisma({ jobs: [job] });
    const { deps } = buildDeps(prisma);

    await runPipelineThemeGenerate(
      { theme_session_id: 'tses_1', job_id: 'job_1' },
      deps,
    );

    const rows = captures.candidateCreateMany[0]?.data as Array<Record<string, unknown>>;
    // genre は string NOT NULL なので fallback 適用
    expect(rows.every((r) => r.genre === 'practical')).toBe(true);
  });
});

describe('runPipelineThemeGenerate idempotency', () => {
  it('Job.status === done なら早期 return (Marketer 呼ばれず、createMany されない)', async () => {
    const job: JobRecord = {
      id: 'job_1',
      status: 'done',
      payload_json: makeJobPayload(),
    };
    const { prisma, captures } = buildPrisma({ jobs: [job] });
    const { deps, generateCalls } = buildDeps(prisma);

    await runPipelineThemeGenerate(
      { theme_session_id: 'tses_1', job_id: 'job_1' },
      deps,
    );

    expect(captures.jobUpdateMany).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
    expect(captures.candidateCreateMany).toHaveLength(0);
  });

  it('CAS で count=0 (他 worker が先に running 化) なら skip', async () => {
    const job: JobRecord = {
      id: 'job_1',
      status: 'running',
      payload_json: makeJobPayload(),
    };
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      forceUpdateManyCount: 0,
    });
    const { deps, generateCalls } = buildDeps(prisma);

    await runPipelineThemeGenerate(
      { theme_session_id: 'tses_1', job_id: 'job_1' },
      deps,
    );

    expect(generateCalls).toHaveLength(0);
    expect(captures.candidateCreateMany).toHaveLength(0);
  });
});

describe('runPipelineThemeGenerate error paths', () => {
  it('payload zod 違反で ValidationError', async () => {
    const { prisma } = buildPrisma({ jobs: [] });
    const { deps } = buildDeps(prisma);
    await expect(
      runPipelineThemeGenerate({}, deps),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runPipelineThemeGenerate({}, deps),
    ).rejects.toBeInstanceOf(A2PError);
  });

  it('Job が存在しないと NotFoundError', async () => {
    const { prisma } = buildPrisma({ jobs: [] });
    const { deps } = buildDeps(prisma);
    await expect(
      runPipelineThemeGenerate(
        { theme_session_id: 'tses_1', job_id: 'job_missing' },
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('Job.payload_json が schema 違反なら ValidationError + Job=failed', async () => {
    const job: JobRecord = {
      id: 'job_1',
      status: 'queued',
      payload_json: { theme_session_id: 'tses_1' }, // 不足
    };
    const { prisma, captures } = buildPrisma({ jobs: [job] });
    const { deps, generateCalls } = buildDeps(prisma);

    await expect(
      runPipelineThemeGenerate(
        { theme_session_id: 'tses_1', job_id: 'job_1' },
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(generateCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('Job.payload_json.theme_session_id と payload 不一致なら ValidationError + Job=failed', async () => {
    const job: JobRecord = {
      id: 'job_1',
      status: 'queued',
      payload_json: makeJobPayload({ theme_session_id: 'tses_OTHER' }),
    };
    const { prisma, captures } = buildPrisma({ jobs: [job] });
    const { deps, generateCalls } = buildDeps(prisma);

    await expect(
      runPipelineThemeGenerate(
        { theme_session_id: 'tses_1', job_id: 'job_1' },
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(generateCalls).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });

  it('generateThemes throw → 透過 + Job=failed + createMany 呼ばれない', async () => {
    const job: JobRecord = {
      id: 'job_1',
      status: 'queued',
      payload_json: makeJobPayload(),
    };
    const { prisma, captures } = buildPrisma({ jobs: [job] });
    const boom = new Error('agent failed');
    const { deps } = buildDeps(prisma, {
      generateThemes: (async () => {
        throw boom;
      }) as unknown as PipelineThemeGenerateDeps['generateThemes'],
    });

    await expect(
      runPipelineThemeGenerate(
        { theme_session_id: 'tses_1', job_id: 'job_1' },
        deps,
      ),
    ).rejects.toBe(boom);

    expect(captures.candidateCreateMany).toHaveLength(0);
    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
    expect((failedCall?.data.error as string).includes('agent failed')).toBe(true);
  });

  it('themeCandidate.createMany throw → 透過 + Job=failed', async () => {
    const job: JobRecord = {
      id: 'job_1',
      status: 'queued',
      payload_json: makeJobPayload(),
    };
    const dbErr = new Error('db error on createMany');
    const { prisma, captures } = buildPrisma({
      jobs: [job],
      createManyThrow: dbErr,
    });
    const { deps } = buildDeps(prisma);

    await expect(
      runPipelineThemeGenerate(
        { theme_session_id: 'tses_1', job_id: 'job_1' },
        deps,
      ),
    ).rejects.toBe(dbErr);

    const failedCall = captures.jobUpdates.find((c) => c.data.status === 'failed');
    expect(failedCall).toBeDefined();
  });
});
