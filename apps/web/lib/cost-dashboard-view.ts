/**
 * S-024 コスト詳細ダッシュボード (T-07-05) のビューヘルパ。
 *
 * RSC で Prisma 集計結果を受け取り、Client Component に渡すための
 * シリアライズ + KPI 計算 + CSV ビルドを行う純粋関数群。
 *
 * 仕様根拠:
 *  - docs/04 S-024
 *  - docs/05 §10.4 (当月コスト集計)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostKpi {
  actual: number;
  forecast: number;
  remaining: number;
  ratioPct: number;
  perBook: number;
  bookCount: number;
  elapsedDays: number;
  totalDays: number;
}

export interface DailyCostRow {
  date: string;
  provider: string;
  cost_jpy: number;
  call_count: number;
}

export interface BreakdownRow {
  key: string;
  input_tokens: number;
  output_tokens: number;
  cost_jpy: number;
  call_count: number;
  share_pct: number;
}

export interface TopCostBookSerialized {
  book_id: string;
  title: string;
  total_cost_jpy: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_image_count: number;
  over_threshold: boolean;
}

export interface PausedBookSerialized {
  id: string;
  title: string;
  status: string;
  cost_status: string;
  cost_jpy_total: number;
  account_pen_name: string;
}

export type PredictionLevel = 'safe' | 'yellow' | 'orange' | 'red';

// ---------------------------------------------------------------------------
// KPI computation
// ---------------------------------------------------------------------------

const MONTHLY_LIMIT = 50_000;
const BOOK_COST_THRESHOLD = 500;

export function computeCostKpi(
  actual: number,
  bookCount: number,
  now: Date,
): CostKpi {
  const year = now.getFullYear();
  const month = now.getMonth();

  const totalDays = daysInMonth(year, month);
  const elapsedDays = Math.max(now.getDate(), 1);

  const forecast = elapsedDays > 0
    ? (actual / elapsedDays) * totalDays
    : 0;

  const remaining = Math.max(MONTHLY_LIMIT - actual, 0);
  const ratioPct = MONTHLY_LIMIT > 0
    ? (actual / MONTHLY_LIMIT) * 100
    : 0;
  const perBook = bookCount > 0 ? actual / bookCount : 0;

  return {
    actual,
    forecast: Math.round(forecast),
    remaining,
    ratioPct: Math.round(ratioPct * 10) / 10,
    perBook: Math.round(perBook),
    bookCount,
    elapsedDays,
    totalDays,
  };
}

export function getPredictionLevel(ratioPct: number): PredictionLevel {
  if (ratioPct >= 100) return 'red';
  if (ratioPct >= 95) return 'orange';
  if (ratioPct >= 80) return 'yellow';
  return 'safe';
}

export function getForecastLevel(forecastRatioPct: number): PredictionLevel {
  if (forecastRatioPct >= 100) return 'red';
  if (forecastRatioPct >= 95) return 'orange';
  if (forecastRatioPct >= 80) return 'yellow';
  return 'safe';
}

// ---------------------------------------------------------------------------
// Breakdown aggregation
// ---------------------------------------------------------------------------

export function aggregateByKey(
  rows: Array<{ key: string; cost_jpy: number; input_tokens: number; output_tokens: number; call_count: number }>,
): BreakdownRow[] {
  const map = new Map<string, { input_tokens: number; output_tokens: number; cost_jpy: number; call_count: number }>();

  for (const r of rows) {
    const existing = map.get(r.key);
    if (existing) {
      existing.input_tokens += r.input_tokens;
      existing.output_tokens += r.output_tokens;
      existing.cost_jpy += r.cost_jpy;
      existing.call_count += r.call_count;
    } else {
      map.set(r.key, {
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cost_jpy: r.cost_jpy,
        call_count: r.call_count,
      });
    }
  }

  const total = Array.from(map.values()).reduce((acc, r) => acc + r.cost_jpy, 0);
  const result: BreakdownRow[] = [];

  for (const [key, val] of map) {
    result.push({
      key,
      input_tokens: val.input_tokens,
      output_tokens: val.output_tokens,
      cost_jpy: val.cost_jpy,
      call_count: val.call_count,
      share_pct: total > 0 ? Math.round((val.cost_jpy / total) * 1000) / 10 : 0,
    });
  }

  result.sort((a, b) => b.cost_jpy - a.cost_jpy);
  return result;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export function serializeTopCostBook(
  raw: { book_id: string; total_cost_jpy: number; total_input_tokens: number; total_output_tokens: number; total_image_count: number },
  titleMap: Map<string, string>,
): TopCostBookSerialized {
  return {
    book_id: raw.book_id,
    title: titleMap.get(raw.book_id) ?? raw.book_id,
    total_cost_jpy: Math.round(raw.total_cost_jpy),
    total_input_tokens: raw.total_input_tokens,
    total_output_tokens: raw.total_output_tokens,
    total_image_count: raw.total_image_count,
    over_threshold: raw.total_cost_jpy > BOOK_COST_THRESHOLD,
  };
}

export function serializePausedBook(raw: {
  id: string;
  title: string;
  status: string;
  cost_status: string;
  cost_jpy_total: unknown;
  account: { pen_name: string } | null;
}): PausedBookSerialized {
  return {
    id: raw.id,
    title: raw.title,
    status: raw.status,
    cost_status: raw.cost_status,
    cost_jpy_total: toNumber(raw.cost_jpy_total),
    account_pen_name: raw.account?.pen_name ?? '',
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CSV builder
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  'date',
  'provider',
  'model',
  'role',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'image_count',
  'cost_jpy',
] as const;

export interface CostCsvRow {
  date: string;
  provider: string;
  model: string;
  role: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  image_count: number;
  cost_jpy: number;
}

function escapeField(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCostCsv(rows: readonly CostCsvRow[]): string {
  const lines: string[] = [];
  lines.push(CSV_HEADERS.map(escapeField).join(','));
  for (const r of rows) {
    lines.push(
      [
        escapeField(r.date),
        escapeField(r.provider),
        escapeField(r.model),
        escapeField(r.role),
        escapeField(r.input_tokens),
        escapeField(r.output_tokens),
        escapeField(r.cached_input_tokens),
        escapeField(r.image_count),
        escapeField(r.cost_jpy),
      ].join(','),
    );
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function buildCostCsvFilename(year: number, month: number): string {
  const m = String(month).padStart(2, '0');
  return `cost-detail-${year}-${m}.csv`;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
