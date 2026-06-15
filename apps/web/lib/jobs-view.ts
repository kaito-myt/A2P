/**
 * S-025/S-026 ジョブログ (T-09-01, T-09-02, F-045/F-046) のビューヘルパ。
 *
 * RSC で Prisma 集計結果を受け取り、Client Component に渡すための
 * シリアライズ + 統計計算を行う純粋関数群。
 *
 * 仕様根拠: docs/04 S-025/S-026 / docs/05 §4.3.14
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobRowSerialized {
  id: string;
  kind: string;
  book_id: string | null;
  book_title: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number | null;
  retries: number;
  error_summary: string | null;
}

export interface JobStats {
  success_rate_pct: number;
  avg_duration_ms: number | null;
  failed_count: number;
}

// Raw DB row shape from Prisma select
export interface JobRawRow {
  id: string;
  kind: string;
  book_id: string | null;
  book?: { id: string; title: string } | null;
  status: string;
  started_at: Date | null;
  finished_at: Date | null;
  retries: number;
  error: string | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export function serializeJobRow(row: JobRawRow): JobRowSerialized {
  const elapsedMs =
    row.started_at && row.finished_at
      ? row.finished_at.getTime() - row.started_at.getTime()
      : row.started_at && !row.finished_at && row.status === 'running'
        ? Date.now() - row.started_at.getTime()
        : null;

  const errorSummary = row.error ? row.error.slice(0, 80) : null;

  return {
    id: row.id,
    kind: row.kind,
    book_id: row.book_id,
    book_title: row.book?.title ?? null,
    status: row.status,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    elapsed_ms: elapsedMs,
    retries: row.retries,
    error_summary: errorSummary,
  };
}

// ---------------------------------------------------------------------------
// Stats computation (direct over raw rows — for 24h window)
// ---------------------------------------------------------------------------

export function computeJobStats(rows: JobRawRow[]): JobStats {
  if (rows.length === 0) {
    return { success_rate_pct: 0, avg_duration_ms: null, failed_count: 0 };
  }

  const done = rows.filter((r) => r.status === 'done');
  const failed = rows.filter((r) => r.status === 'failed');
  const terminal = rows.filter(
    (r) => r.status === 'done' || r.status === 'failed' || r.status === 'cancelled',
  );

  const successRatePct =
    terminal.length > 0 ? Math.round((done.length / terminal.length) * 100) : 0;

  const durations = done
    .filter((r) => r.started_at !== null && r.finished_at !== null)
    .map((r) => r.finished_at!.getTime() - r.started_at!.getTime());

  const avgDurationMs =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

  return {
    success_rate_pct: successRatePct,
    avg_duration_ms: avgDurationMs,
    failed_count: failed.length,
  };
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

export function formatElapsedMs(ms: number | null): string {
  if (ms === null) return '—';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec} 秒`;
  return `${min} 分 ${String(sec).padStart(2, '0')} 秒`;
}

export function formatAvgDuration(ms: number | null): string {
  if (ms === null) return '—';
  return formatElapsedMs(ms);
}

// ---------------------------------------------------------------------------
// S-026 Job detail serialization
// ---------------------------------------------------------------------------

export interface TokenUsageSerialized {
  id: string;
  provider: string;
  model: string;
  role: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  image_count: number;
  cost_jpy: string; // Decimal serialized as string
  created_at: string;
}

export interface JobDetailSerialized {
  id: string;
  kind: string;
  book_id: string | null;
  book_title: string | null;
  book_thumbnail_r2_key: string | null;
  status: string;
  payload_json: unknown;
  result_json: unknown;
  error: string | null;
  retries: number;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number | null;
  created_at: string;
  token_usages: TokenUsageSerialized[];
  /** Total input tokens for this job */
  total_input_tokens: number;
  /** Total output tokens for this job */
  total_output_tokens: number;
  /** Total cost in JPY, formatted string */
  total_cost_jpy: string;
}

export interface JobDetailRawRow {
  id: string;
  kind: string;
  book_id: string | null;
  book?: {
    id: string;
    title: string;
    covers?: Array<{ r2_key: string; status: string }> | null;
  } | null;
  status: string;
  payload_json: unknown;
  result_json: unknown;
  error: string | null;
  retries: number;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  tokenUsages: Array<{
    id: string;
    provider: string;
    model: string;
    role: string;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    image_count: number;
    cost_jpy: { toString(): string };
    created_at: Date;
  }>;
}

export function serializeJobDetail(row: JobDetailRawRow): JobDetailSerialized {
  const elapsedMs =
    row.started_at && row.finished_at
      ? row.finished_at.getTime() - row.started_at.getTime()
      : row.started_at && !row.finished_at && row.status === 'running'
        ? Date.now() - row.started_at.getTime()
        : null;

  const tokenUsages: TokenUsageSerialized[] = row.tokenUsages.map((tu) => ({
    id: tu.id,
    provider: tu.provider,
    model: tu.model,
    role: tu.role,
    input_tokens: tu.input_tokens,
    output_tokens: tu.output_tokens,
    cached_input_tokens: tu.cached_input_tokens,
    image_count: tu.image_count,
    cost_jpy: tu.cost_jpy.toString(),
    created_at: tu.created_at.toISOString(),
  }));

  const totalInput = tokenUsages.reduce((s, t) => s + t.input_tokens, 0);
  const totalOutput = tokenUsages.reduce((s, t) => s + t.output_tokens, 0);
  const totalCostJpy = tokenUsages
    .reduce((s, t) => s + parseFloat(t.cost_jpy), 0)
    .toFixed(2);

  // Find adopted cover thumbnail r2_key if book has covers
  const adoptedCover = row.book?.covers?.find((c) => c.status === 'adopted');

  return {
    id: row.id,
    kind: row.kind,
    book_id: row.book_id,
    book_title: row.book?.title ?? null,
    book_thumbnail_r2_key: adoptedCover?.r2_key ?? null,
    status: row.status,
    payload_json: row.payload_json,
    result_json: row.result_json,
    error: row.error,
    retries: row.retries,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    elapsed_ms: elapsedMs,
    created_at: row.created_at.toISOString(),
    token_usages: tokenUsages,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cost_jpy: totalCostJpy,
  };
}
