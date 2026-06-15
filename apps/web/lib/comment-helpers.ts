/**
 * Pure helper functions for comment UI (T-06-02).
 *
 * Sorting, filtering, priority label mapping, count aggregation.
 * No side effects — fully testable with Vitest.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommentPriority = 'must' | 'should' | 'may';
export type CommentStatus = 'pending' | 'applied' | 'not_applicable' | 'superseded';
export type TargetKind = 'chapter' | 'outline' | 'cover' | 'cover_text' | 'metadata' | 'theme';

export interface CommentSummary {
  id: string;
  book_id: string;
  target_kind: TargetKind;
  target_id: string;
  body: string;
  priority: CommentPriority;
  status: CommentStatus;
  created_at: string;
  applied_at: string | null;
}

export interface CommentCounts {
  total: number;
  pending: number;
  must: number;
  should: number;
  may: number;
  applied: number;
  not_applicable: number;
}

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<CommentPriority, number> = {
  must: 0,
  should: 1,
  may: 2,
};

/**
 * Sort comments by priority (must first), then by created_at descending.
 */
export function sortComments<T extends Pick<CommentSummary, 'priority' | 'created_at'>>(
  comments: T[],
): T[] {
  return [...comments].sort((a, b) => {
    const pDiff =
      PRIORITY_ORDER[a.priority as CommentPriority] -
      PRIORITY_ORDER[b.priority as CommentPriority];
    if (pDiff !== 0) return pDiff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface CommentFilter {
  status?: CommentStatus;
  priority?: CommentPriority;
  target_kind?: TargetKind;
}

export function filterComments<T extends Pick<CommentSummary, 'status' | 'priority' | 'target_kind'>>(
  comments: T[],
  filter: CommentFilter,
): T[] {
  return comments.filter((c) => {
    if (filter.status && c.status !== filter.status) return false;
    if (filter.priority && c.priority !== filter.priority) return false;
    if (filter.target_kind && c.target_kind !== filter.target_kind) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Priority label / variant mapping
// ---------------------------------------------------------------------------

export function priorityToVariant(priority: CommentPriority): 'must' | 'should' | 'may' {
  return priority;
}

const TARGET_KIND_LABELS: Record<TargetKind, string> = {
  chapter: '章本文',
  outline: 'アウトライン',
  cover: 'カバー画像',
  cover_text: 'カバーテキスト',
  metadata: 'メタデータ',
  theme: 'テーマ',
};

export function targetKindLabel(kind: TargetKind): string {
  return TARGET_KIND_LABELS[kind] ?? kind;
}

// ---------------------------------------------------------------------------
// Count aggregation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Paragraph anchor helpers (T-06-03)
// ---------------------------------------------------------------------------

/**
 * Extract the first element of `range_json.paragraph_range` tuple `[start, end]`.
 * Returns null when the comment has no paragraph anchor.
 */
export function getParagraphIndex(
  rangeJson: Record<string, unknown> | null | undefined,
): number | null {
  if (!rangeJson) return null;
  const pr = rangeJson.paragraph_range;
  if (Array.isArray(pr) && typeof pr[0] === 'number') return pr[0];
  return null;
}

/**
 * Group comments by paragraph index for a specific chapter.
 */
export function groupCommentsByParagraph<
  T extends { target_id: string; range_json: Record<string, unknown> | null },
>(
  comments: T[],
  chapterId: string,
): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const c of comments) {
    if (c.target_id !== chapterId) continue;
    const idx = getParagraphIndex(c.range_json);
    if (idx === null) continue;
    const existing = map.get(idx);
    if (existing) {
      existing.push(c);
    } else {
      map.set(idx, [c]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Image region helpers (T-06-04)
// ---------------------------------------------------------------------------

export interface ImageRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

const IMAGE_REGION_SIZE = 0.2;

/**
 * Convert a click position (relative to image element) to an image_region
 * centered on the click point. Phase 1 simple approach: 20% region around click.
 *
 * @param clickX - click X relative to element left edge (px)
 * @param clickY - click Y relative to element top edge (px)
 * @param elementWidth - element width (px)
 * @param elementHeight - element height (px)
 * @returns image_region with values clamped to 0.0-1.0
 */
export function clickToImageRegion(
  clickX: number,
  clickY: number,
  elementWidth: number,
  elementHeight: number,
): ImageRegion {
  if (elementWidth <= 0 || elementHeight <= 0) {
    return { x: 0, y: 0, w: IMAGE_REGION_SIZE, h: IMAGE_REGION_SIZE };
  }

  const relX = clickX / elementWidth;
  const relY = clickY / elementHeight;

  const halfW = IMAGE_REGION_SIZE / 2;
  const halfH = IMAGE_REGION_SIZE / 2;

  let x = relX - halfW;
  let y = relY - halfH;

  x = Math.max(0, Math.min(x, 1 - IMAGE_REGION_SIZE));
  y = Math.max(0, Math.min(y, 1 - IMAGE_REGION_SIZE));

  return {
    x: Math.round(x * 1000) / 1000,
    y: Math.round(y * 1000) / 1000,
    w: IMAGE_REGION_SIZE,
    h: IMAGE_REGION_SIZE,
  };
}

/**
 * Validate that an image_region has all values in 0.0-1.0 range
 * and x+w <= 1, y+h <= 1.
 */
export function validateImageRegion(region: unknown): region is ImageRegion {
  if (!region || typeof region !== 'object') return false;
  const r = region as Record<string, unknown>;
  if (typeof r.x !== 'number' || typeof r.y !== 'number' ||
      typeof r.w !== 'number' || typeof r.h !== 'number') return false;
  if (r.x < 0 || r.x > 1 || r.y < 0 || r.y > 1) return false;
  if (r.w <= 0 || r.w > 1 || r.h <= 0 || r.h > 1) return false;
  if (r.x + r.w > 1.001 || r.y + r.h > 1.001) return false;
  return true;
}

/**
 * Extract image_region from a range_json object, if present and valid.
 */
export function getImageRegion(
  rangeJson: Record<string, unknown> | null | undefined,
): ImageRegion | null {
  if (!rangeJson) return null;
  const ir = rangeJson.image_region;
  if (validateImageRegion(ir)) return ir;
  return null;
}

// ---------------------------------------------------------------------------
// Count aggregation
// ---------------------------------------------------------------------------

export function aggregateCounts<
  T extends Pick<CommentSummary, 'priority' | 'status'>,
>(comments: T[]): CommentCounts {
  const counts: CommentCounts = {
    total: comments.length,
    pending: 0,
    must: 0,
    should: 0,
    may: 0,
    applied: 0,
    not_applicable: 0,
  };

  for (const c of comments) {
    if (c.status === 'pending') {
      counts.pending++;
      if (c.priority === 'must') counts.must++;
      else if (c.priority === 'should') counts.should++;
      else if (c.priority === 'may') counts.may++;
    } else if (c.status === 'applied') {
      counts.applied++;
    } else if (c.status === 'not_applicable') {
      counts.not_applicable++;
    }
  }

  return counts;
}
