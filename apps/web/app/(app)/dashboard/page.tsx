/**
 * S-002 ダッシュボード (docs/04 §4 S-002 / docs/wireframes/S-002-dashboard/prompt.md)。
 *
 * 6 セクション骨格:
 *   1. トップ KPI ストリップ (5 枚)
 *   2. アクション要求カード (6 枚)
 *   3. 進行中ジョブ
 *   4. 未読アラート
 *   5. 最近の本
 *   6. 当月コスト推移
 *
 * T-10-07: Section 1 の「平均 Quality スコア」を RSC で実値接続。
 *   - 当月 avg と先月 avg を evalResult.aggregate で取得し前月比を表示。
 *   - 0 件は "—" 表示。
 */
import type { Metadata } from 'next';
import { prisma } from '@a2p/db';
import { messages } from '@/lib/messages';
import { Section } from '@/components/dashboard/section';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { ActionCard } from '@/components/dashboard/action-card';
import { EmptyState } from '@/components/common/empty-state';

export const metadata: Metadata = {
  title: `${messages.dashboard.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.dashboard;

/** Returns start-of-month UTC Date for the given year/month offset from now. */
function monthStart(offsetMonths: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth() + offsetMonths, 1));
}

async function getAvgQualityScore(): Promise<{
  value: string;
  change?: string;
  changeDir?: 'positive' | 'negative' | 'neutral';
}> {
  const thisMonthStart = monthStart(0);
  const lastMonthStart = monthStart(-1);

  const [thisMonth, lastMonth] = await Promise.all([
    prisma.evalResult.aggregate({
      _avg: { score_total: true },
      // eval_results_time_idx (judged_at DESC) を利用
      where: { judged_at: { gte: thisMonthStart } },
    }),
    prisma.evalResult.aggregate({
      _avg: { score_total: true },
      where: { judged_at: { gte: lastMonthStart, lt: thisMonthStart } },
    }),
  ]);

  const current = thisMonth._avg.score_total;
  const previous = lastMonth._avg.score_total;

  if (current == null) {
    return { value: '—' };
  }

  const currentRounded = Math.round(current * 10) / 10;
  const valueStr = currentRounded.toFixed(1);

  if (previous == null) {
    return { value: valueStr };
  }

  const diff = currentRounded - Math.round(previous * 10) / 10;
  const kpiM = m.kpi;

  if (diff > 0) {
    return {
      value: valueStr,
      change: kpiM.qualityScoreChangePositive(diff),
      changeDir: 'positive',
    };
  }
  if (diff < 0) {
    return {
      value: valueStr,
      change: kpiM.qualityScoreChangeNegative(diff),
      changeDir: 'negative',
    };
  }
  return {
    value: valueStr,
    change: kpiM.qualityScoreChangeFlat,
    changeDir: 'neutral',
  };
}

export default async function DashboardPage() {
  const qualityKpi = await getAvgQualityScore();

  return (
    <div data-testid="dashboard-root" className="flex flex-col gap-space-loose">
      <header className="flex flex-col gap-1">
        <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
        <p className="text-body text-muted">{m.pageSubtitle}</p>
      </header>

      {/* Section 1: トップ KPI ストリップ (5 枚) */}
      <section aria-labelledby="dashboard-kpi-heading" className="flex flex-col gap-space-snug">
        <h2 id="dashboard-kpi-heading" className="sr-only">
          {m.kpiHeading}
        </h2>
        <div className="grid grid-cols-1 gap-space-snug sm:grid-cols-2 lg:grid-cols-5">
          <KpiCard label={m.kpi.booksPublished} suffix={m.kpi.booksPublishedSuffix} />
          <KpiCard label={m.kpi.monthlyRevenue} suffix={m.kpi.monthlyRevenueTarget} />
          <KpiCard label={m.kpi.monthlyCost} suffix={m.kpi.monthlyCostTarget} />
          <KpiCard
            label={m.kpi.qualityScore}
            value={qualityKpi.value}
            suffix={qualityKpi.value !== '—' ? m.kpi.qualityScoreSuffix : undefined}
            change={qualityKpi.change}
            changeDir={qualityKpi.changeDir}
          />
          <KpiCard label={m.kpi.runningJobs} suffix={m.kpi.runningJobsSuffix} />
        </div>
      </section>

      {/* Section 2: アクション要求カード (6 枚) */}
      <Section title={m.actionsHeading}>
        <div className="grid grid-cols-1 gap-space-snug sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <ActionCard label={m.actions.themesPending} />
          <ActionCard label={m.actions.outlinesPending} />
          <ActionCard label={m.actions.thumbnailsPending} />
          <ActionCard label={m.actions.commentsPending} must={0} />
          <ActionCard label={m.actions.promptProposalsPending} />
          <ActionCard label={m.actions.kdpPending} />
        </div>
      </Section>

      {/* Section 3 / Section 4: 進行中ジョブ + 未読アラート (左右 2:1) */}
      <div className="grid grid-cols-1 gap-space-loose lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title={m.runningJobsHeading}>
            <EmptyState message={m.empty.jobs} compact />
          </Section>
        </div>
        <Section title={m.alertsHeading}>
          <EmptyState message={m.empty.alerts} compact />
        </Section>
      </div>

      {/* Section 5 / Section 6: 最近の本 + コスト推移 (左右 2:1) */}
      <div className="grid grid-cols-1 gap-space-loose lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title={m.recentBooksHeading}>
            <EmptyState message={m.empty.books} compact />
          </Section>
        </div>
        <Section title={m.costTrendHeading}>
          <EmptyState message={m.empty.costTrend} compact />
        </Section>
      </div>
    </div>
  );
}
