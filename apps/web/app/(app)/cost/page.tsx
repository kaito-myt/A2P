/**
 * S-024 コスト詳細ダッシュボード (T-07-05, F-032/F-033/F-034/F-035/F-036).
 *
 * RSC page: fetches token_usage aggregates, paused books, top cost books.
 * All sections rendered from DB queries in a single RSC render.
 *
 * Phase 1: recharts 不使用。テーブル/バー表示で代替。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';
import { getTopCostBooks } from '@a2p/db/cost-aggregation';

import { messages } from '@/lib/messages';
import {
  computeCostKpi,
  getPredictionLevel,
  getForecastLevel,
  aggregateByKey,
  serializeTopCostBook,
  serializePausedBook,
  type DailyCostRow,
} from '@/lib/cost-dashboard-view';

import { CostDashboardShell } from '@/components/cost/cost-dashboard-shell';
import { CostKpiStripe } from '@/components/cost/cost-kpi-stripe';
import { DailyCostTable } from '@/components/cost/daily-cost-table';
import { BreakdownTables } from '@/components/cost/breakdown-tables';
import { PredictionAlertStrip } from '@/components/cost/prediction-alert-strip';
import { TopCostBooksTable } from '@/components/cost/top-cost-books-table';
import { PausedJobsTable } from '@/components/cost/paused-jobs-table';
import { CostProposalsPanel, type CostProposalSerialized } from '@/components/cost/cost-proposals-panel';

export const metadata: Metadata = {
  title: `${messages.costDashboard.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.costDashboard;
const MONTHLY_LIMIT = 50_000;

function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default async function CostDashboardPage() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  // --- Parallel DB queries ---
  const [
    monthlyAggregate,
    dailyRaw,
    breakdownRaw,
    topCostRaw,
    pausedBooksRaw,
    bookCountResult,
  ] = await Promise.all([
    // Total cost for the month
    prisma.tokenUsage.aggregate({
      where: { created_at: { gte: monthStart, lt: monthEnd } },
      _sum: { cost_jpy: true },
    }),

    // Daily cost by provider
    prisma.$queryRaw<Array<{ date: string; provider: string; cost_jpy: unknown; call_count: bigint }>>`
      SELECT
        TO_CHAR(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS date,
        provider,
        SUM(cost_jpy) AS cost_jpy,
        COUNT(*) AS call_count
      FROM token_usage
      WHERE created_at >= ${monthStart} AND created_at < ${monthEnd}
      GROUP BY date, provider
      ORDER BY date ASC, provider ASC
    `,

    // Breakdown by provider x model x role
    prisma.tokenUsage.groupBy({
      by: ['provider', 'model', 'role'],
      where: { created_at: { gte: monthStart, lt: monthEnd } },
      _sum: {
        cost_jpy: true,
        input_tokens: true,
        output_tokens: true,
      },
      _count: { _all: true },
    }),

    // Top cost books
    getTopCostBooks(prisma, 20),

    // Paused cost books
    prisma.book.findMany({
      where: {
        OR: [
          { status: 'paused_cost' },
          { cost_status: 'paused' },
        ],
      },
      select: {
        id: true,
        title: true,
        status: true,
        cost_status: true,
        cost_jpy_total: true,
        account: { select: { pen_name: true } },
      },
    }),

    // Distinct book count for per-book avg
    prisma.tokenUsage.groupBy({
      by: ['book_id'],
      where: {
        created_at: { gte: monthStart, lt: monthEnd },
        book_id: { not: null },
      },
    }),
  ]);

  // --- Compute KPI ---
  const actual = toNumber(monthlyAggregate._sum.cost_jpy);
  const bookCount = bookCountResult.length;
  const kpi = computeCostKpi(actual, bookCount, now);

  const forecastRatioPct = MONTHLY_LIMIT > 0
    ? (kpi.forecast / MONTHLY_LIMIT) * 100
    : 0;
  const level = getForecastLevel(forecastRatioPct);

  // --- Daily cost rows ---
  const dailyRows: DailyCostRow[] = dailyRaw.map((r) => ({
    date: r.date,
    provider: r.provider,
    cost_jpy: toNumber(r.cost_jpy),
    call_count: Number(r.call_count),
  }));

  // --- Breakdown ---
  const breakdownBase = breakdownRaw.map((g) => ({
    provider: g.provider,
    model: g.model,
    role: g.role,
    input_tokens: g._sum.input_tokens ?? 0,
    output_tokens: g._sum.output_tokens ?? 0,
    cost_jpy: toNumber(g._sum.cost_jpy),
    call_count: g._count._all,
  }));

  const byProvider = aggregateByKey(
    breakdownBase.map((r) => ({ key: r.provider, ...r })),
  );
  const byModel = aggregateByKey(
    breakdownBase.map((r) => ({ key: `${r.provider} / ${r.model}`, ...r })),
  );
  const byRole = aggregateByKey(
    breakdownBase.map((r) => ({ key: r.role, ...r })),
  );

  // --- Top cost books with titles ---
  const bookIds = topCostRaw.map((b) => b.book_id);
  const bookTitles = bookIds.length > 0
    ? await prisma.book.findMany({
        where: { id: { in: bookIds } },
        select: { id: true, title: true },
      })
    : [];
  const titleMap = new Map(bookTitles.map((b) => [b.id, b.title]));
  const topBooks = topCostRaw.map((b) => serializeTopCostBook(b, titleMap));

  // --- Paused books ---
  const pausedBooks = pausedBooksRaw.map(serializePausedBook);

  // --- Cost improvement proposals (F-062) ---
  const proposalRows = await prisma.costImprovementProposal.findMany({
    orderBy: { created_at: 'desc' },
    take: 24,
    select: {
      id: true,
      category: true,
      title: true,
      description: true,
      estimated_saving_jpy: true,
      impact_note: true,
      action_kind: true,
      status: true,
      apply_result: true,
      created_at: true,
    },
  });
  const proposals: CostProposalSerialized[] = proposalRows.map((p) => ({
    id: p.id,
    category: p.category,
    title: p.title,
    description: p.description,
    estimated_saving_jpy: p.estimated_saving_jpy,
    impact_note: p.impact_note,
    action_kind: p.action_kind,
    status: p.status,
    apply_result: p.apply_result,
    created_at: p.created_at.toISOString(),
  }));

  // --- Check for empty state ---
  const isEmpty = actual === 0 && dailyRows.length === 0;

  return (
    <div className="flex flex-col gap-space-loose" data-testid="cost-dashboard-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbAnalytics}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbCost}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      {isEmpty ? (
        <div
          data-testid="cost-empty-state"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        >
          <p className="text-body font-medium text-charcoal">{m.empty.title}</p>
          <p className="mt-2 text-body text-muted">{m.empty.body}</p>
        </div>
      ) : (
        <CostDashboardShell year={year} month={month}>
          {/* KPI stripe */}
          <section aria-labelledby="cost-kpi-heading">
            <h2 id="cost-kpi-heading" className="sr-only">KPI</h2>
            <CostKpiStripe kpi={kpi} />
          </section>

          {/* Prediction alert strip */}
          <section aria-labelledby="cost-prediction-heading">
            <h2 id="cost-prediction-heading" className="sr-only">{m.prediction.sectionTitle}</h2>
            <PredictionAlertStrip
              ratioPct={kpi.ratioPct}
              forecastRatioPct={forecastRatioPct}
              level={level}
            />
          </section>

          {/* Cost improvement proposals (F-062) */}
          <section aria-labelledby="cost-proposals-heading">
            <h2 id="cost-proposals-heading" className="sr-only">{m.proposals.title}</h2>
            <CostProposalsPanel proposals={proposals} />
          </section>

          {/* Daily cost table */}
          <section aria-labelledby="cost-daily-heading">
            <h2 id="cost-daily-heading" className="mb-space-snug text-card-title text-foreground">
              {m.dailyCost.sectionTitle}
            </h2>
            <DailyCostTable rows={dailyRows} />
          </section>

          {/* Breakdown tables */}
          <section aria-labelledby="cost-breakdown-heading">
            <h2 id="cost-breakdown-heading" className="mb-space-snug text-card-title text-foreground">
              {m.breakdown.sectionTitle}
            </h2>
            <BreakdownTables
              byProvider={byProvider}
              byModel={byModel}
              byRole={byRole}
            />
          </section>

          {/* Top cost books */}
          <section aria-labelledby="cost-top-books-heading">
            <h2 id="cost-top-books-heading" className="mb-space-snug text-card-title text-foreground">
              {m.topBooks.sectionTitle}
            </h2>
            <TopCostBooksTable books={topBooks} />
          </section>

          {/* Paused jobs */}
          <section aria-labelledby="cost-paused-heading">
            <h2 id="cost-paused-heading" className="mb-space-snug text-card-title text-foreground">
              {m.pausedJobs.sectionTitle}
            </h2>
            <PausedJobsTable books={pausedBooks} />
          </section>
        </CostDashboardShell>
      )}
    </div>
  );
}
