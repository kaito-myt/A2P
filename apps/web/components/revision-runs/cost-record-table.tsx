'use client';

/**
 * CostRecordTable — S-014 コスト記録テーブル (T-06-09).
 *
 * Displays token_usage rows for this revision run.
 * Same display pattern as S-010 CostTab but scoped to the run.
 */
import { formatCostJpy, formatProvider, formatRole, formatTokenCount } from '@/lib/cost-view';
import { messages } from '@/lib/messages';
import type { RunCostRow } from '@/lib/revision-runs-view';

const m = messages.revisionRuns.cost;

interface CostRecordTableProps {
  costRows: RunCostRow[];
  totalJpy: number;
}

export function CostRecordTable({ costRows, totalJpy }: CostRecordTableProps) {
  if (costRows.length === 0) {
    return (
      <div
        data-testid="cost-record-empty"
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
      >
        <p className="text-body text-muted">{m.empty}</p>
      </div>
    );
  }

  return (
    <div data-testid="cost-record-table" className="overflow-x-auto">
      <table className="w-full text-button-sm">
        <thead>
          <tr className="border-b border-border-warm text-left text-charcoal-82">
            <th className="px-3 py-2">{m.colProvider}</th>
            <th className="px-3 py-2">{m.colModel}</th>
            <th className="px-3 py-2">{m.colRole}</th>
            <th className="px-3 py-2 text-right">{m.colInputTokens}</th>
            <th className="px-3 py-2 text-right">{m.colOutputTokens}</th>
            <th className="px-3 py-2 text-right">{m.colCostJpy}</th>
            <th className="px-3 py-2 text-right">{m.colCallCount}</th>
          </tr>
        </thead>
        <tbody>
          {costRows.map((row, i) => (
            <tr
              key={`${row.provider}-${row.model}-${row.role}-${i}`}
              className="border-b border-border-warm last:border-0"
            >
              <td className="px-3 py-2">{formatProvider(row.provider)}</td>
              <td className="px-3 py-2">{row.model}</td>
              <td className="px-3 py-2">{formatRole(row.role)}</td>
              <td className="px-3 py-2 text-right">{formatTokenCount(row.input_tokens)}</td>
              <td className="px-3 py-2 text-right">{formatTokenCount(row.output_tokens)}</td>
              <td className="px-3 py-2 text-right">{formatCostJpy(row.cost_jpy)}</td>
              <td className="px-3 py-2 text-right">{row.call_count}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-warm font-medium">
            <td colSpan={5} className="px-3 py-2 text-right">
              {m.totalLabel}
            </td>
            <td className="px-3 py-2 text-right">{formatCostJpy(totalJpy)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
