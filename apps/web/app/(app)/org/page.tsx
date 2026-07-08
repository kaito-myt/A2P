/**
 * docs/06 — 経営ダッシュボード (/org)。
 * CEO の現在方針・本部別予算消化・当月コスト・本部サマリを俯瞰し、
 * 「CEO に立案させる」で経営サイクルを起動する。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';
import {
  DIVISIONS,
  DIVISION_LABELS,
  DIVISION_MANAGER_ROLE,
  buildBudgetLines,
  orgRoleLabel,
  type Division,
} from '@a2p/contracts/org';

import { messages } from '@/lib/messages';
import { RunPlanButton } from '@/components/org/run-plan-button';
import {
  computeSpentByDivision,
  divisionTaskCounts,
  mapOrgTaskRow,
  type DbOrgTask,
} from '@/lib/org-view';

export const metadata: Metadata = {
  title: `${messages.org.dashboard.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.org.dashboard;

interface ObjectiveBody {
  focus_books?: string[];
  goals?: string[];
  kpi?: string[];
  notes?: string;
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

export default async function OrgDashboardPage() {
  const objective = await prisma.orgObjective.findFirst({
    where: { status: 'active' },
    orderBy: { created_at: 'desc' },
  });

  const tasksRaw = objective
    ? await prisma.orgTask.findMany({
        where: { objective_id: objective.id },
        select: {
          id: true,
          division: true,
          book_id: true,
          owner_role: true,
          assignee_role: true,
          channel: true,
          account_ref: true,
          kind: true,
          title: true,
          instruction: true,
          status: true,
          priority: true,
          cost_jpy: true,
          created_at: true,
          book: { select: { title: true } },
        },
      })
    : [];
  const tasks = tasksRaw.map((t) => mapOrgTaskRow(t as unknown as DbOrgTask));

  const costAgg = await prisma.tokenUsage.aggregate({
    _sum: { cost_jpy: true },
    where: { created_at: { gte: monthStartUtc(new Date()) } },
  });
  const monthCost = Number(costAgg._sum.cost_jpy ?? 0);

  const body = (objective?.body_json ?? {}) as ObjectiveBody;
  const allocation = (objective?.budget_allocation_json ?? null) as Partial<Record<Division, number>> | null;
  const spent = computeSpentByDivision(tasks);
  const budgetLines = buildBudgetLines(allocation, spent);
  const counts = divisionTaskCounts(tasks);

  return (
    <div className="flex flex-col gap-space-loose" data-testid="org-dashboard">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">{messages.org.breadcrumbHome}</Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.pageTitle}</span>
        </nav>
        <div className="flex flex-wrap items-end justify-between gap-space-snug">
          <div className="flex flex-col">
            <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
            <p className="text-body text-muted">{m.pageSubtitle}</p>
          </div>
          <RunPlanButton />
        </div>
      </header>

      {!objective ? (
        <div className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center">
          <p className="text-body text-muted">{m.noObjective}</p>
        </div>
      ) : (
        <>
          {/* 現在の方針 */}
          <section className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-card-title font-medium text-charcoal">{m.objectiveTitle}</h2>
              <span className="text-caption text-muted">{m.period}: {objective.period_label}</span>
            </div>
            <p className="text-body font-medium text-charcoal">{objective.title}</p>
            {body.goals && body.goals.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-caption font-medium text-muted">{m.goals}</span>
                <ul className="list-disc pl-5 text-caption text-charcoal-82">
                  {body.goals.map((g, i) => <li key={i}>{g}</li>)}
                </ul>
              </div>
            )}
            {body.kpi && body.kpi.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-caption font-medium text-muted">{m.kpi}</span>
                <ul className="list-disc pl-5 text-caption text-charcoal-82">
                  {body.kpi.map((k, i) => <li key={i}>{k}</li>)}
                </ul>
              </div>
            )}
            {body.notes && <p className="text-caption text-muted">{m.notes}: {body.notes}</p>}
          </section>

          {/* コスト & 予算 */}
          <section className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed">
            <div className="flex flex-wrap items-center gap-space-loose">
              <div className="flex flex-col">
                <span className="text-caption text-muted">{m.monthCost}</span>
                <span className="text-sub-heading text-charcoal">{yen(monthCost)}</span>
              </div>
              {objective.budget_jpy != null && (
                <div className="flex flex-col">
                  <span className="text-caption text-muted">{m.monthlyBudget}</span>
                  <span className="text-sub-heading text-charcoal">{yen(objective.budget_jpy)}</span>
                </div>
              )}
            </div>
            <h3 className="text-button-sm font-medium text-charcoal">{m.budgetTitle}</h3>
            <div className="flex flex-col gap-2">
              {budgetLines.map((line) => (
                <div key={line.division} className="flex items-center gap-space-snug">
                  <span className="w-16 shrink-0 text-caption text-charcoal-82">{line.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-cream">
                    <div
                      className="h-full rounded-full bg-charcoal"
                      style={{ width: `${line.ratio != null ? Math.min(100, Math.round(line.ratio * 100)) : 0}%` }}
                    />
                  </div>
                  <span className="w-40 shrink-0 text-right text-caption text-muted">
                    {line.allocated != null
                      ? `${yen(line.spent)} / ${yen(line.allocated)}`
                      : `${yen(line.spent)}（${m.budgetNone}）`}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* 本部サマリ */}
          <section className="flex flex-col gap-space-snug">
            <div className="flex items-center justify-between">
              <h2 className="text-card-title font-medium text-charcoal">{m.divisionsTitle}</h2>
              <Link href="/org/tasks" className="text-button-sm text-accent no-underline hover:underline">
                {m.viewBoard} &rarr;
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-space-snug sm:grid-cols-2 lg:grid-cols-3">
              {DIVISIONS.map((d) => (
                <DivisionCard key={d} division={d} counts={counts[d]} />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DivisionCard({
  division,
  counts,
}: {
  division: Division;
  counts: { open: number; human: number; done: number; total: number };
}) {
  return (
    <Link
      href="/org/tasks"
      className="flex flex-col gap-1.5 rounded-card border border-border-warm bg-cream-light p-space-snug no-underline shadow-l1 hover:bg-cream"
    >
      <div className="flex items-center justify-between">
        <span className="text-button-sm font-medium text-charcoal">{DIVISION_LABELS[division]}本部</span>
        <span className="text-caption text-muted">{orgRoleLabel(DIVISION_MANAGER_ROLE[division])}</span>
      </div>
      <div className="flex gap-space-snug text-caption text-charcoal-82">
        <span>{messages.org.dashboard.tasksOpen}: {counts.open}</span>
        <span className={counts.human > 0 ? 'font-medium text-amber-700' : ''}>
          {messages.org.dashboard.tasksHuman}: {counts.human}
        </span>
        <span>{messages.org.dashboard.tasksDone}: {counts.done}</span>
      </div>
    </Link>
  );
}
