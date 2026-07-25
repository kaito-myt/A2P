import { randomUUID } from 'node:crypto';

import type { Task } from 'graphile-worker';

import { generateMarketerThemes as defaultGenerateMarketerThemes } from '@a2p/agents/marketer';
import type { MarketerThemeInput, MarketerThemeOutput } from '@a2p/contracts/agents/marketer';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import { readPipelineAutopass, type PipelineAutopassPrisma } from './lib/pipeline-autopass.js';
import {
  PIPELINE_THEME_GENERATE_TASK_NAME,
  mapCandidateToRow,
} from './pipeline-theme-generate.js';

/**
 * `pipeline.theme.auto` タスク (パイプライン設定 — テーマ選定自動化)。
 *
 * AppSettings.autopass_theme_enabled=true のとき日次 cron (pipeline_theme_cron) で起動し、
 * 人手を介さず「テーマ生成 → 自動採用 → バッチ計画へ投入」まで完走させる。
 *
 * フロー:
 *   1. AppSettings から autopass_theme_enabled / pipeline_themes_per_day /
 *      pipeline_theme_direction を読む (readPipelineAutopass)。false なら即 return。
 *   2. 有効な Account を 1 件解決 (作成日昇順の先頭)。無ければ warn して return
 *      (KDP アカウント未接続時の防御)。
 *   3. `pipeline.theme.generate` (T-03-06) と同じ経路 — Marketer を呼び出し
 *      ThemeCandidate を `createMany` で INSERT する。観測用に内部 Job 行も 1 件残す
 *      (実際の graphile-worker キューには載せない — 二重生成を避けるため直接呼出)。
 *   4. 生成された ThemeCandidate (theme_session_id 一致 / status='pending') を
 *      acceptThemesAndStageBatchCore と同じく accepted に遷移。
 *   5. createBatchPlanCore と同じく BatchPlan + BatchPlanItem を INSERT (status='scheduled',
 *      planned_at=now()) — 予測コストは Phase 2 自動フローでは計算せず 0 固定
 *      (予測コスト計算は apps/web 専用ロジックのため worker からは呼べない。実コストは
 *      alert.cost.check が token_usage から追跡する)。
 *   6. 毎分起動の `batch_plan.dispatcher` が planned_at<=now の BatchPlan を拾って自動キックする。
 */

export const PIPELINE_THEME_AUTO_TASK_NAME = 'pipeline.theme.auto';

/** pipeline_theme_direction が空文字 ("おまかせ") のときに Marketer へ渡すフォールバック文言。 */
const AUTO_KEYWORD_FALLBACK = 'おまかせ (ジャンル方針に基づく自動選定)';

/** 自動バッチの並列度上限 (小さめに固定し、無人運転でのコスト暴走を抑える)。 */
const AUTO_BATCH_MAX_CONCURRENCY = 3;

export interface PipelineThemeAutoPrisma extends PipelineAutopassPrisma {
  account: {
    findFirst: (args: {
      where: { status: string };
      select: { id: true };
      orderBy: { created_at: 'asc' };
    }) => Promise<{ id: string } | null>;
  };
  job: {
    create: (args: {
      data: {
        kind: string;
        status: string;
        started_at?: Date;
        payload_json?: unknown;
      };
    }) => Promise<{ id: string }>;
    update: (args: {
      where: { id: string };
      data: {
        status?: string;
        finished_at?: Date;
        error?: string | null;
        result_json?: unknown;
      };
    }) => Promise<unknown>;
  };
  themeCandidate: {
    createMany: (args: {
      data: Array<Record<string, unknown>>;
    }) => Promise<{ count: number }>;
    findMany: (args: {
      where: { theme_session_id: string; status: string };
      select: { id: true; account_id: true };
    }) => Promise<Array<{ id: string; account_id: string }>>;
    updateMany: (args: {
      where: { id: { in: string[] }; status: string };
      data: { status: string; decided_at: Date };
    }) => Promise<{ count: number }>;
  };
  batchPlan: {
    create: (args: {
      data: {
        planned_at: Date;
        concurrency: number;
        predicted_cost_jpy: number;
        status: string;
      };
    }) => Promise<{ id: string }>;
  };
  batchPlanItem: {
    create: (args: {
      data: { batch_id: string; theme_id: string; status: string };
    }) => Promise<{ id: string }>;
  };
  auditLog: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
}

export interface PipelineThemeAutoDeps {
  prisma?: PipelineThemeAutoPrisma;
  logger?: Logger;
  now?: () => Date;
  genId?: () => string;
  generateThemes?: (input: MarketerThemeInput) => Promise<MarketerThemeOutput>;
}

export interface PipelineThemeAutoResult {
  enabled: boolean;
  generated_count: number;
  batch_id: string | null;
}

export async function runPipelineThemeAuto(
  deps: PipelineThemeAutoDeps = {},
): Promise<PipelineThemeAutoResult> {
  const log = deps.logger ?? createLogger(`worker.${PIPELINE_THEME_AUTO_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PipelineThemeAutoPrisma);
  const now = deps.now ?? (() => new Date());
  const genId = deps.genId ?? (() => randomUUID());
  const generateThemes = deps.generateThemes ?? defaultGenerateMarketerThemes;

  const autopass = await readPipelineAutopass(prisma);
  if (!autopass.autopass_theme_enabled) {
    log.info({ task: PIPELINE_THEME_AUTO_TASK_NAME }, 'autopass theme disabled — skip');
    return { enabled: false, generated_count: 0, batch_id: null };
  }

  const account = await prisma.account.findFirst({
    where: { status: 'active' },
    select: { id: true },
    orderBy: { created_at: 'asc' },
  });
  if (!account) {
    log.warn(
      { task: PIPELINE_THEME_AUTO_TASK_NAME },
      '有効な KDP アカウントが無いためテーマ自動生成をスキップ',
    );
    return { enabled: true, generated_count: 0, batch_id: null };
  }

  const themeSessionId = genId();
  const keywordOrBrief = autopass.pipeline_theme_direction.trim() || AUTO_KEYWORD_FALLBACK;
  const count = autopass.pipeline_themes_per_day;

  // 観測用の内部 Job (graphile-worker キューには載せない — 直接呼出で二重生成を避ける)
  const genJob = await prisma.job.create({
    data: {
      kind: PIPELINE_THEME_GENERATE_TASK_NAME,
      status: 'running',
      started_at: now(),
      payload_json: {
        theme_session_id: themeSessionId,
        account_id: account.id,
        genre: null,
        keyword_or_brief: keywordOrBrief,
        count,
        trigger: 'autopass',
      },
    },
  });

  let candidateCount = 0;
  try {
    const marketerInput: MarketerThemeInput = {
      themeSessionId,
      accountId: account.id,
      jobId: genJob.id,
      genre: null,
      keywordOrBrief,
      excludeTitlesRecent: [],
      count,
    };
    const result = await generateThemes(marketerInput);
    const rows = result.candidates.map((c) =>
      mapCandidateToRow({
        candidate: c,
        accountId: account.id,
        themeSessionId,
        genre: null,
        authorNameId: null,
        labelNameId: null,
      }),
    );
    const inserted = await prisma.themeCandidate.createMany({ data: rows });
    candidateCount = inserted.count;
    await prisma.job.update({
      where: { id: genJob.id },
      data: {
        status: 'done',
        finished_at: now(),
        result_json: { theme_session_id: themeSessionId, candidate_count: candidateCount },
      },
    });
  } catch (err) {
    try {
      await prisma.job.update({
        where: { id: genJob.id },
        data: { status: 'failed', finished_at: now(), error: serializeError(err) },
      });
    } catch (jobUpdateErr) {
      log.warn(
        { task: PIPELINE_THEME_AUTO_TASK_NAME, err: jobUpdateErr },
        'failed to mark internal Job as failed after theme generation failure',
      );
    }
    log.warn({ task: PIPELINE_THEME_AUTO_TASK_NAME, err }, 'auto theme generation failed');
    return { enabled: true, generated_count: 0, batch_id: null };
  }

  if (candidateCount === 0) {
    log.warn(
      { task: PIPELINE_THEME_AUTO_TASK_NAME, themeSessionId },
      'Marketer returned no candidates — nothing to stage',
    );
    return { enabled: true, generated_count: 0, batch_id: null };
  }

  // 自動採用 (acceptThemesAndStageBatchCore と同形): pending → accepted
  const generatedThemes = await prisma.themeCandidate.findMany({
    where: { theme_session_id: themeSessionId, status: 'pending' },
    select: { id: true, account_id: true },
  });
  const themeIds = generatedThemes.map((t) => t.id);
  if (themeIds.length === 0) {
    log.warn(
      { task: PIPELINE_THEME_AUTO_TASK_NAME, themeSessionId },
      'ThemeCandidate INSERT 直後に pending が 0 件 — バッチ計画への投入をスキップ',
    );
    return { enabled: true, generated_count: candidateCount, batch_id: null };
  }
  await prisma.themeCandidate.updateMany({
    where: { id: { in: themeIds }, status: 'pending' },
    data: { status: 'accepted', decided_at: now() },
  });

  // createBatchPlanCore と同形の最小版バッチ計画 (即時スケジュール)。
  // 予測コスト計算 (forecastBookCostJpy) は apps/web 専用ロジックのため 0 固定とする。
  const plan = await prisma.batchPlan.create({
    data: {
      planned_at: now(),
      concurrency: Math.max(1, Math.min(AUTO_BATCH_MAX_CONCURRENCY, themeIds.length)),
      predicted_cost_jpy: 0,
      status: 'scheduled',
    },
  });
  for (const themeId of themeIds) {
    await prisma.batchPlanItem.create({
      data: { batch_id: plan.id, theme_id: themeId, status: 'pending' },
    });
  }

  await prisma.auditLog.create({
    data: {
      actor_id: null,
      action: 'pipeline_theme_auto.generate_accept_stage',
      target_kind: 'batch_plan',
      target_id: plan.id,
      before_json: { theme_session_id: themeSessionId, trigger: 'cron' },
      after_json: {
        theme_ids: themeIds,
        candidate_count: candidateCount,
        batch_id: plan.id,
        account_id: account.id,
      },
    },
  });

  log.info(
    {
      task: PIPELINE_THEME_AUTO_TASK_NAME,
      themeSessionId,
      candidateCount,
      batchId: plan.id,
      themeCount: themeIds.length,
    },
    'pipeline.theme.auto done — themes generated, auto-accepted, staged into batch plan',
  );

  return { enabled: true, generated_count: candidateCount, batch_id: plan.id };
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** graphile-worker 用エクスポート。`buildTaskList()` から登録される。 */
export const pipelineThemeAutoTask: Task = async () => {
  await runPipelineThemeAuto();
};
