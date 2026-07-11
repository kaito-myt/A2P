import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { detectBudgetBreaches, type BudgetBreach } from '@a2p/contracts/org';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import { computeCostAggregate, type FinancePrisma } from './org-finance-lib.js';

/**
 * `org.finance.tick` タスク (docs/06 §8-4 / §9) — 経営管理の予算ガード（横断）。
 *
 * token_usage を本部別に集計し、Objective の本部別予算配分・全社予算・月次上限と突き合わせる。
 * 消化率が閾値を超えた項目があれば `enforce_limit`(needs_human) を1件起票し、CEO/CFO の
 * 凍結/再配分の承認を仰ぐ。集計は決定的（LLM 非依存）。
 *
 * 暴走防止: 開いている enforce_limit が既にあれば重複起票しない。
 * cron（既定OFF, 毎時）＋ web からの手動起動。
 */

export const ORG_FINANCE_TICK_TASK_NAME = 'org.finance.tick';

/** 予算消化率がこの割合に達したら enforce_limit を起票（既定 100%）。 */
const BREACH_THRESHOLD = 1.0;

const OPEN_STATUSES = ['proposed', 'approved', 'in_progress', 'blocked', 'needs_human'];

export const OrgFinanceTickPayloadSchema = z.object({
  job_id: z.string().min(1).optional(),
  trigger: z.string().optional(),
});

export interface OrgFinanceTickPrisma extends FinancePrisma {
  orgTask: FinancePrisma['orgTask'] & {
    findMany: (args: {
      where: { division: string; status: { in: string[] }; kind: string };
      select: { id: true };
    }) => Promise<Array<{ id: string }>>;
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  job?: {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
}

export interface OrgFinanceTickDeps {
  prisma?: OrgFinanceTickPrisma;
  logger?: Logger;
  now?: () => Date;
}

export interface OrgFinanceTickResult {
  total_cost_jpy: number;
  breaches: number;
  enforce_created: boolean;
  skipped_existing: boolean;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

export async function runOrgFinanceTick(payload: unknown, deps: OrgFinanceTickDeps = {}): Promise<OrgFinanceTickResult> {
  const parsed = OrgFinanceTickPayloadSchema.safeParse(payload ?? {});
  const jobId = parsed.success ? parsed.data.job_id : undefined;

  const log = deps.logger ?? createLogger(`worker.${ORG_FINANCE_TICK_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as OrgFinanceTickPrisma);
  const now = deps.now ?? (() => new Date());

  try {
    const agg = await computeCostAggregate(prisma, now());

    const breaches: BudgetBreach[] = detectBudgetBreaches(
      agg.total_budget_jpy,
      agg.total_cost_jpy,
      agg.allocation,
      agg.spent_by_division,
      BREACH_THRESHOLD,
    );
    // 月次上限（AppSettings.monthly_cost_red_jpy）も全社予算の一種として扱う。
    const hasTotalBreach = breaches.some((b) => b.scope === 'total');
    if (
      !hasTotalBreach &&
      agg.monthly_budget_jpy &&
      agg.monthly_budget_jpy > 0 &&
      agg.total_cost_jpy >= agg.monthly_budget_jpy * BREACH_THRESHOLD
    ) {
      breaches.unshift({
        scope: 'total',
        label: '全社(月次上限)',
        allocated: agg.monthly_budget_jpy,
        spent: agg.total_cost_jpy,
        ratio: agg.total_cost_jpy / agg.monthly_budget_jpy,
      });
    }

    const result: OrgFinanceTickResult = {
      total_cost_jpy: agg.total_cost_jpy,
      breaches: breaches.length,
      enforce_created: false,
      skipped_existing: false,
    };

    if (breaches.length > 0) {
      // 既に開いている enforce_limit があれば重複起票しない。
      const existing = await prisma.orgTask.findMany({
        where: { division: 'finance', status: { in: OPEN_STATUSES }, kind: 'enforce_limit' },
        select: { id: true },
      });
      if (existing.length > 0) {
        result.skipped_existing = true;
      } else {
        const lines = breaches.map(
          (b) => `- ${b.label}: ${yen(b.spent)} / 予算 ${yen(b.allocated)}（消化 ${Math.round(b.ratio * 100)}%）`,
        );
        const instruction = [
          '予算消化が上限に到達しました。以下の項目について凍結（該当本部の新規タスク停止）または',
          '予算再配分（低ROI本部を絞り、伸びている本部へ寄せる）を判断してください。',
          '',
          ...lines,
          '',
          `当月コスト合計: ${yen(agg.total_cost_jpy)}`,
          `累計ロイヤリティ: ${yen(agg.total_royalty_jpy)}`,
        ].join('\n');

        await prisma.orgTask.create({
          data: {
            division: 'finance',
            owner_role: 'finance_mgr',
            assignee_role: 'human',
            kind: 'enforce_limit',
            title: `予算ガード: ${breaches.length}項目が上限到達`,
            instruction,
            status: 'needs_human',
            priority: 'must',
            result_json: { breaches, total_cost_jpy: agg.total_cost_jpy, total_royalty_jpy: agg.total_royalty_jpy },
          },
        });
        result.enforce_created = true;
      }
    }

    if (jobId && prisma.job) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', finished_at: now(), error: null, result_json: result },
      });
    }
    log.info({ task: ORG_FINANCE_TICK_TASK_NAME, ...result }, 'org.finance.tick done');
    return result;
  } catch (err) {
    if (jobId && prisma.job) {
      try {
        await prisma.job.update({
          where: { id: jobId },
          data: { status: 'failed', finished_at: now(), error: serializeError(err) },
        });
      } catch {
        // best-effort
      }
    }
    throw err;
  }
}

export const orgFinanceTickTask: Task = async (payload: unknown, _helpers: JobHelpers) => {
  await runOrgFinanceTick(payload);
};
