/**
 * S-011 アウトライン承認 (T-04-08) のシリアライズヘルパ。
 *
 * RSC で Prisma `Outline` (+ Book join) を Client Component に渡す際、Date / Json は
 * シリアライズ境界を越えられないので、ここで一次正規化する (themes-view 同パターン)。
 *
 * `chapters_json` は WriterOutlineOutput.chapters (packages/contracts/agents/writer)
 * と同じ形 `{ index, heading, summary, target_chars, subheadings[] }` だが、
 * 旧データや破損データを想定して zod で defensive parse する。
 */
import { z } from 'zod';

import type { Outline, Book, RevisionComment } from '@a2p/db';

import { messages } from './messages';

// ---------------------------------------------------------------------------
// chapters_json defensive schema (docs/05 §3 Outline.chapters_json 既定)
// ---------------------------------------------------------------------------

/**
 * 1 章分の defensive schema。バリデーション失敗で UI を壊さないよう、heading 以外は
 * すべて欠落許容にし、欠落時は表示側で fallback する。
 */
export const OutlineChapterPlanSchema = z.object({
  index: z.number().int().optional(),
  heading: z.string().min(1),
  summary: z.string().optional(),
  target_chars: z.number().int().optional(),
  subheadings: z.array(z.string()).optional(),
});
export type OutlineChapterPlan = z.infer<typeof OutlineChapterPlanSchema>;

/**
 * `chapters_json` (Prisma Json) を `OutlineChapterPlan[]` に defensive parse。
 * - 配列でなければ空配列
 * - 要素単位で safeParse → 失敗要素は除外
 * - heading が欠けている要素は除外 (表示時に章名がないのは情報価値ゼロ)
 */
export function parseChapters(json: unknown): OutlineChapterPlan[] {
  if (!Array.isArray(json)) return [];
  const out: OutlineChapterPlan[] = [];
  for (const item of json) {
    const r = OutlineChapterPlanSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outline 行 (Book join 込み) の serialized form
// ---------------------------------------------------------------------------

export type OutlineRowStatus = 'pending_review' | 'approved' | 'rejected' | 'draft';

function statusOf(s: string): OutlineRowStatus {
  if (s === 'approved' || s === 'rejected' || s === 'draft' || s === 'pending_review') return s;
  return 'pending_review';
}

export interface OutlineRowSerialized {
  id: string;
  book_id: string;
  status: OutlineRowStatus;
  reject_note: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  /** parse 済み章リスト (失敗時は空配列)。 */
  chapters: OutlineChapterPlan[];
  /** chapters の target_chars 合計。target_chars 欠落要素は 0 扱い。 */
  total_target_chars: number;
  /** Book join。Book が消えている場合 (FK setNull は無いが防御) は null。 */
  book: {
    id: string;
    title: string;
    account_id: string;
    genre: string | null;
    status: string;
  } | null;
}

export function serializeOutlineRow(
  row: Pick<
    Outline,
    | 'id'
    | 'book_id'
    | 'status'
    | 'reject_note'
    | 'approved_at'
    | 'created_at'
    | 'updated_at'
    | 'chapters_json'
  > & {
    book?:
      | (Pick<Book, 'id' | 'title' | 'account_id' | 'status'> & {
          theme?: { genre: string | null } | null;
        })
      | null;
  },
): OutlineRowSerialized {
  const chapters = parseChapters(row.chapters_json);
  const total = chapters.reduce(
    (acc, c) => acc + (typeof c.target_chars === 'number' && Number.isFinite(c.target_chars) ? c.target_chars : 0),
    0,
  );
  return {
    id: row.id,
    book_id: row.book_id,
    status: statusOf(row.status),
    reject_note: row.reject_note ?? null,
    approved_at: row.approved_at ? row.approved_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    chapters,
    total_target_chars: total,
    book: row.book
      ? {
          id: row.book.id,
          title: row.book.title,
          account_id: row.book.account_id,
          status: row.book.status,
          genre: row.book.theme?.genre ?? null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// 集計 / selection ユーティリティ
// ---------------------------------------------------------------------------

export interface OutlinesSummary {
  /** pending_review 件数 (= rows.length。RSC 側で pending_review に絞って渡す想定)。 */
  pending: number;
  /** pending_review の合計想定文字数。 */
  totalTargetChars: number;
  /** 影響を受ける一意 Book ID 数 (= 通常 pending と一致するが防御的に集合化)。 */
  booksAffected: number;
}

export function summarizeOutlines(rows: readonly OutlineRowSerialized[]): OutlinesSummary {
  const books = new Set<string>();
  let total = 0;
  for (const r of rows) {
    books.add(r.book_id);
    total += r.total_target_chars;
  }
  return {
    pending: rows.length,
    totalTargetChars: total,
    booksAffected: books.size,
  };
}

/** 「pending_review のもののみ」selection → ID 配列を rows 順で抽出。 */
export function pickEligibleIds(
  rows: readonly OutlineRowSerialized[],
  selectedIds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (selectedIds.has(r.id) && r.status === 'pending_review') out.push(r.id);
  }
  return out;
}

/** ジャンル enum を日本語ラベルへ。未知は raw を返す。 */
export function formatGenre(genre: string | null | undefined): string | null {
  if (!genre) return null;
  const g = messages.outlines.genres as Record<string, string>;
  return g[genre] ?? genre;
}

/** ISO → "YYYY-MM-DD HH:mm" の単純化 (themes-view と同様)。 */
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

// ---------------------------------------------------------------------------
// Comment serialization (T-06-05)
// ---------------------------------------------------------------------------

export interface OutlineCommentSerialized {
  id: string;
  book_id: string;
  target_kind: string;
  target_id: string;
  body: string;
  priority: string;
  status: string;
  created_at: string;
}

export function serializeOutlineComment(
  c: Pick<RevisionComment, 'id' | 'book_id' | 'target_kind' | 'target_id' | 'body' | 'priority' | 'status' | 'created_at'>,
): OutlineCommentSerialized {
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
