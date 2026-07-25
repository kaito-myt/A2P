import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@a2p/contracts/logger';
import type { MarketerThemeInput, MarketerThemeOutput } from '@a2p/contracts/agents/marketer';

import {
  PIPELINE_THEME_AUTO_TASK_NAME,
  runPipelineThemeAuto,
  type PipelineThemeAutoDeps,
  type PipelineThemeAutoPrisma,
} from '../src/tasks/pipeline-theme-auto.js';

function makeLogger() {
  const calls: Array<{ level: 'info' | 'warn' | 'error'; obj: Record<string, unknown>; msg: string }> = [];
  const mk = (level: 'info' | 'warn' | 'error') => (obj: Record<string, unknown>, msg?: string) => {
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

interface BuildPrismaArgs {
  appSettings?: Record<string, unknown> | null;
  account?: { id: string } | null;
  /** themeCandidate.createMany が返す件数 (省略時は渡された rows の長さ). */
  forceCreateManyCount?: number;
  /** themeCandidate.findMany が返す pending 一覧 (省略時は createMany の rows から自動生成). */
  forceFindManyResult?: Array<{ id: string; account_id: string }>;
}

function buildPrisma(args: BuildPrismaArgs = {}) {
  const captures = {
    jobCreates: [] as Array<Record<string, unknown>>,
    jobUpdates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
    createManyRows: [] as Array<Record<string, unknown>>,
    themeUpdateManys: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    batchPlanCreates: [] as Array<Record<string, unknown>>,
    batchPlanItemCreates: [] as Array<Record<string, unknown>>,
    auditLogCreates: [] as Array<Record<string, unknown>>,
  };
  let themeIdCounter = 0;

  const prisma: PipelineThemeAutoPrisma = {
    appSettings: {
      findUnique: async () => (args.appSettings === undefined ? {} : args.appSettings),
    },
    account: {
      findFirst: async () => (args.account === undefined ? { id: 'acc_1' } : args.account),
    },
    job: {
      create: async ({ data }) => {
        captures.jobCreates.push(data as unknown as Record<string, unknown>);
        return { id: 'gen_job_1' };
      },
      update: async ({ where, data }) => {
        captures.jobUpdates.push({ where, data: data as unknown as Record<string, unknown> });
        return {};
      },
    },
    themeCandidate: {
      createMany: async ({ data }) => {
        captures.createManyRows.push(...data);
        return { count: args.forceCreateManyCount ?? data.length };
      },
      findMany: async () => {
        if (args.forceFindManyResult !== undefined) return args.forceFindManyResult;
        return captures.createManyRows.map((r) => {
          themeIdCounter += 1;
          return { id: `theme_${themeIdCounter}`, account_id: r.account_id as string };
        });
      },
      updateMany: async ({ where, data }) => {
        captures.themeUpdateManys.push({
          where: where as unknown as Record<string, unknown>,
          data: data as unknown as Record<string, unknown>,
        });
        return { count: where.id.in.length };
      },
    },
    batchPlan: {
      create: async ({ data }) => {
        captures.batchPlanCreates.push(data as unknown as Record<string, unknown>);
        return { id: 'batch_1' };
      },
    },
    batchPlanItem: {
      create: async ({ data }) => {
        captures.batchPlanItemCreates.push(data as unknown as Record<string, unknown>);
        return { id: `item_${captures.batchPlanItemCreates.length}` };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        captures.auditLogCreates.push(data as unknown as Record<string, unknown>);
        return {};
      },
    },
  };

  return { prisma, captures };
}

function makeCandidates(n: number): MarketerThemeOutput {
  return {
    candidates: Array.from({ length: n }, (_, i) => ({
      title: `自動生成タイトル${i + 1}`,
      hook: `フック${i + 1}`,
      target_reader: `読者層${i + 1}`,
      competitors: [],
      signals: {
        reasoning: '自動生成テスト根拠',
        market_score: 70,
        predicted_chapters: 8,
        search_keywords: [],
        sources: [],
        bestseller_evidence: [],
      },
    })),
  };
}

describe('pipeline.theme.auto task name', () => {
  it('task identifier は pipeline.theme.auto', () => {
    expect(PIPELINE_THEME_AUTO_TASK_NAME).toBe('pipeline.theme.auto');
  });
});

describe('runPipelineThemeAuto — autopass_theme_enabled OFF (既定)', () => {
  it('OFF: 何もせず enabled=false を返す (account 照会もしない)', async () => {
    const { prisma, captures } = buildPrisma({ appSettings: { autopass_theme_enabled: false } });
    const findFirstSpy = vi.spyOn(prisma.account, 'findFirst');
    const { logger } = makeLogger();

    const result = await runPipelineThemeAuto({ prisma, logger });

    expect(result).toEqual({ enabled: false, generated_count: 0, batch_id: null });
    expect(findFirstSpy).not.toHaveBeenCalled();
    expect(captures.jobCreates).toHaveLength(0);
    expect(captures.batchPlanCreates).toHaveLength(0);
  });
});

describe('runPipelineThemeAuto — autopass_theme_enabled ON', () => {
  it('有効な Account が無い場合は warn して何もしない', async () => {
    const { prisma, captures } = buildPrisma({
      appSettings: { autopass_theme_enabled: true, pipeline_themes_per_day: 3 },
      account: null,
    });
    const { logger, calls } = makeLogger();

    const result = await runPipelineThemeAuto({ prisma, logger });

    expect(result).toEqual({ enabled: true, generated_count: 0, batch_id: null });
    expect(captures.jobCreates).toHaveLength(0);
    expect(calls.some((c) => c.level === 'warn')).toBe(true);
  });

  it('ON: Marketer 呼出 → ThemeCandidate INSERT → 自動採用 → BatchPlan/BatchPlanItem 作成 → audit_log', async () => {
    const { prisma, captures } = buildPrisma({
      appSettings: {
        autopass_theme_enabled: true,
        pipeline_themes_per_day: 3,
        pipeline_theme_direction: '副業・資産形成系',
      },
      account: { id: 'acc_42' },
    });
    const { logger } = makeLogger();
    const generateThemes = vi.fn(
      async (input: MarketerThemeInput): Promise<MarketerThemeOutput> => {
        expect(input.accountId).toBe('acc_42');
        expect(input.count).toBe(3);
        expect(input.keywordOrBrief).toBe('副業・資産形成系');
        return makeCandidates(3);
      },
    );

    const result = await runPipelineThemeAuto({
      prisma,
      logger,
      genId: () => 'session_test_1',
      now: () => new Date('2026-07-25T00:00:00Z'),
      generateThemes,
    });

    expect(generateThemes).toHaveBeenCalledOnce();
    expect(captures.createManyRows).toHaveLength(3);
    expect(captures.createManyRows[0]).toMatchObject({
      account_id: 'acc_42',
      theme_session_id: 'session_test_1',
      status: 'pending',
    });

    // 自動採用: pending → accepted
    expect(captures.themeUpdateManys).toHaveLength(1);
    expect(captures.themeUpdateManys[0]?.data).toMatchObject({ status: 'accepted' });

    // BatchPlan + BatchPlanItem * 3
    expect(captures.batchPlanCreates).toHaveLength(1);
    expect(captures.batchPlanCreates[0]).toMatchObject({ status: 'scheduled' });
    expect(captures.batchPlanItemCreates).toHaveLength(3);
    captures.batchPlanItemCreates.forEach((item) => {
      expect(item).toMatchObject({ batch_id: 'batch_1', status: 'pending' });
    });

    // audit_log
    expect(captures.auditLogCreates).toHaveLength(1);
    expect(captures.auditLogCreates[0]).toMatchObject({
      actor_id: null,
      action: 'pipeline_theme_auto.generate_accept_stage',
      target_id: 'batch_1',
    });

    // 内部 Job (観測用) は done に遷移
    const doneUpdate = captures.jobUpdates.find((u) => u.data.status === 'done');
    expect(doneUpdate).toBeDefined();

    expect(result).toEqual({ enabled: true, generated_count: 3, batch_id: 'batch_1' });
  });

  it('pipeline_theme_direction が空文字 ("おまかせ") ならフォールバック文言を Marketer に渡す', async () => {
    const { prisma } = buildPrisma({
      appSettings: {
        autopass_theme_enabled: true,
        pipeline_themes_per_day: 2,
        pipeline_theme_direction: '',
      },
    });
    const { logger } = makeLogger();
    const generateThemes = vi.fn(async (input: MarketerThemeInput) => {
      expect(input.keywordOrBrief.length).toBeGreaterThan(0);
      expect(input.genre).toBeNull();
      return makeCandidates(2);
    });

    await runPipelineThemeAuto({ prisma, logger, generateThemes });

    expect(generateThemes).toHaveBeenCalledOnce();
  });

  it('Marketer が例外を投げても Job=failed に降格し、warn のみで完走する (バッチ投入なし)', async () => {
    const { prisma, captures } = buildPrisma({
      appSettings: { autopass_theme_enabled: true, pipeline_themes_per_day: 3 },
    });
    const { logger, calls } = makeLogger();
    const boom = new Error('marketer boom');
    const generateThemes = vi.fn(async () => {
      throw boom;
    });

    const result = await runPipelineThemeAuto({ prisma, logger, generateThemes });

    expect(result).toEqual({ enabled: true, generated_count: 0, batch_id: null });
    expect(captures.batchPlanCreates).toHaveLength(0);
    const failedUpdate = captures.jobUpdates.find((u) => u.data.status === 'failed');
    expect(failedUpdate).toBeDefined();
    expect(calls.some((c) => c.level === 'warn')).toBe(true);
  });

  it('生成 0 件 (createMany count=0) の場合はバッチ投入せず終了', async () => {
    const { prisma, captures } = buildPrisma({
      appSettings: { autopass_theme_enabled: true, pipeline_themes_per_day: 3 },
      forceCreateManyCount: 0,
    });
    const { logger } = makeLogger();
    const generateThemes = vi.fn(async () => makeCandidates(3));

    const result = await runPipelineThemeAuto({ prisma, logger, generateThemes });

    expect(result).toEqual({ enabled: true, generated_count: 0, batch_id: null });
    expect(captures.batchPlanCreates).toHaveLength(0);
    expect(captures.themeUpdateManys).toHaveLength(0);
  });
});
