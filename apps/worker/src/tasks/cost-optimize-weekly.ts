import { randomUUID } from 'node:crypto';

import type { JobHelpers, Task } from 'graphile-worker';

import { analyzeCost as defaultAnalyze } from '@a2p/agents';
import type { CostOptimizerInput, CostOptimizerOutput } from '@a2p/contracts/agents/cost-optimizer';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `cost.optimize.weekly` タスク (F-062)
 *
 * 直近30日の token_usage を役割×モデルで集計し、現行モデル割当・単価カタログ・運用設定と
 * ともに cost_optimizer へ渡してコスト改善提案を生成、cost_improvement_proposals に保存する。
 * 旧 'proposed' は supersede(dismissed) してから新バッチを積む。承認/実行は Web 側で行う。
 */
export const COST_OPTIMIZE_WEEKLY_TASK_NAME = 'cost.optimize.weekly';

const DAY = 24 * 60 * 60 * 1000;

interface CostPrisma {
  tokenUsage: {
    groupBy: (args: unknown) => Promise<
      Array<{
        role: string;
        provider: string;
        model: string;
        _sum: { cost_jpy: unknown; input_tokens: number | null; output_tokens: number | null; image_count: number | null };
        _count: { _all: number };
      }>
    >;
  };
  modelAssignment: {
    findMany: (args: {
      where: { status: string };
      select: { role: true; genre: true; provider: true; model: true };
    }) => Promise<Array<{ role: string; genre: string | null; provider: string; model: string }>>;
  };
  modelCatalog: {
    findMany: (args: {
      where: { is_current: boolean };
      select: { provider: true; model: true; input_price_per_mtok_usd: true; output_price_per_mtok_usd: true; image_price_per_image_usd: true };
    }) => Promise<Array<{ provider: string; model: string; input_price_per_mtok_usd: unknown; output_price_per_mtok_usd: unknown; image_price_per_image_usd: unknown }>>;
  };
  appSettings: {
    findUnique: (args: { where: { id: string }; select: Record<string, boolean> }) => Promise<Record<string, unknown> | null>;
  };
  costImprovementProposal: {
    updateMany: (args: { where: { status: string }; data: { status: string } }) => Promise<{ count: number }>;
    createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<{ count: number }>;
  };
}

export interface CostOptimizeWeeklyDeps {
  prisma?: CostPrisma;
  logger?: Logger;
  now?: () => Date;
  analyze?: (input: CostOptimizerInput) => Promise<CostOptimizerOutput>;
  genId?: () => string;
}

export interface CostOptimizeWeeklyResult {
  proposals: number;
  superseded: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function runCostOptimizeWeekly(
  _payload: unknown,
  deps: CostOptimizeWeeklyDeps = {},
): Promise<CostOptimizeWeeklyResult> {
  const log = deps.logger ?? createLogger(`worker.${COST_OPTIMIZE_WEEKLY_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as CostPrisma);
  const now = deps.now ?? (() => new Date());
  const analyze = deps.analyze ?? ((input: CostOptimizerInput) => defaultAnalyze(input));
  const genId = deps.genId ?? (() => randomUUID());

  const since = new Date(now().getTime() - 30 * DAY);

  const grouped = await prisma.tokenUsage.groupBy({
    by: ['role', 'provider', 'model'],
    where: { created_at: { gte: since } },
    _sum: { cost_jpy: true, input_tokens: true, output_tokens: true, image_count: true },
    _count: { _all: true },
  } as unknown);

  const byRoleModel = grouped.map((g) => ({
    role: g.role,
    provider: g.provider,
    model: g.model,
    cost_jpy: num(g._sum.cost_jpy),
    calls: g._count._all,
    input_tokens: g._sum.input_tokens ?? 0,
    output_tokens: g._sum.output_tokens ?? 0,
    image_count: g._sum.image_count ?? 0,
  }));
  const totalCost = byRoleModel.reduce((a, b) => a + b.cost_jpy, 0);

  if (byRoleModel.length === 0 || totalCost <= 0) {
    log.info({ task: COST_OPTIMIZE_WEEKLY_TASK_NAME }, 'no cost data in window — skip');
    return { proposals: 0, superseded: 0 };
  }

  const assignments = await prisma.modelAssignment.findMany({
    where: { status: 'active' },
    select: { role: true, genre: true, provider: true, model: true },
  });
  const catalog = await prisma.modelCatalog.findMany({
    where: { is_current: true },
    select: { provider: true, model: true, input_price_per_mtok_usd: true, output_price_per_mtok_usd: true, image_price_per_image_usd: true },
  });
  const settingsRow = await prisma.appSettings.findUnique({
    where: { id: 'singleton' },
    select: { promo_dispatch_cron: true, promo_review_cron: true, promo_daily_review_enabled: true, cost_analyze_cron: true },
  });

  const input: CostOptimizerInput = {
    period_label: '直近30日',
    total_cost_jpy: totalCost,
    by_role_model: byRoleModel,
    current_assignments: assignments.map((a) => ({ role: a.role, genre: a.genre, provider: a.provider, model: a.model })),
    catalog: catalog.map((c) => ({
      provider: c.provider,
      model: c.model,
      input_price_per_mtok_usd: c.input_price_per_mtok_usd == null ? null : num(c.input_price_per_mtok_usd),
      output_price_per_mtok_usd: c.output_price_per_mtok_usd == null ? null : num(c.output_price_per_mtok_usd),
      image_price_per_image_usd: c.image_price_per_image_usd == null ? null : num(c.image_price_per_image_usd),
    })),
    settings: (settingsRow ?? {}) as CostOptimizerInput['settings'],
  };

  let out: CostOptimizerOutput;
  try {
    out = await analyze(input);
  } catch (err) {
    log.warn({ task: COST_OPTIMIZE_WEEKLY_TASK_NAME, err }, 'cost analysis failed');
    return { proposals: 0, superseded: 0 };
  }

  if (out.proposals.length === 0) {
    log.info({ task: COST_OPTIMIZE_WEEKLY_TASK_NAME }, 'no proposals generated');
    return { proposals: 0, superseded: 0 };
  }

  // 旧 proposed を supersede(dismissed) してから新バッチを積む。
  const superseded = await prisma.costImprovementProposal.updateMany({
    where: { status: 'proposed' },
    data: { status: 'dismissed' },
  });

  const batchId = genId();
  const rows = out.proposals.map((p) => {
    const action = p.action ?? { kind: 'advisory' as const };
    const params =
      action.kind === 'switch_model_assignment'
        ? { role: action.role ?? '', genre: action.genre ?? null, provider: action.provider ?? '', model: action.model ?? '' }
        : action.kind === 'set_app_setting'
          ? { key: action.key ?? '', value: action.value ?? '' }
          : {};
    return {
      batch_id: batchId,
      category: p.category,
      title: p.title.slice(0, 300),
      description: p.description.slice(0, 4000),
      estimated_saving_jpy: Math.max(0, Math.round(p.estimated_saving_jpy)),
      impact_note: p.impact_note.slice(0, 2000),
      action_kind: action.kind,
      action_params_json: params,
      status: 'proposed',
    };
  });
  const created = await prisma.costImprovementProposal.createMany({ data: rows });

  log.info(
    { task: COST_OPTIMIZE_WEEKLY_TASK_NAME, proposals: created.count, superseded: superseded.count, totalCost: Math.round(totalCost) },
    'cost proposals generated',
  );
  return { proposals: created.count, superseded: superseded.count };
}

export const costOptimizeWeeklyTask: Task = async (payload: unknown, _helpers: JobHelpers) => {
  await runCostOptimizeWeekly(payload);
};
