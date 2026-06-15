/**
 * S-021 A/B 比較ビュー — クライアント安全な共有型・ロジック (T-13-04/T-13-05, F-026).
 *
 * このモジュールは @a2p/db (Prisma) を一切 import しない。
 * 'use client' コンポーネントから安全に import できる。
 *
 * サーバ専用の取得処理は ab-comparison-view.ts を参照。
 * パターン: ab-distribution-shared.ts に準拠。
 *
 * 仕様根拠: CLAUDE.md client/server 境界 / SP-13 T-13-04
 */

// ---------------------------------------------------------------------------
// Serialized types — pure objects, no Prisma, safe for client components
// ---------------------------------------------------------------------------

/** Comparison mode. Re-declared here to avoid importing from @a2p/db. */
export type AbComparisonMode = 'period' | 'prompt' | 'model';

/** Client-safe representation of AbComparisonFilter. Dates are ISO strings. */
export interface AbComparisonFilterSerialized {
  mode: AbComparisonMode;
  periodA?: { from: string; to: string }; // ISO date strings
  periodB?: { from: string; to: string };
  role?: string;
  baselineId?: string;
  candidateId?: string;
  minSample?: number;
}

/** Serialized version of AbGroupStats — Date fields removed, numbers only. */
export interface AbGroupStatsSerialized {
  group_key: string;
  label: string;
  book_count: number;
  avg_quality_score: number | null;
  avg_cost_jpy: number | null;
  avg_lead_time_hours: number | null;
  median_royalty_jpy: number | null;
  total_cached_input_tokens: number;
  total_input_tokens: number;
  cache_hit_rate: number | null;
  insufficient_data: boolean;
  book_ids: string[];
}

export interface AbComparisonResultSerialized {
  filter: AbComparisonFilterSerialized;
  group_a: AbGroupStatsSerialized;
  group_b: AbGroupStatsSerialized;
}

// ---------------------------------------------------------------------------
// searchParams → AbComparisonFilterSerialized conversion (client-safe)
// ---------------------------------------------------------------------------

function sp(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

/** Build the default periodA (last month 1st → this month 1st). ISO strings. */
function lastMonthRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** Build the default periodB (this month 1st → today+1). ISO strings. */
function thisMonthRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/**
 * Convert Next.js searchParams to AbComparisonFilterSerialized.
 * All date values are ISO date strings (YYYY-MM-DD). Prisma-free.
 */
export function buildFilterSerializedFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): AbComparisonFilterSerialized {
  const mode = (sp(params, 'mode') ?? 'period') as AbComparisonMode;
  const role = sp(params, 'role') ?? 'writer';
  const minSampleRaw = parseInt(sp(params, 'minSample') ?? '5', 10);
  const minSample = Number.isFinite(minSampleRaw) && minSampleRaw > 0 ? minSampleRaw : 5;

  if (mode === 'period') {
    const lastMonth = lastMonthRange();
    const thisMonth = thisMonthRange();

    return {
      mode: 'period',
      periodA: {
        from: sp(params, 'dateFromA') ?? lastMonth.from,
        to: sp(params, 'dateToA') ?? lastMonth.to,
      },
      periodB: {
        from: sp(params, 'dateFromB') ?? thisMonth.from,
        to: sp(params, 'dateToB') ?? thisMonth.to,
      },
      minSample,
    };
  }

  return {
    mode,
    role,
    baselineId: sp(params, 'baselineId') ?? '',
    candidateId: sp(params, 'candidateId') ?? '',
    minSample,
  };
}

// ---------------------------------------------------------------------------
// Pure formatters — prisma 非依存
// ---------------------------------------------------------------------------

/** Format a number as Japanese yen: ¥1,234 */
export function formatJpy(value: number | null): string {
  if (value == null) return '—';
  return `¥${Math.round(value).toLocaleString('ja-JP')}`;
}

/** Format a quality score (0–100) to 1 decimal place. */
export function formatQualityScore(value: number | null): string {
  if (value == null) return '—';
  return value.toFixed(1);
}

/** Format lead time in hours to 1 decimal. */
export function formatLeadTime(value: number | null): string {
  if (value == null) return '—';
  return value.toFixed(1);
}

/** Format cache hit rate (0–1) as percentage string. */
export function formatCacheHitRate(value: number | null): string {
  if (value == null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

/** Compute signed difference label, e.g. "+2.8" or "-3.1" */
export function formatDiff(a: number | null, b: number | null): string {
  if (a == null || b == null) return '—';
  const diff = b - a;
  const sign = diff >= 0 ? '+' : '';
  return `${sign}${diff.toFixed(1)}`;
}

/** Compute signed difference label for JPY values (integer). */
export function formatDiffJpy(a: number | null, b: number | null): string {
  if (a == null || b == null) return '—';
  const diff = Math.round(b - a);
  const sign = diff >= 0 ? '+' : '-';
  return `${sign}¥${Math.abs(diff).toLocaleString('ja-JP')}`;
}

/** Format a date to Japanese locale short form. */
export function formatDateJa(isoOrNull: string | null): string {
  if (!isoOrNull) return '—';
  const d = new Date(isoOrNull);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
