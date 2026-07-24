/**
 * @a2p/kdp-report — KDP 売上レポート(xlsx/csv)のパーサ + 正規化。
 *
 * web(手動アップロード取込) と worker(自動取得) の両方から使う共有ロジック。
 * SheetJS(xlsx) 依存はこのパッケージに閉じる。
 */
export {
  parseKdpReportWorkbook,
  parseMonth,
  type ParseResult,
  type KdpReportKind,
} from './parse.js';

export {
  normalizeKdpRows,
  normalizeCurrency,
  type KdpReportRow,
  type KdpMonthlySummary,
  type NormalizedSalesRow,
  type NormalizeResult,
  type NormalizeOptions,
} from './normalize.js';
