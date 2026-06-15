'use client';

/**
 * S-028 AlertsKpiStripe (T-07-08).
 *
 * Displays unread count, unresolved count, total, and kind-level counts.
 */
import { messages } from '@/lib/messages';
import type { AlertsKpi } from '@/lib/alerts-view';
import { getKindLabel } from '@/lib/alerts-view';

const m = messages.alerts;

interface AlertsKpiStripeProps {
  kpi: AlertsKpi;
}

export function AlertsKpiStripe({ kpi }: AlertsKpiStripeProps) {
  const kindEntries = Object.entries(kpi.kindCounts).sort(
    ([, a], [, b]) => b - a,
  );

  return (
    <div data-testid="alerts-kpi" className="flex flex-col gap-space-snug">
      {/* Primary KPI row */}
      <div className="grid grid-cols-3 gap-space-snug">
        <KpiCard
          testId="kpi-unread"
          label={m.kpi.unreadLabel}
          value={`${kpi.unread} ${m.kpi.countSuffix}`}
          highlight={kpi.unread > 0}
          variant="destructive"
        />
        <KpiCard
          testId="kpi-unresolved"
          label={m.kpi.unresolvedLabel}
          value={`${kpi.unresolved} ${m.kpi.countSuffix}`}
          highlight={kpi.unresolved > 0}
        />
        <KpiCard
          testId="kpi-total"
          label={m.kpi.totalLabel}
          value={`${kpi.total} ${m.kpi.countSuffix}`}
        />
      </div>

      {/* Kind-level counts */}
      {kindEntries.length > 0 && (
        <div
          data-testid="alerts-kind-counts"
          className="flex flex-wrap gap-space-snug"
        >
          {kindEntries.map(([kind, count]) => (
            <div
              key={kind}
              data-testid={`kind-count-${kind}`}
              className="rounded-card border border-border-warm bg-cream-light px-3 py-1.5"
            >
              <span className="text-button-sm text-muted">
                {getKindLabel(kind)}
              </span>
              <span className="ml-2 text-button-sm font-medium text-charcoal">
                {count} {m.kpi.countSuffix}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface KpiCardProps {
  testId: string;
  label: string;
  value: string;
  highlight?: boolean;
  variant?: 'destructive';
}

function KpiCard({ testId, label, value, highlight, variant }: KpiCardProps) {
  const valueColor =
    variant === 'destructive' && highlight
      ? 'text-destructive'
      : highlight
        ? 'text-charcoal'
        : 'text-charcoal-82';

  return (
    <div
      data-testid={testId}
      className="rounded-card border border-border-warm bg-cream-light p-space-snug"
    >
      <p className="text-button-sm text-muted">{label}</p>
      <p className={`text-card-title font-medium ${valueColor}`}>{value}</p>
    </div>
  );
}
