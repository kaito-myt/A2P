import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { computeBakeoffRecommendation, type BakeoffResultRow, type ModelRef } from '@a2p/contracts/org';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `org.bakeoff.recommend` タスク (docs/06 P4 増分5) — bakeoff 結果 → モデル切替提案。
 *
 * 完了した BakeoffRun（org_optimize ラン）の結果を集計し、品質優先・コスト tiebreak で
 * 最良モデルを選定。現行割当と異なれば `optimize_model`(needs_human) を起票して運営者に
 * 切替を提案する（**モデル割当の変更は影響が大きいため自動適用しない**）。
 */

export const ORG_BAKEOFF_RECOMMEND_TASK_NAME = 'org.bakeoff.recommend';

export const OrgBakeoffRecommendPayloadSchema = z.object({ run_id: z.string().min(1) });

export interface OrgBakeoffRecommendPrisma {
  bakeoffRun: {
    findUnique: (args: {
      where: { id: string };
      select: { role: true; genre: true; status: true };
    }) => Promise<{ role: string; genre: string | null; status: string } | null>;
  };
  bakeoffResult: {
    findMany: (args: {
      where: { run_id: string };
      select: { provider: true; model: true; quality_score: true; cost_jpy: true; error: true };
    }) => Promise<Array<{ provider: string; model: string; quality_score: number | null; cost_jpy: unknown; error: string | null }>>;
  };
  modelAssignment: {
    findFirst: (args: {
      where: { role: string; genre: string | null; status: string };
      select: { provider: true; model: true };
    }) => Promise<{ provider: string; model: string } | null>;
  };
  orgTask: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
}

export interface OrgBakeoffRecommendDeps {
  prisma?: OrgBakeoffRecommendPrisma;
  logger?: Logger;
}

export interface OrgBakeoffRecommendResult {
  role: string;
  usable: number;
  recommended: boolean;
  is_change: boolean;
  task_id?: string;
}

function toNumOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function runOrgBakeoffRecommend(
  payload: unknown,
  deps: OrgBakeoffRecommendDeps = {},
): Promise<OrgBakeoffRecommendResult> {
  const parsed = OrgBakeoffRecommendPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new Error('org.bakeoff.recommend payload が不正です');
  const { run_id: runId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${ORG_BAKEOFF_RECOMMEND_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as OrgBakeoffRecommendPrisma);

  const run = await prisma.bakeoffRun.findUnique({
    where: { id: runId },
    select: { role: true, genre: true, status: true },
  });
  if (!run) throw new Error(`BakeoffRun not found: ${runId}`);

  const rows = await prisma.bakeoffResult.findMany({
    where: { run_id: runId },
    select: { provider: true, model: true, quality_score: true, cost_jpy: true, error: true },
  });
  const results: BakeoffResultRow[] = rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    quality_score: r.quality_score,
    cost_jpy: toNumOrNull(r.cost_jpy),
    error: r.error,
  }));

  const current = (await prisma.modelAssignment.findFirst({
    where: { role: run.role, genre: run.genre, status: 'active' },
    select: { provider: true, model: true },
  })) as ModelRef | null;

  const rec = computeBakeoffRecommendation(results, current);
  const result: OrgBakeoffRecommendResult = {
    role: run.role,
    usable: results.filter((r) => !r.error).length,
    recommended: rec != null,
    is_change: rec?.is_change ?? false,
  };

  if (!rec) {
    log.info({ task: ORG_BAKEOFF_RECOMMEND_TASK_NAME, runId, role: run.role }, 'no usable bakeoff results — skip');
    return result;
  }
  if (!rec.is_change) {
    log.info({ task: ORG_BAKEOFF_RECOMMEND_TASK_NAME, runId, role: run.role }, 'current model is best — no proposal');
    return result;
  }

  const evidence = results
    .map((r) => `- ${r.provider}/${r.model}: ${r.error ? `失敗(${r.error})` : `品質${r.quality_score ?? '—'} / コスト¥${r.cost_jpy ?? '—'}`}`)
    .join('\n');
  const instruction = [
    `【モデル最適化提案】ロール「${run.role}」`,
    rec.reason,
    '',
    `推奨: ${rec.best.provider} / ${rec.best.model}`,
    current ? `現行: ${current.provider} / ${current.model}` : '現行: (未設定)',
    '',
    '【bakeoff 結果】',
    evidence,
    '',
    '※ モデル割当の変更は影響が大きいため、内容を確認のうえモデル割当画面で切り替えてください。',
  ].join('\n');

  const task = await prisma.orgTask.create({
    data: {
      division: 'sysops',
      owner_role: 'ops_mgr',
      assignee_role: 'human',
      kind: 'optimize_model',
      title: `モデル最適化: ${run.role} → ${rec.best.provider}/${rec.best.model}`.slice(0, 160),
      instruction,
      status: 'needs_human',
      priority: 'should',
      result_json: {
        action: 'model_optimization_proposal',
        proposal: { role: run.role, genre: run.genre, provider: rec.best.provider, model: rec.best.model },
        current,
        evidence: results,
        run_id: runId,
      },
    },
  });
  result.task_id = task.id;
  log.info(
    { task: ORG_BAKEOFF_RECOMMEND_TASK_NAME, runId, role: run.role, best: rec.best },
    'model optimization proposal created',
  );
  return result;
}

export const orgBakeoffRecommendTask: Task = async (payload: unknown, _helpers: JobHelpers) => {
  await runOrgBakeoffRecommend(payload);
};
