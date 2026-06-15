'use client';

/**
 * S-021 ComparisonKpiCards (T-13-05, F-026).
 *
 * A vs B の並置 KPI カード群（Quality/コスト/リードタイム/売上中央値/キャッシュヒット率）。
 * @a2p/db を import しない。
 *
 * 仕様根拠: docs/04 §S-021 / SP-13 T-13-05
 */

import { messages } from '@/lib/messages';
import type { AbGroupStatsSerialized } from '@/lib/ab-comparison-shared';
import {
  formatQualityScore,
  formatJpy,
  formatLeadTime,
  formatCacheHitRate,
  formatDiff,
  formatDiffJpy,
} from '@/lib/ab-comparison-shared';

interface ComparisonKpiCardsProps {
  groupA: AbGroupStatsSerialized;
  groupB: AbGroupStatsSerialized;
}

const m = messages.abComparison.kpi;

export function ComparisonKpiCards({ groupA, groupB }: ComparisonKpiCardsProps) {
  return (
    <div
      className="grid grid-cols-1 gap-space-snug sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
      data-testid="ab-kpi-cards"
    >
      <KpiCard
        label={m.qualityLabel}
        valueA={formatQualityScore(groupA.avg_quality_score)}
        valueB={formatQualityScore(groupB.avg_quality_score)}
        diff={formatDiff(groupA.avg_quality_score, groupB.avg_quality_score)}
        rawDiff={
          groupA.avg_quality_score != null && groupB.avg_quality_score != null
            ? groupB.avg_quality_score - groupA.avg_quality_score
            : null
        }
        insufficientA={groupA.insufficient_data}
        insufficientB={groupB.insufficient_data}
        testId="ab-kpi-quality"
      />
      <KpiCard
        label={`${m.costLabel} (${m.costUnit})`}
        valueA={formatJpy(groupA.avg_cost_jpy)}
        valueB={formatJpy(groupB.avg_cost_jpy)}
        diff={formatDiffJpy(groupA.avg_cost_jpy, groupB.avg_cost_jpy)}
        rawDiff={
          groupA.avg_cost_jpy != null && groupB.avg_cost_jpy != null
            ? groupB.avg_cost_jpy - groupA.avg_cost_jpy
            : null
        }
        insufficientA={groupA.insufficient_data}
        insufficientB={groupB.insufficient_data}
        testId="ab-kpi-cost"
      />
      <KpiCard
        label={`${m.leadTimeLabel} (${m.leadTimeUnit})`}
        valueA={formatLeadTime(groupA.avg_lead_time_hours)}
        valueB={formatLeadTime(groupB.avg_lead_time_hours)}
        diff={formatDiff(groupA.avg_lead_time_hours, groupB.avg_lead_time_hours)}
        rawDiff={
          groupA.avg_lead_time_hours != null && groupB.avg_lead_time_hours != null
            ? groupB.avg_lead_time_hours - groupA.avg_lead_time_hours
            : null
        }
        insufficientA={groupA.insufficient_data}
        insufficientB={groupB.insufficient_data}
        testId="ab-kpi-lead-time"
      />
      <KpiCard
        label={`${m.royaltyLabel} (${m.royaltyUnit})`}
        valueA={formatJpy(groupA.median_royalty_jpy)}
        valueB={formatJpy(groupB.median_royalty_jpy)}
        diff={formatDiffJpy(groupA.median_royalty_jpy, groupB.median_royalty_jpy)}
        rawDiff={
          groupA.median_royalty_jpy != null && groupB.median_royalty_jpy != null
            ? groupB.median_royalty_jpy - groupA.median_royalty_jpy
            : null
        }
        insufficientA={groupA.insufficient_data}
        insufficientB={groupB.insufficient_data}
        testId="ab-kpi-royalty"
      />
      <KpiCard
        label={m.cacheHitLabel}
        valueA={groupA.cache_hit_rate != null ? formatCacheHitRate(groupA.cache_hit_rate) : m.noCacheHit}
        valueB={groupB.cache_hit_rate != null ? formatCacheHitRate(groupB.cache_hit_rate) : m.noCacheHit}
        diff={
          groupA.cache_hit_rate != null && groupB.cache_hit_rate != null
            ? formatDiff(groupA.cache_hit_rate * 100, groupB.cache_hit_rate * 100) + 'pt'
            : '—'
        }
        rawDiff={
          groupA.cache_hit_rate != null && groupB.cache_hit_rate != null
            ? groupB.cache_hit_rate - groupA.cache_hit_rate
            : null
        }
        insufficientA={groupA.insufficient_data}
        insufficientB={groupB.insufficient_data}
        testId="ab-kpi-cache"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal: single KPI card
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  valueA: string;
  valueB: string;
  diff: string;
  /** Raw numeric diff (B - A). Positive = B higher, negative = B lower. null if no data. */
  rawDiff: number | null;
  insufficientA: boolean;
  insufficientB: boolean;
  testId: string;
}

function KpiCard({
  label,
  valueA,
  valueB,
  diff,
  rawDiff,
  insufficientA,
  insufficientB,
  testId,
}: KpiCardProps) {
  const m2 = messages.abComparison.kpi;

  const diffColor =
    rawDiff == null
      ? 'text-muted'
      : rawDiff > 0
        ? 'text-green-700'
        : rawDiff < 0
          ? 'text-red-600'
          : 'text-muted';

  return (
    <div
      className="flex flex-col gap-1 rounded-card border border-border-warm bg-white p-space-snug shadow-sm"
      data-testid={testId}
    >
      <p className="text-button-sm text-muted">{label}</p>

      {/* Group A value */}
      <div className="mt-1">
        <p className="text-caption text-muted">{m2.groupALabel}</p>
        <p
          className="text-card-title text-foreground"
          data-testid={`${testId}-a`}
        >
          {insufficientA ? (
            <span className="text-caption text-muted">{m2.insufficientData}</span>
          ) : (
            valueA
          )}
        </p>
      </div>

      {/* Group B value */}
      <div>
        <p className="text-caption text-muted">{m2.groupBLabel}</p>
        <p
          className="text-card-title text-foreground"
          data-testid={`${testId}-b`}
        >
          {insufficientB ? (
            <span className="text-caption text-muted">{m2.insufficientData}</span>
          ) : (
            valueB
          )}
        </p>
      </div>

      {/* Diff */}
      {!insufficientA && !insufficientB && (
        <p
          className={`mt-1 text-button-sm font-medium ${diffColor}`}
          data-testid={`${testId}-diff`}
        >
          {m2.diffLabel}: {diff}
        </p>
      )}
    </div>
  );
}
