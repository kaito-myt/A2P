/**
 * ModelCatalog CSV シリアライザ (T-02-10).
 *
 * RFC 4180 準拠の最小実装:
 *  - フィールドにカンマ / ダブルクオート / 改行が含まれる場合は `"` で囲み、
 *    フィールド内の `"` は `""` にエスケープ。
 *  - 行終端は CRLF。
 *  - 先頭に UTF-8 BOM (Excel 互換)。
 *
 * 列順 (タスク仕様):
 *   provider, model, input_price_usd, output_price_usd,
 *   image_price_usd, fx_rate, fetched_at, source
 *
 * 入出力は純粋関数。Route Handler から呼ぶ。
 */

export interface ModelCatalogCsvRow {
  provider: string;
  model: string;
  /** USD / 1M tok。 */
  input_price_per_mtok_usd: string | number;
  /** USD / 1M tok。 */
  output_price_per_mtok_usd: string | number;
  /** USD / image。null 可。 */
  image_price_per_image_usd: string | number | null;
  /** USD/JPY 為替レート。 */
  fx_rate_usd_jpy: string | number;
  /** ISO 8601 文字列を期待。Date を渡してもよい (toISOString)。 */
  fetched_at: string | Date;
  source: string;
}

const HEADERS = [
  'provider',
  'model',
  'input_price_usd',
  'output_price_usd',
  'image_price_usd',
  'fx_rate',
  'fetched_at',
  'source',
] as const;

function escapeField(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function fetchedAtToString(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

/**
 * BOM 付き UTF-8 CSV 文字列を返す。
 *
 * @param rows ModelCatalog の現行行 (`is_current=true`)
 */
export function buildModelCatalogCsv(rows: readonly ModelCatalogCsvRow[]): string {
  const lines: string[] = [];
  lines.push(HEADERS.map(escapeField).join(','));
  for (const r of rows) {
    lines.push(
      [
        escapeField(r.provider),
        escapeField(r.model),
        escapeField(r.input_price_per_mtok_usd),
        escapeField(r.output_price_per_mtok_usd),
        escapeField(r.image_price_per_image_usd),
        escapeField(r.fx_rate_usd_jpy),
        escapeField(fetchedAtToString(r.fetched_at)),
        escapeField(r.source),
      ].join(','),
    );
  }
  // UTF-8 BOM + CRLF 行終端
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** ファイル名: `model-catalog-YYYY-MM-DD.csv` (UTC)。 */
export function buildCsvFilename(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `model-catalog-${y}-${m}-${d}.csv`;
}
