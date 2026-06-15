'use client';

/**
 * S-013 CommentsSummaryKpi (T-06-06).
 *
 * Displays pending count, must count, affected books, estimated cost.
 * Phase 1: 固定単価 50円/コメント.
 */
import { messages } from '@/lib/messages';
import type { CommentsKpi } from '@/lib/comments-view';

const m = messages.commentsPage.kpi;

interface CommentsSummaryKpiProps {
  kpi: CommentsKpi;
}

export function CommentsSummaryKpi({ kpi }: CommentsSummaryKpiProps) {
  return (
    <div
      data-testid="comments-summary-kpi"
      className="grid grid-cols-2 gap-space-snug sm:grid-cols-4"
    >
      <KpiCard
        testId="kpi-pending"
        label={m.pendingLabel}
        value={m.pendingCount(kpi.pending)}
        highlight={kpi.pending > 0}
      />
      <KpiCard
        testId="kpi-must"
        label={m.mustLabel}
        value={m.mustCount(kpi.must)}
        highlight={kpi.must > 0}
        variant="destructive"
      />
      <KpiCard
        testId="kpi-affected-books"
        label={m.affectedBooksLabel}
        value={m.affectedBooksCount(kpi.affectedBooks)}
      />
      <KpiCard
        testId="kpi-estimated-cost"
        label={m.estimatedCostLabel}
        value={m.estimatedCostValue(kpi.estimatedCostJpy)}
      />
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
