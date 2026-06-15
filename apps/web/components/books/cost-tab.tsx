'use client';

/**
 * S-010 コスト内訳タブ (T-04-10).
 *
 * CostBreakdownTable: provider x model x role で集計した行を表形式で表示。
 * F-033 の先行実装。500 円閾値ラインも表示。
 */
import { messages } from '@/lib/messages';
import {
  formatCostJpy,
  formatTokenCount,
  formatRole,
  formatProvider,
  type CostBreakdownSummary,
} from '@/lib/cost-view';
import { COST_THRESHOLD_WARN } from '@/lib/books-view';

const m = messages.books.cost;

interface CostTabProps {
  costBreakdown: CostBreakdownSummary;
}

export function CostTab({ costBreakdown }: CostTabProps) {
  const { rows, total_cost_jpy, total_input_tokens, total_output_tokens, total_call_count } =
    costBreakdown;

  if (rows.length === 0) {
    return (
      <div
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        data-testid="cost-tab-empty"
      >
        <p className="text-body text-muted">{m.empty}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-space-snug" data-testid="cost-tab">
      {/* Threshold indicator */}
      <div className="text-caption text-muted">
        {m.thresholdWarnLine}:{' '}
        <span
          className={total_cost_jpy >= COST_THRESHOLD_WARN ? 'font-medium text-destructive' : ''}
        >
          {formatCostJpy(total_cost_jpy)}
        </span>{' '}
        / {formatCostJpy(COST_THRESHOLD_WARN)}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table
          className="w-full border-collapse text-body"
          data-testid="cost-breakdown-table"
        >
          <thead>
            <tr className="border-b border-border-warm text-left text-caption text-muted">
              <th className="px-2 py-1">{m.colProvider}</th>
              <th className="px-2 py-1">{m.colModel}</th>
              <th className="px-2 py-1">{m.colRole}</th>
              <th className="px-2 py-1 text-right">{m.colCallCount}</th>
              <th className="px-2 py-1 text-right">{m.colInputTokens}</th>
              <th className="px-2 py-1 text-right">{m.colOutputTokens}</th>
              <th className="px-2 py-1 text-right">{m.colCachedTokens}</th>
              <th className="px-2 py-1 text-right">{m.colImageCount}</th>
              <th className="px-2 py-1 text-right">{m.colCostJpy}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.provider}-${row.model}-${row.role}`}
                className="border-b border-border-warm"
                data-testid="cost-breakdown-row"
              >
                <td className="px-2 py-1">{formatProvider(row.provider)}</td>
                <td className="px-2 py-1 font-mono text-caption">{row.model}</td>
                <td className="px-2 py-1">{formatRole(row.role)}</td>
                <td className="px-2 py-1 text-right">{row.call_count}</td>
                <td className="px-2 py-1 text-right">{formatTokenCount(row.input_tokens)}</td>
                <td className="px-2 py-1 text-right">{formatTokenCount(row.output_tokens)}</td>
                <td className="px-2 py-1 text-right">{formatTokenCount(row.cached_input_tokens)}</td>
                <td className="px-2 py-1 text-right">{row.image_count}</td>
                <td className="px-2 py-1 text-right font-medium">{formatCostJpy(row.cost_jpy)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border-warm font-medium">
              <td className="px-2 py-1" colSpan={3}>
                {m.totalLabel}
              </td>
              <td className="px-2 py-1 text-right">{total_call_count}</td>
              <td className="px-2 py-1 text-right">{formatTokenCount(total_input_tokens)}</td>
              <td className="px-2 py-1 text-right">{formatTokenCount(total_output_tokens)}</td>
              <td className="px-2 py-1 text-right" />
              <td className="px-2 py-1 text-right" />
              <td className="px-2 py-1 text-right">{formatCostJpy(total_cost_jpy)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
