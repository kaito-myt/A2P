/**
 * S-024 DailyCostTable (T-07-05).
 *
 * Phase 1: テーブル表示で日別コスト一覧を代替。
 * recharts 導入は Phase 2 で DailyCostStackedChart に置き換える。
 */
import { messages } from '@/lib/messages';
import { formatCostJpy, type DailyCostRow } from '@/lib/cost-dashboard-view';

interface DailyCostTableProps {
  rows: DailyCostRow[];
}

const m = messages.costDashboard.dailyCost;

export function DailyCostTable({ rows }: DailyCostTableProps) {
  if (rows.length === 0) {
    return (
      <div
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        data-testid="daily-cost-empty"
      >
        <p className="text-body text-muted">{m.empty}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-card border border-border-warm" data-testid="daily-cost-table">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b border-border-warm bg-cream-light text-left">
            <th className="px-space-relaxed py-space-snug font-medium text-charcoal">{m.colDate}</th>
            <th className="px-space-relaxed py-space-snug font-medium text-charcoal">{m.colProvider}</th>
            <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colCostJpy}</th>
            <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colCallCount}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.date}-${row.provider}-${i}`} className="border-b border-border-warm last:border-0">
              <td className="px-space-relaxed py-space-snug text-charcoal">{row.date}</td>
              <td className="px-space-relaxed py-space-snug text-charcoal">{row.provider}</td>
              <td className="px-space-relaxed py-space-snug text-right text-charcoal">{formatCostJpy(row.cost_jpy)}</td>
              <td className="px-space-relaxed py-space-snug text-right text-muted">{row.call_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="bg-cream-light px-space-relaxed py-space-snug text-center">
        <p className="text-caption text-muted">{m.chartPlaceholder}</p>
      </div>
    </div>
  );
}
