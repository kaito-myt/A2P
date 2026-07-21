/**
 * Vitest tests for comment-helpers (T-06-02).
 *
 * Tests:
 *   - sortComments: priority ordering + created_at tiebreak
 *   - filterComments: by status, priority, target_kind
 *   - priorityToVariant: maps priority to Badge variant
 *   - targetKindLabel: Japanese label mapping
 *   - aggregateCounts: count aggregation
 */
import { describe, it, expect } from 'vitest';

import {
  sortComments,
  filterComments,
  priorityToVariant,
  targetKindLabel,
  commentStatusLabel,
  commentStatusVariant,
  aggregateCounts,
  clickToImageRegion,
  validateImageRegion,
  getImageRegion,
  type CommentSummary,
  type CommentPriority,
  type CommentStatus,
  type TargetKind,
} from '@/lib/comment-helpers';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeComment(
  overrides: Partial<CommentSummary> & { id: string },
): CommentSummary {
  return {
    book_id: 'book-1',
    target_kind: 'chapter',
    target_id: 'ch-1',
    body: 'test body',
    priority: 'should',
    status: 'pending',
    created_at: '2026-05-01T09:00:00Z',
    applied_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sortComments
// ---------------------------------------------------------------------------

describe('sortComments', () => {
  it('sorts by priority order: must > should > may', () => {
    const comments = [
      makeComment({ id: '1', priority: 'may' }),
      makeComment({ id: '2', priority: 'must' }),
      makeComment({ id: '3', priority: 'should' }),
    ];
    const sorted = sortComments(comments);
    expect(sorted.map((c) => c.priority)).toEqual(['must', 'should', 'may']);
  });

  it('sorts by created_at descending within same priority', () => {
    const comments = [
      makeComment({ id: '1', priority: 'must', created_at: '2026-05-01T08:00:00Z' }),
      makeComment({ id: '2', priority: 'must', created_at: '2026-05-01T10:00:00Z' }),
      makeComment({ id: '3', priority: 'must', created_at: '2026-05-01T09:00:00Z' }),
    ];
    const sorted = sortComments(comments);
    expect(sorted.map((c) => c.id)).toEqual(['2', '3', '1']);
  });

  it('does not mutate the original array', () => {
    const comments = [
      makeComment({ id: '1', priority: 'may' }),
      makeComment({ id: '2', priority: 'must' }),
    ];
    const original = [...comments];
    sortComments(comments);
    expect(comments).toEqual(original);
  });

  it('handles empty array', () => {
    expect(sortComments([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterComments
// ---------------------------------------------------------------------------

describe('filterComments', () => {
  const comments = [
    makeComment({ id: '1', status: 'pending', priority: 'must', target_kind: 'chapter' }),
    makeComment({ id: '2', status: 'applied', priority: 'should', target_kind: 'cover' }),
    makeComment({ id: '3', status: 'pending', priority: 'may', target_kind: 'metadata' }),
    makeComment({ id: '4', status: 'not_applicable', priority: 'must', target_kind: 'chapter' }),
  ];

  it('filters by status', () => {
    const result = filterComments(comments, { status: 'pending' });
    expect(result.map((c) => c.id)).toEqual(['1', '3']);
  });

  it('filters by priority', () => {
    const result = filterComments(comments, { priority: 'must' });
    expect(result.map((c) => c.id)).toEqual(['1', '4']);
  });

  it('filters by target_kind', () => {
    const result = filterComments(comments, { target_kind: 'chapter' });
    expect(result.map((c) => c.id)).toEqual(['1', '4']);
  });

  it('combines multiple filters', () => {
    const result = filterComments(comments, { status: 'pending', priority: 'must' });
    expect(result.map((c) => c.id)).toEqual(['1']);
  });

  it('returns all when no filter specified', () => {
    const result = filterComments(comments, {});
    expect(result).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// priorityToVariant
// ---------------------------------------------------------------------------

describe('priorityToVariant', () => {
  it.each([
    ['must', 'must'],
    ['should', 'should'],
    ['may', 'may'],
  ] as [CommentPriority, string][])('maps %s to %s', (input, expected) => {
    expect(priorityToVariant(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// targetKindLabel
// ---------------------------------------------------------------------------

describe('targetKindLabel', () => {
  it.each([
    ['chapter', '章本文'],
    ['outline', 'アウトライン'],
    ['cover', 'カバー画像'],
    ['cover_text', 'カバーテキスト'],
    ['metadata', 'メタデータ'],
    ['theme', 'テーマ'],
  ] as [TargetKind, string][])('maps %s to %s', (input, expected) => {
    expect(targetKindLabel(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// commentStatusLabel / commentStatusVariant
// ---------------------------------------------------------------------------

describe('commentStatusLabel', () => {
  it.each([
    ['pending', '未消化'],
    ['applied', '適用済み'],
    ['not_applicable', '適用不可'],
    ['superseded', '削除済み'],
  ] as [CommentStatus, string][])('maps %s to %s', (input, expected) => {
    expect(commentStatusLabel(input)).toBe(expected);
  });

  it('falls back to the raw value for an unknown status', () => {
    expect(commentStatusLabel('mystery')).toBe('mystery');
  });
});

describe('commentStatusVariant', () => {
  it('各対応状況を区別できる variant にマップする', () => {
    expect(commentStatusVariant('pending')).toBe('neutral');
    expect(commentStatusVariant('applied')).toBe('success');
    expect(commentStatusVariant('not_applicable')).toBe('may');
    expect(commentStatusVariant('superseded')).toBe('must');
  });

  it('未知の値は neutral', () => {
    expect(commentStatusVariant('unknown' as CommentStatus)).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// aggregateCounts
// ---------------------------------------------------------------------------

describe('aggregateCounts', () => {
  it('aggregates counts correctly for mixed statuses', () => {
    const comments = [
      makeComment({ id: '1', status: 'pending', priority: 'must' }),
      makeComment({ id: '2', status: 'pending', priority: 'should' }),
      makeComment({ id: '3', status: 'pending', priority: 'may' }),
      makeComment({ id: '4', status: 'applied', priority: 'must' }),
      makeComment({ id: '5', status: 'not_applicable', priority: 'should' }),
      makeComment({ id: '6', status: 'superseded', priority: 'may' }),
    ];
    const counts = aggregateCounts(comments);
    expect(counts).toEqual({
      total: 6,
      pending: 3,
      must: 1,
      should: 1,
      may: 1,
      applied: 1,
      not_applicable: 1,
    });
  });

  it('handles empty array', () => {
    const counts = aggregateCounts([]);
    expect(counts).toEqual({
      total: 0,
      pending: 0,
      must: 0,
      should: 0,
      may: 0,
      applied: 0,
      not_applicable: 0,
    });
  });

  it('counts all-pending-must correctly', () => {
    const comments = [
      makeComment({ id: '1', status: 'pending', priority: 'must' }),
      makeComment({ id: '2', status: 'pending', priority: 'must' }),
    ];
    const counts = aggregateCounts(comments);
    expect(counts.pending).toBe(2);
    expect(counts.must).toBe(2);
    expect(counts.should).toBe(0);
    expect(counts.may).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// clickToImageRegion (T-06-04)
// ---------------------------------------------------------------------------

describe('clickToImageRegion', () => {
  it('returns a 20% region centered on the click point', () => {
    const region = clickToImageRegion(250, 250, 500, 500);
    expect(region.x).toBeCloseTo(0.4, 2);
    expect(region.y).toBeCloseTo(0.4, 2);
    expect(region.w).toBe(0.2);
    expect(region.h).toBe(0.2);
  });

  it('clamps to left/top edge when clicking near top-left corner', () => {
    const region = clickToImageRegion(10, 10, 500, 500);
    expect(region.x).toBe(0);
    expect(region.y).toBe(0);
    expect(region.w).toBe(0.2);
    expect(region.h).toBe(0.2);
  });

  it('clamps to right/bottom edge when clicking near bottom-right corner', () => {
    const region = clickToImageRegion(490, 490, 500, 500);
    expect(region.x).toBe(0.8);
    expect(region.y).toBe(0.8);
    expect(region.w).toBe(0.2);
    expect(region.h).toBe(0.2);
  });

  it('handles center click on non-square image', () => {
    const region = clickToImageRegion(150, 200, 300, 400);
    expect(region.x).toBeCloseTo(0.4, 2);
    expect(region.y).toBeCloseTo(0.4, 2);
    expect(region.w).toBe(0.2);
    expect(region.h).toBe(0.2);
  });

  it('handles zero element dimensions gracefully', () => {
    const region = clickToImageRegion(0, 0, 0, 0);
    expect(region.x).toBe(0);
    expect(region.y).toBe(0);
    expect(region.w).toBe(0.2);
    expect(region.h).toBe(0.2);
  });

  it('produces values in 0-1 range for any input', () => {
    const region = clickToImageRegion(999, 999, 100, 100);
    expect(region.x).toBeGreaterThanOrEqual(0);
    expect(region.x).toBeLessThanOrEqual(1);
    expect(region.y).toBeGreaterThanOrEqual(0);
    expect(region.y).toBeLessThanOrEqual(1);
    expect(region.x + region.w).toBeLessThanOrEqual(1.001);
    expect(region.y + region.h).toBeLessThanOrEqual(1.001);
  });
});

// ---------------------------------------------------------------------------
// validateImageRegion (T-06-04)
// ---------------------------------------------------------------------------

describe('validateImageRegion', () => {
  it('returns true for a valid region', () => {
    expect(validateImageRegion({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toBe(true);
  });

  it('returns true for edge values', () => {
    expect(validateImageRegion({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
  });

  it('returns false for null/undefined', () => {
    expect(validateImageRegion(null)).toBe(false);
    expect(validateImageRegion(undefined)).toBe(false);
  });

  it('returns false when missing fields', () => {
    expect(validateImageRegion({ x: 0.1, y: 0.2 })).toBe(false);
    expect(validateImageRegion({ x: 0.1, y: 0.2, w: 0.3 })).toBe(false);
  });

  it('returns false for negative values', () => {
    expect(validateImageRegion({ x: -0.1, y: 0.2, w: 0.3, h: 0.4 })).toBe(false);
  });

  it('returns false when x exceeds 1', () => {
    expect(validateImageRegion({ x: 1.1, y: 0, w: 0.2, h: 0.2 })).toBe(false);
  });

  it('returns false when w is zero', () => {
    expect(validateImageRegion({ x: 0.1, y: 0.2, w: 0, h: 0.4 })).toBe(false);
  });

  it('returns false when x + w exceeds 1', () => {
    expect(validateImageRegion({ x: 0.9, y: 0, w: 0.2, h: 0.2 })).toBe(false);
  });

  it('returns false for non-object input', () => {
    expect(validateImageRegion('string')).toBe(false);
    expect(validateImageRegion(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getImageRegion (T-06-04)
// ---------------------------------------------------------------------------

describe('getImageRegion', () => {
  it('extracts valid image_region from range_json', () => {
    const region = getImageRegion({ image_region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
    expect(region).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  it('returns null for null/undefined input', () => {
    expect(getImageRegion(null)).toBeNull();
    expect(getImageRegion(undefined)).toBeNull();
  });

  it('returns null when image_region is absent', () => {
    expect(getImageRegion({ paragraph_range: [0, 1] })).toBeNull();
  });

  it('returns null when image_region is invalid', () => {
    expect(getImageRegion({ image_region: { x: -1, y: 0, w: 0.2, h: 0.2 } })).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(getImageRegion({})).toBeNull();
  });
});
