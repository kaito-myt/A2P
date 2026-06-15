/**
 * S-024 BreakdownTables (T-07-05).
 *
 * Phase 1: テーブル形式で provider/model/role 別集計を表示。
 * recharts によるグラフは Phase 2 で追加。
 */
'use client';

import { useState } from 'react';

import { messages } from '@/lib/messages';
import { formatCostJpy, formatTokenCount, type BreakdownRow } from '@/lib/cost-dashboard-view';

type TabKey = 'provider' | 'model' | 'role';

interface BreakdownTablesProps {
  byProvider: BreakdownRow[];
  byModel: BreakdownRow[];
  byRole: BreakdownRow[];
}

const m = messages.costDashboard.breakdown;

const TABS: { key: TabKey; label: string }[] = [
  { key: 'provider', label: m.providerTab },
  { key: 'model', label: m.modelTab },
  { key: 'role', label: m.roleTab },
];

export function BreakdownTables({ byProvider, byModel, byRole }: BreakdownTablesProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('provider');

  const dataMap: Record<TabKey, BreakdownRow[]> = {
    provider: byProvider,
    model: byModel,
    role: byRole,
  };

  const colLabel: Record<TabKey, string> = {
    provider: m.colProvider,
    model: m.colModel,
    role: m.colRole,
  };

  const rows = dataMap[activeTab];

  return (
    <div data-testid="breakdown-tables">
      <div className="mb-space-snug flex gap-2" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`rounded-snug px-3 py-1.5 text-button-sm font-medium transition-colors ${
              activeTab === tab.key
                ? 'bg-charcoal text-cream'
                : 'bg-cream-light text-charcoal hover:bg-charcoal-04'
            }`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center">
          <p className="text-body text-muted">{m.empty}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border-warm">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b border-border-warm bg-cream-light text-left">
                <th className="px-space-relaxed py-space-snug font-medium text-charcoal">{colLabel[activeTab]}</th>
                <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colInputTokens}</th>
                <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colOutputTokens}</th>
                <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colCostJpy}</th>
                <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colCallCount}</th>
                <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colShare}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-border-warm last:border-0">
                  <td className="px-space-relaxed py-space-snug text-charcoal">
                    {activeTab === 'role' ? (m.roles[row.key] ?? row.key) : row.key}
                  </td>
                  <td className="px-space-relaxed py-space-snug text-right text-charcoal">{formatTokenCount(row.input_tokens)}</td>
                  <td className="px-space-relaxed py-space-snug text-right text-charcoal">{formatTokenCount(row.output_tokens)}</td>
                  <td className="px-space-relaxed py-space-snug text-right text-charcoal">{formatCostJpy(row.cost_jpy)}</td>
                  <td className="px-space-relaxed py-space-snug text-right text-muted">{row.call_count}</td>
                  <td className="px-space-relaxed py-space-snug text-right text-muted">{row.share_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
