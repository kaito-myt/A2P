/**
 * S-013 修正コメント一覧 (T-06-06) のシリアライズ / ビューヘルパ。
 *
 * RSC で Prisma RevisionComment (+ Book join) を Client Component に渡す際の
 * Date / Json 正規化。outlines-view / covers-view と同パターン。
 *
 * 仕様根拠:
 *  - docs/04 S-013: フィルタバー / CommentsSummaryKpi / CommentsTable / グルーピング
 *  - docs/05 §4.3.7 / §4.3.8
 */

import type { CommentPriority, CommentStatus, TargetKind } from './comment-helpers';

import { formatJstDateTime } from './datetime';

// ---------------------------------------------------------------------------
// Serialized types (RSC → Client 境界越え用)
// ---------------------------------------------------------------------------

export interface CommentRowSerialized {
  id: string;
  book_id: string;
  book_title: string;
  target_kind: TargetKind;
  target_id: string;
  range_json: Record<string, unknown> | null;
  body: string;
  priority: CommentPriority;
  status: CommentStatus;
  created_at: string;
  applied_at: string | null;
}

export interface BookOption {
  id: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Serialization (Prisma raw → CommentRowSerialized)
// ---------------------------------------------------------------------------

const VALID_TARGET_KINDS = new Set<string>([
  'chapter', 'outline', 'cover', 'cover_text', 'metadata', 'theme',
]);

const VALID_PRIORITIES = new Set<string>(['must', 'should', 'may']);

const VALID_STATUSES = new Set<string>([
  'pending', 'applied', 'not_applicable', 'superseded',
]);

interface RawCommentRow {
  id: string;
  book_id: string;
  target_kind: string;
  target_id: string;
  range_json: unknown;
  body: string;
  priority: string;
  status: string;
  created_at: Date;
  applied_at: Date | null;
  book: {
    id: string;
    title: string;
  };
}

export function serializeCommentRow(raw: RawCommentRow): CommentRowSerialized {
  return {
    id: raw.id,
    book_id: raw.book_id,
    book_title: raw.book.title,
    target_kind: VALID_TARGET_KINDS.has(raw.target_kind)
      ? (raw.target_kind as TargetKind)
      : 'chapter',
    target_id: raw.target_id,
    range_json: (raw.range_json && typeof raw.range_json === 'object' && !Array.isArray(raw.range_json))
      ? (raw.range_json as Record<string, unknown>)
      : null,
    body: raw.body,
    priority: VALID_PRIORITIES.has(raw.priority)
      ? (raw.priority as CommentPriority)
      : 'may',
    status: VALID_STATUSES.has(raw.status)
      ? (raw.status as CommentStatus)
      : 'pending',
    created_at: raw.created_at.toISOString(),
    applied_at: raw.applied_at ? raw.applied_at.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// KPI 計算
// ---------------------------------------------------------------------------

export interface CommentsKpi {
  pending: number;
  must: number;
  affectedBooks: number;
  estimatedCostJpy: number;
}

/** Phase 1: 固定単価 50円/コメント */
const COST_PER_COMMENT_JPY = 50;

export function computeKpi(rows: readonly CommentRowSerialized[]): CommentsKpi {
  const pendingRows = rows.filter((r) => r.status === 'pending');
  const mustCount = pendingRows.filter((r) => r.priority === 'must').length;
  const bookIds = new Set(pendingRows.map((r) => r.book_id));

  return {
    pending: pendingRows.length,
    must: mustCount,
    affectedBooks: bookIds.size,
    estimatedCostJpy: pendingRows.length * COST_PER_COMMENT_JPY,
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type GroupByKey = 'book' | 'target_kind' | 'priority';

export interface CommentGroup {
  key: string;
  label: string;
  rows: CommentRowSerialized[];
}

const TARGET_KIND_LABELS: Record<TargetKind, string> = {
  chapter: '章本文',
  outline: 'アウトライン',
  cover: 'カバー画像',
  cover_text: 'カバーテキスト',
  metadata: 'メタデータ',
  theme: 'テーマ',
};

const PRIORITY_LABELS: Record<CommentPriority, string> = {
  must: 'must（必須修正）',
  should: 'should（推奨修正）',
  may: 'may（任意修正）',
};

const TARGET_KIND_ORDER: TargetKind[] = ['chapter', 'outline', 'cover', 'cover_text', 'metadata', 'theme'];
const PRIORITY_ORDER: CommentPriority[] = ['must', 'should', 'may'];

export function groupComments(
  rows: readonly CommentRowSerialized[],
  groupBy: GroupByKey,
): CommentGroup[] {
  if (groupBy === 'book') {
    const map = new Map<string, { title: string; rows: CommentRowSerialized[] }>();
    for (const r of rows) {
      const existing = map.get(r.book_id);
      if (existing) {
        existing.rows.push(r);
      } else {
        map.set(r.book_id, { title: r.book_title, rows: [r] });
      }
    }
    return Array.from(map.entries()).map(([key, v]) => ({
      key,
      label: v.title,
      rows: v.rows,
    }));
  }

  if (groupBy === 'target_kind') {
    const map = new Map<string, CommentRowSerialized[]>();
    for (const r of rows) {
      const existing = map.get(r.target_kind);
      if (existing) {
        existing.push(r);
      } else {
        map.set(r.target_kind, [r]);
      }
    }
    return TARGET_KIND_ORDER
      .filter((k) => map.has(k))
      .map((k) => ({
        key: k,
        label: TARGET_KIND_LABELS[k],
        rows: map.get(k)!,
      }));
  }

  // groupBy === 'priority'
  const map = new Map<string, CommentRowSerialized[]>();
  for (const r of rows) {
    const existing = map.get(r.priority);
    if (existing) {
      existing.push(r);
    } else {
      map.set(r.priority, [r]);
    }
  }
  return PRIORITY_ORDER
    .filter((k) => map.has(k))
    .map((k) => ({
      key: k,
      label: PRIORITY_LABELS[k],
      rows: map.get(k)!,
    }));
}

// ---------------------------------------------------------------------------
// Filtering (extended with book_id)
// ---------------------------------------------------------------------------

export interface CommentsPageFilter {
  status?: CommentStatus;
  priority?: CommentPriority;
  target_kind?: TargetKind;
  book_id?: string;
}

export function filterCommentsPage(
  rows: readonly CommentRowSerialized[],
  filter: CommentsPageFilter,
): CommentRowSerialized[] {
  return rows.filter((r) => {
    if (filter.status && r.status !== filter.status) return false;
    if (filter.priority && r.priority !== filter.priority) return false;
    if (filter.target_kind && r.target_kind !== filter.target_kind) return false;
    if (filter.book_id && r.book_id !== filter.book_id) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Extract unique books for filter dropdown
// ---------------------------------------------------------------------------

export function extractBookOptions(rows: readonly CommentRowSerialized[]): BookOption[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (!seen.has(r.book_id)) {
      seen.set(r.book_id, r.book_title);
    }
  }
  return Array.from(seen.entries()).map(([id, title]) => ({ id, title }));
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatCostJpy(cost: number): string {
  return `${cost.toLocaleString('ja-JP')}`;
}

export function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    // JST 固定表示 (サーバ=UTC でも 9 時間ズレないように)。
    return formatJstDateTime(d);
  } catch {
    return iso;
  }
}
