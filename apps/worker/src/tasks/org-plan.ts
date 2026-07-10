import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  planObjective as defaultPlanObjective,
  planDivisionTasks as defaultPlanDivisionTasks,
  type CeoPlanDeps,
  type CompanySnapshot,
  type ManagerPlanDeps,
  type ManagerPlanInput,
} from '@a2p/agents';
import type { CeoPlanInput } from '@a2p/agents';
import {
  DIVISIONS,
  DIVISION_MANAGER_ROLE,
  isHumanKind,
  type CeoPlanOutput,
  type Division,
  type ManagerPlanOutput,
} from '@a2p/contracts/org';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `org.plan` タスク (docs/06 §8) — CEO ティック。
 *
 * 1. 全社状況スナップショットを DB から集約
 * 2. CEO エージェントが方針(Objective)＋本部別予算配分＋本部ブリーフを決定
 * 3. OrgObjective を1本作成（前アクティブは closed に）
 * 4. ブリーフのある本部ごとに本部長エージェントを起動 → org_tasks を起票
 *    （人手前提 kind は needs_human、それ以外は approved で自動承認）
 *
 * cron（日次）または web の「今すぐ立案」ボタンから enqueue される。
 */

export const ORG_PLAN_TASK_NAME = 'org.plan';

export const OrgPlanPayloadSchema = z.object({
  job_id: z.string().min(1).optional(),
  trigger: z.string().optional(),
});

const OPEN_STATUSES = ['proposed', 'approved', 'in_progress', 'blocked', 'needs_human'];

// --- 最小限の prisma 構造型（テストで差し替え可能に） -----------------------

export interface OrgPlanPrisma {
  book: {
    findMany: (args: {
      select: {
        id: true;
        title: true;
        status: true;
        publish_status: true;
        theme: { select: { genre: true } };
      };
      orderBy: { created_at: 'desc' };
    }) => Promise<
      Array<{
        id: string;
        title: string;
        status: string;
        publish_status: string;
        theme: { genre: string } | null;
      }>
    >;
  };
  salesRecord: {
    findMany: (args: {
      select: { book_id: true; year_month: true; royalty_jpy: true; book: { select: { title: true } } };
    }) => Promise<Array<{ book_id: string; year_month: string; royalty_jpy: number; book: { title: string } | null }>>;
  };
  tokenUsage: {
    aggregate: (args: {
      _sum: { cost_jpy: true };
      where: { created_at: { gte: Date } };
    }) => Promise<{ _sum: { cost_jpy: unknown } }>;
  };
  appSettings: {
    findUnique: (args: {
      where: { id: string };
      select: { monthly_cost_red_jpy: true };
    }) => Promise<{ monthly_cost_red_jpy: number } | null>;
  };
  promotionChannelSetting: {
    findMany: (args: {
      select: { channel: true; auto_enabled: true; handle: true; token_mask: true };
    }) => Promise<Array<{ channel: string; auto_enabled: boolean; handle: string | null; token_mask: string | null }>>;
  };
  orgTask: {
    findMany: (args: {
      where: { status: { in: string[] } };
      select: { division: true; kind: true; title: true; status: true };
    }) => Promise<Array<{ division: string; kind: string; title: string; status: string }>>;
    create: (args: { data: OrgTaskCreateData }) => Promise<{ id: string }>;
  };
  orgObjective: {
    updateMany: (args: { where: { status: string }; data: { status: string } }) => Promise<{ count: number }>;
    create: (args: { data: OrgObjectiveCreateData }) => Promise<{ id: string }>;
  };
  job?: {
    update: (args: {
      where: { id: string };
      data: { status?: string; finished_at?: Date; error?: string | null; result_json?: unknown };
    }) => Promise<unknown>;
  };
}

interface OrgObjectiveCreateData {
  period_label: string;
  title: string;
  body_json: unknown;
  budget_jpy: number | null;
  budget_allocation_json: unknown;
  status: string;
}

interface OrgTaskCreateData {
  objective_id: string;
  division: string;
  book_id: string | null;
  owner_role: string;
  assignee_role: string;
  channel: string | null;
  account_ref: string | null;
  theme_id: string | null;
  account_id: string | null;
  kind: string;
  title: string;
  instruction: string;
  status: string;
  priority: string;
}

export interface OrgPlanDeps {
  prisma?: OrgPlanPrisma;
  logger?: Logger;
  planObjective?: (input: CeoPlanInput, deps?: CeoPlanDeps) => Promise<CeoPlanOutput>;
  planDivisionTasks?: (input: ManagerPlanInput, deps?: ManagerPlanDeps) => Promise<ManagerPlanOutput>;
  now?: () => Date;
}

export interface OrgPlanResult {
  objective_id: string;
  tasks_created: number;
  by_division: Record<string, number>;
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function periodLabel(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 全社状況スナップショット＋本部長へ渡す候補データを組み立てる。 */
export async function buildCompanySnapshot(
  prisma: OrgPlanPrisma,
  now: Date,
): Promise<{
  snapshot: CompanySnapshot;
  candidateBooks: Array<{ id: string; title: string; status: string; publish_status: string; genre: string | null }>;
  channels: Array<{ channel: string; auto_enabled: boolean; handle: string | null }>;
  openTasks: Array<{ division: string; kind: string; title: string; status: string }>;
}> {
  const books = await prisma.book.findMany({
    select: { id: true, title: true, status: true, publish_status: true, theme: { select: { genre: true } } },
    orderBy: { created_at: 'desc' },
  });
  const byStatus: Record<string, number> = {};
  for (const b of books) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
  const published = books.filter((b) => b.publish_status === 'published').length;
  const needsHuman = books.filter((b) => b.status === 'needs_human_review').length;

  const sales = await prisma.salesRecord.findMany({
    select: { book_id: true, year_month: true, royalty_jpy: true, book: { select: { title: true } } },
  });
  const totalRoyalty = sales.reduce((a, r) => a + toNumber(r.royalty_jpy), 0);
  const maxMonth = sales.reduce((m, r) => (r.year_month > m ? r.year_month : m), '');
  const lastMonthRoyalty = sales
    .filter((r) => r.year_month === maxMonth)
    .reduce((a, r) => a + toNumber(r.royalty_jpy), 0);
  const perBook = new Map<string, { title: string; royalty: number }>();
  for (const r of sales) {
    const cur = perBook.get(r.book_id) ?? { title: r.book?.title ?? '(不明)', royalty: 0 };
    cur.royalty += toNumber(r.royalty_jpy);
    perBook.set(r.book_id, cur);
  }
  const topBooks = [...perBook.values()]
    .sort((a, b) => b.royalty - a.royalty)
    .slice(0, 3)
    .map((x) => ({ title: x.title, royalty_jpy: x.royalty }));

  const costAgg = await prisma.tokenUsage.aggregate({
    _sum: { cost_jpy: true },
    where: { created_at: { gte: monthStart(now) } },
  });
  const monthCost = toNumber(costAgg._sum.cost_jpy);

  const settings = await prisma.appSettings.findUnique({
    where: { id: 'singleton' },
    select: { monthly_cost_red_jpy: true },
  });

  const chRows = await prisma.promotionChannelSetting.findMany({
    select: { channel: true, auto_enabled: true, handle: true, token_mask: true },
  });
  const channels = chRows.map((c) => ({ channel: c.channel, auto_enabled: c.auto_enabled, handle: c.handle }));
  const connected = chRows.filter((c) => c.handle || c.token_mask).map((c) => c.channel);
  const autoEnabled = chRows.filter((c) => c.auto_enabled).map((c) => c.channel);

  const openTasks = await prisma.orgTask.findMany({
    where: { status: { in: OPEN_STATUSES } },
    select: { division: true, kind: true, title: true, status: true },
  });

  const snapshot: CompanySnapshot = {
    period_label: periodLabel(now),
    books: { total: books.length, by_status: byStatus, needs_human_review: needsHuman, published },
    sales: { last_month_royalty_jpy: lastMonthRoyalty, total_royalty_jpy: totalRoyalty, top_books: topBooks },
    cost: { month_jpy: Math.round(monthCost), monthly_budget_jpy: settings?.monthly_cost_red_jpy ?? null },
    channels: { connected, auto_enabled: autoEnabled },
    open_tasks: openTasks.length,
  };

  const candidateBooks = books
    .slice(0, 40)
    .map((b) => ({
      id: b.id,
      title: b.title,
      status: b.status,
      publish_status: b.publish_status,
      genre: b.theme?.genre ?? null,
    }));

  return { snapshot, candidateBooks, channels, openTasks };
}

export async function runOrgPlan(payload: unknown, deps: OrgPlanDeps = {}): Promise<OrgPlanResult> {
  const parsed = OrgPlanPayloadSchema.safeParse(payload ?? {});
  const jobId = parsed.success ? parsed.data.job_id : undefined;

  const log = deps.logger ?? createLogger(`worker.${ORG_PLAN_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as OrgPlanPrisma);
  const planObj = deps.planObjective ?? defaultPlanObjective;
  const planTasks = deps.planDivisionTasks ?? defaultPlanDivisionTasks;
  const now = deps.now ?? (() => new Date());

  try {
    const { snapshot, candidateBooks, channels, openTasks } = await buildCompanySnapshot(prisma, now());

    // 1. CEO 方針
    const plan = await planObj({ snapshot });

    // 2. Objective を作成（前アクティブは closed）
    await prisma.orgObjective.updateMany({ where: { status: 'active' }, data: { status: 'closed' } });
    const objective = await prisma.orgObjective.create({
      data: {
        period_label: plan.period_label,
        title: plan.title,
        body_json: plan.body,
        budget_jpy: plan.budget_jpy ?? null,
        budget_allocation_json: plan.budget_allocation ?? null,
        status: 'active',
      },
    });

    // 3. 本部長がタスクへ分解（ブリーフのある本部のみ）
    const candidateIds = new Set(candidateBooks.map((b) => b.id));
    const byDivision: Record<string, number> = {};
    let created = 0;

    for (const division of DIVISIONS) {
      const brief = plan.division_briefs[division as Division];
      if (!brief || brief.trim().length === 0) continue;

      const managerRole = DIVISION_MANAGER_ROLE[division];
      const context = {
        objective: {
          title: plan.title,
          goals: plan.body.goals,
          kpi: plan.body.kpi,
          ...(plan.body.notes ? { notes: plan.body.notes } : {}),
        },
        brief,
        books: candidateBooks,
        ...(division === 'promotion' ? { channels } : {}),
        open_tasks: openTasks.filter((t) => t.division === division).map((t) => ({ kind: t.kind, title: t.title, status: t.status })),
        budget_jpy: plan.budget_allocation?.[division as Division] ?? null,
      };

      let result: ManagerPlanOutput;
      try {
        result = await planTasks({ division: division as Division, context });
      } catch (err) {
        log.warn({ task: ORG_PLAN_TASK_NAME, division, err }, 'manager plan failed — skip division');
        continue;
      }

      for (const draft of result.tasks) {
        const bookId = draft.book_id && candidateIds.has(draft.book_id) ? draft.book_id : null;
        const status = isHumanKind(draft.kind) ? 'needs_human' : 'approved';
        await prisma.orgTask.create({
          data: {
            objective_id: objective.id,
            division,
            book_id: bookId,
            owner_role: managerRole,
            assignee_role: isHumanKind(draft.kind) ? 'human' : draft.assignee_role,
            channel: draft.channel ?? null,
            account_ref: draft.account_ref ?? null,
            theme_id: draft.theme_id ?? null,
            account_id: draft.account_id ?? null,
            kind: draft.kind,
            title: draft.title,
            instruction: draft.instruction,
            status,
            priority: draft.priority,
          },
        });
        created += 1;
        byDivision[division] = (byDivision[division] ?? 0) + 1;
      }
      log.info({ task: ORG_PLAN_TASK_NAME, division, count: byDivision[division] ?? 0 }, 'division tasks created');
    }

    const result: OrgPlanResult = { objective_id: objective.id, tasks_created: created, by_division: byDivision };

    if (jobId && prisma.job) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', finished_at: now(), error: null, result_json: result },
      });
    }
    log.info({ task: ORG_PLAN_TASK_NAME, ...result }, 'org.plan done');
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

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export const orgPlanTask: Task = async (payload: unknown, _helpers: JobHelpers) => {
  await runOrgPlan(payload);
};
