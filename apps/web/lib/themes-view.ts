/**
 * S-006 テーマ候補一覧 (T-03-07) + S-007 詳細 (T-03-08) のシリアライズヘルパ。
 *
 * RSC で Prisma `ThemeCandidate` を Client Component に渡す際、Date / Json は
 * そのままだとシリアライズ境界を越えられないので、ここで一次正規化する。
 * 既存パターン: `model-assignments-view.ts` / `model-catalog/page.tsx` を踏襲。
 *
 * 切り出しの主因はユニットテスト可能性 (Client/Server 両方から純関数で参照)。
 *
 * 詳細ビュー (S-007) では competitors_json / signals_json を defensive に zod
 * パースし、Marketer 出力契約 (packages/contracts/agents/marketer) が破損しても
 * UI クラッシュしないようにする。
 */
import { z } from 'zod';

import type { ThemeCandidate, RevisionComment } from '@a2p/db';

export type ThemeStatus = 'pending' | 'accepted' | 'rejected';

/** RSC → Client へ渡せるよう Date/Json を string/primitive に潰した形。 */
export interface ThemeRowSerialized {
  id: string;
  theme_session_id: string;
  account_id: string;
  title: string;
  hook: string;
  target_reader: string | null;
  genre: string;
  status: ThemeStatus;
  competitor_count: number;
  /** signals_json.market_score (0-100)。欠落時 null。 */
  market_score: number | null;
  created_at: string;
  decided_at: string | null;
}

interface CountSummary {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
}

function statusOf(s: string): ThemeStatus {
  return s === 'accepted' || s === 'rejected' ? s : 'pending';
}

function extractMarketScore(signals: unknown): number | null {
  if (!signals || typeof signals !== 'object') return null;
  const v = (signals as Record<string, unknown>).market_score;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function extractCompetitorCount(competitors: unknown): number {
  if (!Array.isArray(competitors)) return 0;
  return competitors.length;
}

/**
 * Prisma 行 → Client Component に渡せる serialized form。
 * Json フィールド (competitors_json / signals_json) は深く詰めず、UI 表示に
 * 必要な集計値 (count / market_score) のみ抜き出す。
 */
export function serializeThemeRow(
  row: Pick<
    ThemeCandidate,
    | 'id'
    | 'theme_session_id'
    | 'account_id'
    | 'title'
    | 'hook'
    | 'target_reader'
    | 'genre'
    | 'status'
    | 'competitors_json'
    | 'signals_json'
    | 'created_at'
    | 'decided_at'
  >,
): ThemeRowSerialized {
  return {
    id: row.id,
    theme_session_id: row.theme_session_id,
    account_id: row.account_id,
    title: row.title,
    hook: row.hook,
    target_reader: row.target_reader,
    genre: row.genre,
    status: statusOf(row.status),
    competitor_count: extractCompetitorCount(row.competitors_json),
    market_score: extractMarketScore(row.signals_json),
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

/** 全件 / pending / accepted / rejected の集計。 */
export function summarizeRows(rows: readonly ThemeRowSerialized[]): CountSummary {
  let pending = 0;
  let accepted = 0;
  let rejected = 0;
  for (const r of rows) {
    if (r.status === 'pending') pending++;
    else if (r.status === 'accepted') accepted++;
    else if (r.status === 'rejected') rejected++;
  }
  return { total: rows.length, pending, accepted, rejected };
}

/** UI 上の selection set から、pending 件のみを抽出 (ID 配列)。 */
export function pickPendingIds(
  rows: readonly ThemeRowSerialized[],
  selectedIds: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const r of rows) {
    if (selectedIds.has(r.id) && r.status === 'pending') ids.push(r.id);
  }
  return ids;
}

/** UI 上の selection set から、ID 配列を順序保ったまま返す (rows 順)。 */
export function pickSelectedIds(
  rows: readonly ThemeRowSerialized[],
  selectedIds: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const r of rows) {
    if (selectedIds.has(r.id)) ids.push(r.id);
  }
  return ids;
}

/** ISO 文字列 → "YYYY-MM-DD HH:mm" (JST 想定の単純フォーマット)。 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

/** 長文 hook 等の truncate (60 文字を超えたら省略記号)。 */
export function truncate(text: string, max = 60): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// S-007 詳細用 (T-03-08)
// ---------------------------------------------------------------------------

/**
 * Marketer 出力 (`ThemeCompetitorSchema`) に整合する UI 表示用 Competitor 型。
 * すべて optional に倒し、空欄セルを許容する。
 */
export const CompetitorSchema = z.object({
  asin: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  url: z.string().optional(),
  rank: z.number().optional(),
  review_summary: z.string().optional(),
  note: z.string().optional(),
});
export type Competitor = z.infer<typeof CompetitorSchema>;

/**
 * Marketer 出力 (`ThemeSignalsSchema`) を UI 表示用に defensive に受ける。
 * F-001 受入で必須の reasoning/market_score も、データ破損時には null fallback
 * で UI を成立させたいので全て optional に倒す。
 */
export const SignalsSchema = z.object({
  reasoning: z.string().optional(),
  market_score: z.number().optional(),
  predicted_chapters: z.number().optional(),
  search_keywords: z.array(z.string()).optional(),
  search_volume: z.number().optional(),
  rank_estimate: z.number().optional(),
  sources: z.array(z.string()).optional(),
});
export type Signals = z.infer<typeof SignalsSchema>;

/**
 * Json (Prisma `Json` 型) を defensive に Competitor[] にパース。
 * - 非配列 / null / undefined → 空配列
 * - 要素単位で safeParse: 失敗要素は除外
 */
export function parseCompetitors(json: unknown): Competitor[] {
  if (!Array.isArray(json)) return [];
  const out: Competitor[] = [];
  for (const item of json) {
    const r = CompetitorSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

/**
 * Json (Prisma `Json` 型) を defensive に Signals にパース。
 * - 非オブジェクト / null / undefined → 空オブジェクト
 * - パース失敗時も空オブジェクト fallback
 */
export function parseSignals(json: unknown): Signals {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const r = SignalsSchema.safeParse(json);
  return r.success ? r.data : {};
}

/** RSC → Client へ渡せるよう Date/Json を string/primitive に潰した詳細形。 */
export interface ThemeDetailSerialized {
  id: string;
  theme_session_id: string;
  account_id: string;
  title: string;
  subtitle: string | null;
  hook: string;
  target_reader: string | null;
  genre: string;
  status: ThemeStatus;
  rejected_reason: string | null;
  competitors: Competitor[];
  signals: Signals;
  market_score: number | null;
  created_at: string;
  decided_at: string | null;
}

/**
 * Prisma 行 → 詳細ビュー (S-007) 用 serialized form。
 * competitors_json / signals_json は defensive parse して構造化済みで返す。
 */
export function serializeThemeDetail(
  row: Pick<
    ThemeCandidate,
    | 'id'
    | 'theme_session_id'
    | 'account_id'
    | 'title'
    | 'subtitle'
    | 'hook'
    | 'target_reader'
    | 'genre'
    | 'status'
    | 'rejected_reason'
    | 'competitors_json'
    | 'signals_json'
    | 'created_at'
    | 'decided_at'
  >,
): ThemeDetailSerialized {
  const signals = parseSignals(row.signals_json);
  return {
    id: row.id,
    theme_session_id: row.theme_session_id,
    account_id: row.account_id,
    title: row.title,
    subtitle: row.subtitle ?? null,
    hook: row.hook,
    target_reader: row.target_reader,
    genre: row.genre,
    status: statusOf(row.status),
    rejected_reason: row.rejected_reason ?? null,
    competitors: parseCompetitors(row.competitors_json),
    signals,
    market_score:
      typeof signals.market_score === 'number' && Number.isFinite(signals.market_score)
        ? signals.market_score
        : null,
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Comment serialization (T-06-05)
// ---------------------------------------------------------------------------

export interface ThemeCommentSerialized {
  id: string;
  book_id: string;
  target_kind: string;
  target_id: string;
  body: string;
  priority: string;
  status: string;
  created_at: string;
}

export function serializeThemeComment(
  c: Pick<RevisionComment, 'id' | 'book_id' | 'target_kind' | 'target_id' | 'body' | 'priority' | 'status' | 'created_at'>,
): ThemeCommentSerialized {
  return {
    id: c.id,
    book_id: c.book_id,
    target_kind: c.target_kind,
    target_id: c.target_id,
    body: c.body,
    priority: c.priority,
    status: c.status,
    created_at: c.created_at.toISOString(),
  };
}
