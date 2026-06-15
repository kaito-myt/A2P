/**
 * A/B 配信の共有型・純粋ロジック (T-11-06, F-031)
 *
 * このモジュールは @a2p/db (Prisma) を一切 import しない。
 * 'use client' コンポーネントから安全に import できる。
 *
 * サーバ専用ロジックは ab-distribution-core.ts を参照。
 */

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** A/B 配信設定の 1 エントリ。AppSettings.ab_distribution_json の各要素。 */
export interface AbDistributionConfig {
  role: string;
  genre: string;
  baseline_id: string;
  candidate_id: string;
  ratio_candidate: number;
}

// ---------------------------------------------------------------------------
// Normalization helper
// ---------------------------------------------------------------------------

/**
 * A/B 配信の genre キーを正規化する。
 * null（ジャンル非指定）→ 'default'。全経路で統一使用 (form / core / kickoff)。
 */
export function normalizeAbGenre(genre: string | null): string {
  return genre ?? 'default';
}
