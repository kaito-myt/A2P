/**
 * S-021 モデル A/B 比較ビュー — サーバ専用ヘルパ (T-13-04, F-026).
 *
 * このモジュールは @a2p/db (Prisma) を import するため**サーバ専用**。
 * 'use client' コンポーネントからは import しないこと。
 *
 * クライアント安全な型・ロジックは ab-comparison-shared.ts を参照。
 * 仕様根拠: docs/04 §S-021 / SP-13 T-13-04 / CLAUDE.md client/server 境界
 */

import { prisma } from '@a2p/db';
import {
  getAbComparisonStats,
  type AbComparisonFilter,
  type AbGroupStats,
  type AbComparisonResult,
} from '@a2p/db/ab-comparison';

import type {
  AbComparisonResultSerialized,
  AbGroupStatsSerialized,
  AbComparisonFilterSerialized,
} from './ab-comparison-shared';

// Re-export for RSC page convenience (no Prisma import needed in page.tsx)
export type { AbComparisonFilter, AbComparisonFilterSerialized };
export type { AbComparisonResultSerialized, AbGroupStatsSerialized };

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function serializeGroupStats(stats: AbGroupStats): AbGroupStatsSerialized {
  return {
    group_key: stats.group_key,
    label: stats.label,
    book_count: stats.book_count,
    avg_quality_score: stats.avg_quality_score,
    avg_cost_jpy: stats.avg_cost_jpy,
    avg_lead_time_hours: stats.avg_lead_time_hours,
    median_royalty_jpy: stats.median_royalty_jpy,
    total_cached_input_tokens: stats.total_cached_input_tokens,
    total_input_tokens: stats.total_input_tokens,
    cache_hit_rate: stats.cache_hit_rate,
    insufficient_data: stats.insufficient_data,
    book_ids: stats.book_ids,
  };
}

function serializeFilter(filter: AbComparisonFilter): AbComparisonFilterSerialized {
  if (filter.mode === 'period') {
    return {
      mode: 'period',
      periodA: filter.periodA
        ? {
            from: filter.periodA.from.toISOString().slice(0, 10),
            to: filter.periodA.to.toISOString().slice(0, 10),
          }
        : undefined,
      periodB: filter.periodB
        ? {
            from: filter.periodB.from.toISOString().slice(0, 10),
            to: filter.periodB.to.toISOString().slice(0, 10),
          }
        : undefined,
      minSample: filter.minSample,
    };
  }
  return {
    mode: filter.mode,
    role: filter.role,
    baselineId: filter.baselineId,
    candidateId: filter.candidateId,
    minSample: filter.minSample,
  };
}

function serializeAbComparisonResult(
  result: AbComparisonResult,
): AbComparisonResultSerialized {
  return {
    filter: serializeFilter(result.filter),
    group_a: serializeGroupStats(result.group_a),
    group_b: serializeGroupStats(result.group_b),
  };
}

// ---------------------------------------------------------------------------
// searchParams → AbComparisonFilter (server-side, uses Date objects)
// ---------------------------------------------------------------------------

function parseDate(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function lastMonthRange(): { from: Date; to: Date } {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
    to: new Date(now.getFullYear(), now.getMonth(), 1),
  };
}

function thisMonthRange(): { from: Date; to: Date } {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
  };
}

function spVal(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Convert Next.js searchParams to AbComparisonFilter (server-side, Date objects).
 */
export function buildFilterFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): AbComparisonFilter {
  const mode = (spVal(params, 'mode') ?? 'period') as AbComparisonFilter['mode'];
  const role = spVal(params, 'role') ?? 'writer';
  const minSampleRaw = parseInt(spVal(params, 'minSample') ?? '5', 10);
  const minSample = Number.isFinite(minSampleRaw) && minSampleRaw > 0 ? minSampleRaw : 5;

  if (mode === 'period') {
    const lastMonth = lastMonthRange();
    const thisMonth = thisMonthRange();

    return {
      mode: 'period',
      periodA: {
        from: parseDate(spVal(params, 'dateFromA'), lastMonth.from),
        to: parseDate(spVal(params, 'dateToA'), lastMonth.to),
      },
      periodB: {
        from: parseDate(spVal(params, 'dateFromB'), thisMonth.from),
        to: parseDate(spVal(params, 'dateToB'), thisMonth.to),
      },
      minSample,
    };
  }

  return {
    mode,
    role,
    baselineId: spVal(params, 'baselineId') ?? '',
    candidateId: spVal(params, 'candidateId') ?? '',
    minSample,
  };
}

// ---------------------------------------------------------------------------
// Main server function — RSC page calls this
// ---------------------------------------------------------------------------

export async function fetchAbComparisonView(
  filter: AbComparisonFilter,
): Promise<AbComparisonResultSerialized> {
  const result = await getAbComparisonStats(prisma, filter);
  return serializeAbComparisonResult(result);
}
