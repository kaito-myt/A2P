/**
 * S-017 SalesKpiStripe (T-08-07, F-039).
 *
 * 5 KPI cards: 累計売上 / 累計冊数 / 平均1冊売上 / 平均レビュー星 / コスト/売上比率.
 */
import { Card, CardContent } from '@/components/ui/card';
import { messages } from '@/lib/messages';
import {
  formatJpy,
  formatStars,
  formatCostSalesRatio,
  type SalesKpiSummary,
} from '@/lib/sales-kpi-view';

interface SalesKpiStripeProps {
  summary: SalesKpiSummary;
}

const m = messages.salesKpi.kpi;

export function SalesKpiStripe({ summary }: SalesKpiStripeProps) {
  return (
    <div
      className="grid grid-cols-1 gap-space-snug sm:grid-cols-2 lg:grid-cols-5"
      data-testid="sales-kpi-stripe"
    >
      <KpiCard
        label={m.totalRoyaltyLabel}
        value={formatJpy(summary.total_royalty_jpy)}
        testId="kpi-total-royalty"
      />
      <KpiCard
        label={m.totalBooksLabel}
        value={`${summary.total_books.toLocaleString('ja-JP')} ${m.booksUnit}`}
        testId="kpi-total-books"
      />
      <KpiCard
        label={m.avgRoyaltyLabel}
        value={formatJpy(summary.avg_royalty_per_book_jpy)}
        testId="kpi-avg-royalty"
      />
      <KpiCard
        label={m.avgStarsLabel}
        value={formatStars(summary.avg_stars)}
        testId="kpi-avg-stars"
      />
      <KpiCard
        label={m.costSalesRatioLabel}
        value={formatCostSalesRatio(summary.cost_sales_ratio)}
        testId="kpi-cost-sales-ratio"
      />
    </div>
  );
}

function KpiCard({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <Card variant="compact">
      <CardContent className="flex flex-col gap-1 px-space-relaxed py-space-relaxed">
        <div className="text-button-sm text-muted">{label}</div>
        <div
          className="text-card-title tabular-nums text-foreground"
          data-testid={testId}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
