/**
 * S-024 CostKpiStripe (T-07-05).
 *
 * 5 KPI cards: actual / forecast / remaining / ratio / per-book.
 */
import { Card, CardContent } from '@/components/ui/card';
import { messages } from '@/lib/messages';
import { formatCostJpy, type CostKpi } from '@/lib/cost-dashboard-view';

interface CostKpiStripeProps {
  kpi: CostKpi;
}

const m = messages.costDashboard.kpi;

export function CostKpiStripe({ kpi }: CostKpiStripeProps) {
  return (
    <div
      className="grid grid-cols-1 gap-space-snug sm:grid-cols-2 lg:grid-cols-5"
      data-testid="cost-kpi-stripe"
    >
      <KpiItem
        label={m.actualLabel}
        value={formatCostJpy(kpi.actual)}
        suffix={m.limitSuffix}
        testId="cost-kpi-actual"
      />
      <KpiItem
        label={m.forecastLabel}
        value={formatCostJpy(kpi.forecast)}
        testId="cost-kpi-forecast"
      />
      <KpiItem
        label={m.remainingLabel}
        value={formatCostJpy(kpi.remaining)}
        testId="cost-kpi-remaining"
      />
      <KpiItem
        label={m.ratioLabel}
        value={`${kpi.ratioPct}${m.pctSuffix}`}
        testId="cost-kpi-ratio"
      />
      <KpiItem
        label={m.perBookLabel}
        value={formatCostJpy(kpi.perBook)}
        testId="cost-kpi-per-book"
      />
    </div>
  );
}

function KpiItem({
  label,
  value,
  suffix,
  testId,
}: {
  label: string;
  value: string;
  suffix?: string;
  testId: string;
}) {
  return (
    <Card variant="compact">
      <CardContent className="flex flex-col gap-1 px-space-relaxed py-space-relaxed">
        <div className="text-button-sm text-muted">{label}</div>
        <div className="flex items-baseline gap-2" data-testid={testId}>
          <span className="text-card-title text-foreground">{value}</span>
          {suffix && <span className="text-button-sm text-muted">{suffix}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
