/**
 * S-010 コスト内訳タブ (T-04-10) の純粋関数ヘルパ。
 *
 * RSC で Prisma tokenUsage.groupBy の結果を受け取り、
 * Client Component に渡すためのシリアライズ + 表示フォーマットを行う。
 */

import { messages } from './messages';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Prisma groupBy raw result (one row per provider x model x role). */
export interface CostGroupByRaw {
  provider: string;
  model: string;
  role: string;
  _sum: {
    input_tokens: number | null;
    output_tokens: number | null;
    cached_input_tokens: number | null;
    image_count: number | null;
    cost_jpy: unknown; // Prisma Decimal comes as Decimal | null
  };
  _count: {
    _all: number;
  };
}

/** Serialized row for client. */
export interface CostBreakdownRow {
  provider: string;
  model: string;
  role: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  image_count: number;
  cost_jpy: number;
  call_count: number;
}

/** Summary totals. */
export interface CostBreakdownSummary {
  rows: CostBreakdownRow[];
  total_cost_jpy: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_call_count: number;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

export function serializeCostGroupBy(rawRows: CostGroupByRaw[]): CostBreakdownSummary {
  const rows: CostBreakdownRow[] = rawRows.map(serializeRow);

  rows.sort((a, b) => b.cost_jpy - a.cost_jpy);

  const total_cost_jpy = rows.reduce((acc, r) => acc + r.cost_jpy, 0);
  const total_input_tokens = rows.reduce((acc, r) => acc + r.input_tokens, 0);
  const total_output_tokens = rows.reduce((acc, r) => acc + r.output_tokens, 0);
  const total_call_count = rows.reduce((acc, r) => acc + r.call_count, 0);

  return { rows, total_cost_jpy, total_input_tokens, total_output_tokens, total_call_count };
}

function serializeRow(raw: CostGroupByRaw): CostBreakdownRow {
  return {
    provider: raw.provider,
    model: raw.model,
    role: raw.role,
    input_tokens: raw._sum.input_tokens ?? 0,
    output_tokens: raw._sum.output_tokens ?? 0,
    cached_input_tokens: raw._sum.cached_input_tokens ?? 0,
    image_count: raw._sum.image_count ?? 0,
    cost_jpy: toNumber(raw._sum.cost_jpy),
    call_count: raw._count._all,
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const m = messages.books.cost;

export function formatCostJpy(value: number): string {
  return `¥${Math.round(value).toLocaleString('ja-JP')}`;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return value.toLocaleString('ja-JP');
}

export function formatRole(role: string): string {
  return m.roles[role] ?? role;
}

export function formatProvider(provider: string): string {
  const first = provider.charAt(0).toUpperCase();
  return first + provider.slice(1);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
