import { describe, expect, it, vi } from 'vitest';

import { ConfigError, ValidationError } from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';
import type { OptimizerInput, OptimizerOutput } from '@a2p/contracts/agents/optimizer';

import {
  OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
  runOptimizerPromptGenerate,
  type AddJobLike,
  type OptimizerPromptGenerateDeps,
  type OptimizerPromptGeneratePrisma,
} from '../src/tasks/optimizer-prompt-generate.js';

// ---------------------------------------------------------------------------
// テスト用ファクトリ
// ---------------------------------------------------------------------------

function makeLogger() {
  const calls: Array<{ level: 'info' | 'warn' | 'error'; msg: string; obj: Record<string, unknown> }> = [];
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
}

interface EvalResultRecord {
  id: string;
  book_id: string;
  score_total: number;
  score_breakdown_json: unknown;
  prompt_version_ids_json: unknown;
}

interface PromptRecord {
  id: string;
  body: string;
  version: number;
  role: string;
  genre: string | null;
  status: string;
}

interface SalesRecord {
  book_id: string;
  royalty_jpy: number;
  avg_stars: number | null;
}

interface PromptProposalRecord {
  id: string;
  source_prompt_id: string;
  role: string;
  genre: string | null;
  proposed_body: string;
  diff: string;
  rationale: string;
  expected_effect_json: unknown;
  sample_output: string | null;
  status: string;
}

interface PrismaCaptures {
  jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  jobUpdateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  promptProposalCreates: Array<{ data: Record<string, unknown> }>;
  executeRawCalls: Array<{ sql: string; values: unknown[] }>;
}

interface BuildPrismaArgs {
  jobs: JobRecord[];
  prompts: PromptRecord[];
  evalResults: EvalResultRecord[];
  salesRecords?: SalesRecord[];
  forceUpdateManyCount?: number;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: OptimizerPromptGeneratePrisma;
  captures: PrismaCaptures;
  proposals: PromptProposalRecord[];
} {
  const captures: PrismaCaptures = {
    jobUpdates: [],
    jobUpdateMany: [],
    promptProposalCreates: [],
    executeRawCalls: [],
  };
  const jobs = [...args.jobs];
  const proposals: PromptProposalRecord[] = [];
  let proposalCounter = 0;

  const prisma: OptimizerPromptGeneratePrisma = {
    $executeRawUnsafe: async (sql, ...values) => {
      captures.executeRawCalls.push({ sql, values });
      return 1;
    },
    job: {
      findUnique: async ({ where }) => {
        const j = jobs.find((x) => x.id === where.id);
        return j ? { status: j.status } : null;
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
    prompt: {
      findFirst: async ({ where }) => {
        const p = args.prompts.find(
          (x) =>
            x.role === where.role &&
            (x.genre === where.genre || (where.genre === null && x.genre === null)) &&
            x.status === where.status,
        );
        return p ? { id: p.id, body: p.body, version: p.version } : null;
      },
    },
    promptProposal: {
      create: async ({ data }) => {
        proposalCounter += 1;
        const id = `proposal_${proposalCounter}`;
        const record: PromptProposalRecord = {
          id,
          source_prompt_id: data.source_prompt_id,
          role: data.role,
          genre: data.genre,
          proposed_body: data.proposed_body,
          diff: data.diff,
          rationale: data.rationale,
          expected_effect_json: data.expected_effect_json,
          sample_output: data.sample_output ?? null,
          status: data.status,
        };
        proposals.push(record);
        captures.promptProposalCreates.push({
          data: data as unknown as Record<string, unknown>,
        });
        return { id };
      },
    },
    evalResult: {
      findMany: async () => {
        return args.evalResults;
      },
    },
    salesRecord: {
      findMany: async () => {
        return (args.salesRecords ?? []).map((s) => ({
          book_id: s.book_id,
          royalty_jpy: s.royalty_jpy,
          avg_stars: s.avg_stars,
        }));
      },
    },
  };

  return { prisma, captures, proposals };
}

function makeOptimizerOutput(overrides: Partial<OptimizerOutput> = {}): OptimizerOutput {
  return {
    proposed_body: '改訂後プロンプト本文',
    diff: '--- a\n+++ b\n@@ -1 +1 @@\n-旧\n+新',
    rationale: '改訂理由',
    expected_effect: { score_delta: 5 },
    ...overrides,
  };
}

const noopAddJob: AddJobLike = vi.fn().mockResolvedValue(undefined);
const fixedNow = new Date('2026-06-14T00:00:00.000Z');

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

describe('runOptimizerPromptGenerate', () => {
  describe('正常系: prompt_proposal.create 1 回 + Job done', () => {
    it('should create PromptProposal and set Job done', async () => {
      const { logger } = makeLogger();
      const optimizePromptMock = vi
        .fn<(input: OptimizerInput) => Promise<OptimizerOutput>>()
        .mockResolvedValue(makeOptimizerOutput());
      const notifyMock = vi.fn().mockResolvedValue({ ok: true });

      const { prisma, captures, proposals } = buildPrisma({
        jobs: [{ id: 'job-001', status: 'queued' }],
        prompts: [{ id: 'prompt-001', body: 'プロンプト本文', version: 1, role: 'writer', genre: null, status: 'active' }],
        evalResults: [
          {
            id: 'eval-001',
            book_id: 'book-001',
            score_total: 75,
            score_breakdown_json: { benefit_clarity: 75 },
            prompt_version_ids_json: { writer: 'prompt-001' },
          },
        ],
        salesRecords: [{ book_id: 'book-001', royalty_jpy: 5000, avg_stars: 4.2 }],
      });

      const deps: OptimizerPromptGenerateDeps = {
        prisma,
        logger,
        optimizePrompt: optimizePromptMock,
        now: () => fixedNow,
        notifyJobChange: notifyMock,
      };

      await runOptimizerPromptGenerate(
        { trigger: 'manual', role: 'writer', job_id: 'job-001' },
        noopAddJob,
        deps,
      );

      // PromptProposal が 1 回 INSERT された
      expect(captures.promptProposalCreates).toHaveLength(1);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        source_prompt_id: 'prompt-001',
        role: 'writer',
        genre: null,
        status: 'pending',
        proposed_body: '改訂後プロンプト本文',
      });

      // Job が done に遷移した
      const doneUpdate = captures.jobUpdates.find((u) => u.data.status === 'done');
      expect(doneUpdate).toBeDefined();
      expect(doneUpdate?.data.result_json).toMatchObject({ proposal_id: 'proposal_1' });

      // notifyJobChange が呼ばれた
      expect(notifyMock).toHaveBeenCalledOnce();
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-001', status: 'done', kind: OPTIMIZER_PROMPT_GENERATE_TASK_NAME }),
        expect.any(Object),
      );

      // optimizePrompt が 1 回呼ばれた
      expect(optimizePromptMock).toHaveBeenCalledOnce();
    });
  });

  describe('trigger=manual + role 指定: 指定 role のみで絞り込む', () => {
    it('should use specified role and only filter eval_results for that role', async () => {
      const { logger } = makeLogger();
      const optimizePromptMock = vi.fn<(input: OptimizerInput) => Promise<OptimizerOutput>>().mockResolvedValue(
        makeOptimizerOutput(),
      );

      const { prisma, captures } = buildPrisma({
        jobs: [{ id: 'job-002', status: 'queued' }],
        prompts: [{ id: 'prompt-editor-001', body: 'エディタープロンプト', version: 2, role: 'editor', genre: null, status: 'active' }],
        evalResults: [
          {
            id: 'eval-001',
            book_id: 'book-001',
            score_total: 80,
            score_breakdown_json: {},
            prompt_version_ids_json: { writer: 'prompt-writer-001', editor: 'prompt-editor-001' },
          },
          {
            id: 'eval-002',
            book_id: 'book-002',
            score_total: 60,
            score_breakdown_json: {},
            prompt_version_ids_json: { writer: 'prompt-writer-001', editor: 'prompt-editor-001' },
          },
        ],
      });

      const deps: OptimizerPromptGenerateDeps = {
        prisma,
        logger,
        optimizePrompt: optimizePromptMock,
        now: () => fixedNow,
        notifyJobChange: vi.fn().mockResolvedValue({ ok: true }),
      };

      await runOptimizerPromptGenerate(
        { trigger: 'manual', role: 'editor', job_id: 'job-002' },
        noopAddJob,
        deps,
      );

      // optimizePrompt が editor ロールで呼ばれた
      expect(optimizePromptMock).toHaveBeenCalledOnce();
      const callArg = optimizePromptMock.mock.calls[0]?.[0];
      expect(callArg?.role).toBe('editor');
      // editor の prompt-editor-001 で絞り込まれた eval が 2 件渡された
      expect(callArg?.recent_evals).toHaveLength(2);
      expect(callArg?.current_prompt.id).toBe('prompt-editor-001');

      // Job done
      const doneUpdate = captures.jobUpdates.find((u) => u.data.status === 'done');
      expect(doneUpdate).toBeDefined();
    });
  });

  describe('trigger=cron_10_books + role 未指定: 自動最低スコア選択', () => {
    it('should auto-select role with lowest average score', async () => {
      const { logger } = makeLogger();
      const optimizePromptMock = vi.fn<(input: OptimizerInput) => Promise<OptimizerOutput>>().mockResolvedValue(
        makeOptimizerOutput(),
      );

      const { prisma } = buildPrisma({
        jobs: [{ id: 'job-003', status: 'queued' }],
        prompts: [
          { id: 'prompt-writer-001', body: 'ライタープロンプト', version: 1, role: 'writer', genre: null, status: 'active' },
          { id: 'prompt-editor-001', body: 'エディタープロンプト', version: 1, role: 'editor', genre: null, status: 'active' },
        ],
        evalResults: [
          // writer は平均 85
          {
            id: 'eval-001',
            book_id: 'book-001',
            score_total: 85,
            score_breakdown_json: {},
            prompt_version_ids_json: { writer: 'prompt-writer-001', editor: 'prompt-editor-001' },
          },
          // editor 側: 2 冊で平均 55 (低い)
          {
            id: 'eval-002',
            book_id: 'book-002',
            score_total: 50,
            score_breakdown_json: {},
            prompt_version_ids_json: { editor: 'prompt-editor-001' },
          },
          {
            id: 'eval-003',
            book_id: 'book-003',
            score_total: 60,
            score_breakdown_json: {},
            prompt_version_ids_json: { editor: 'prompt-editor-001' },
          },
        ],
      });

      const deps: OptimizerPromptGenerateDeps = {
        prisma,
        logger,
        optimizePrompt: optimizePromptMock,
        now: () => fixedNow,
        notifyJobChange: vi.fn().mockResolvedValue({ ok: true }),
      };

      await runOptimizerPromptGenerate(
        { trigger: 'cron_10_books', job_id: 'job-003' },
        noopAddJob,
        deps,
      );

      // editor が最低スコアとして選択される
      expect(optimizePromptMock).toHaveBeenCalledOnce();
      const callArg = optimizePromptMock.mock.calls[0]?.[0];
      expect(callArg?.role).toBe('editor');
    });
  });

  describe('冪等性: Job.status=done なら skip', () => {
    it('should skip when job is already done', async () => {
      const { logger } = makeLogger();
      const optimizePromptMock = vi.fn<(input: OptimizerInput) => Promise<OptimizerOutput>>();

      const { prisma, captures } = buildPrisma({
        jobs: [{ id: 'job-004', status: 'done' }],
        prompts: [],
        evalResults: [],
      });

      const deps: OptimizerPromptGenerateDeps = {
        prisma,
        logger,
        optimizePrompt: optimizePromptMock,
        now: () => fixedNow,
        notifyJobChange: vi.fn().mockResolvedValue({ ok: true }),
      };

      await runOptimizerPromptGenerate(
        { trigger: 'manual', role: 'writer', job_id: 'job-004' },
        noopAddJob,
        deps,
      );

      // optimizePrompt は呼ばれない
      expect(optimizePromptMock).not.toHaveBeenCalled();
      // PromptProposal は作られない
      expect(captures.promptProposalCreates).toHaveLength(0);
      // Job の update も呼ばれない (done skip)
      expect(captures.jobUpdates).toHaveLength(0);
    });
  });

  describe('token_usage: role=optimizer, book_id=null で INSERT (optimizePrompt mock 経由)', () => {
    it('should call optimizePrompt with role=optimizer context (job_id set, no bookId)', async () => {
      const { logger } = makeLogger();
      let capturedInput: OptimizerInput | undefined;
      const optimizePromptMock = vi.fn<(input: OptimizerInput) => Promise<OptimizerOutput>>().mockImplementation(
        async (input) => {
          capturedInput = input;
          return makeOptimizerOutput();
        },
      );

      const { prisma } = buildPrisma({
        jobs: [{ id: 'job-005', status: 'queued' }],
        prompts: [{ id: 'prompt-001', body: 'プロンプト', version: 1, role: 'writer', genre: null, status: 'active' }],
        evalResults: [],
      });

      const deps: OptimizerPromptGenerateDeps = {
        prisma,
        logger,
        optimizePrompt: optimizePromptMock,
        now: () => fixedNow,
        notifyJobChange: vi.fn().mockResolvedValue({ ok: true }),
      };

      await runOptimizerPromptGenerate(
        { trigger: 'manual', role: 'writer', job_id: 'job-005' },
        noopAddJob,
        deps,
      );

      // optimizePrompt が job_id=job-005 で呼ばれた (book_id は含まれない)
      expect(capturedInput?.job_id).toBe('job-005');
      // role は 'writer'（optimizer エージェント内で token_usage.role='optimizer' として記録される）
      expect(capturedInput?.role).toBe('writer');
      // genre は null
      expect(capturedInput?.genre).toBeNull();
    });
  });

  describe('active prompt なし → ConfigError + Job failed', () => {
    it('should throw ConfigError and set Job to failed when no active prompt found', async () => {
      const { logger } = makeLogger();
      const optimizePromptMock = vi.fn<(input: OptimizerInput) => Promise<OptimizerOutput>>();

      const { prisma, captures } = buildPrisma({
        jobs: [{ id: 'job-006', status: 'queued' }],
        prompts: [], // active prompt なし
        evalResults: [],
      });

      const deps: OptimizerPromptGenerateDeps = {
        prisma,
        logger,
        optimizePrompt: optimizePromptMock,
        now: () => fixedNow,
        notifyJobChange: vi.fn().mockResolvedValue({ ok: true }),
      };

      await expect(
        runOptimizerPromptGenerate(
          { trigger: 'manual', role: 'writer', job_id: 'job-006' },
          noopAddJob,
          deps,
        ),
      ).rejects.toThrow(ConfigError);

      // optimizePrompt は呼ばれない
      expect(optimizePromptMock).not.toHaveBeenCalled();

      // Job が failed に降格した
      const failedUpdate = captures.jobUpdates.find((u) => u.data.status === 'failed');
      expect(failedUpdate).toBeDefined();
      expect(String(failedUpdate?.data.error)).toContain('ConfigError');
    });
  });

  describe('payload parse 失敗', () => {
    it('should throw ValidationError for invalid payload', async () => {
      const { logger } = makeLogger();

      const { prisma } = buildPrisma({
        jobs: [],
        prompts: [],
        evalResults: [],
      });

      await expect(
        runOptimizerPromptGenerate(
          { trigger: 'invalid_trigger', job_id: 'job-000' },
          noopAddJob,
          { prisma, logger },
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('CAS スキップ: running 中は何もしない', () => {
    it('should skip when CAS returns count=0 (already running)', async () => {
      const { logger } = makeLogger();
      const optimizePromptMock = vi.fn<(input: OptimizerInput) => Promise<OptimizerOutput>>();

      const { prisma, captures } = buildPrisma({
        jobs: [{ id: 'job-007', status: 'running' }],
        prompts: [],
        evalResults: [],
        forceUpdateManyCount: 0,
      });

      const deps: OptimizerPromptGenerateDeps = {
        prisma,
        logger,
        optimizePrompt: optimizePromptMock,
        now: () => fixedNow,
        notifyJobChange: vi.fn().mockResolvedValue({ ok: true }),
      };

      await runOptimizerPromptGenerate(
        { trigger: 'manual', role: 'writer', job_id: 'job-007' },
        noopAddJob,
        deps,
      );

      expect(optimizePromptMock).not.toHaveBeenCalled();
      expect(captures.promptProposalCreates).toHaveLength(0);
    });
  });
});
