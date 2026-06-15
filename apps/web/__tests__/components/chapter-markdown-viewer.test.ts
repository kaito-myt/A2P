/**
 * chapter-markdown-viewer helpers test (T-06-03).
 *
 * Tests:
 *   - getParagraphIndex: valid tuple, null range, missing fields
 *   - groupCommentsByParagraph: filters by chapterId, groups by paragraph index
 */
import { describe, it, expect } from 'vitest';

import {
  getParagraphIndex,
  groupCommentsByParagraph,
} from '@/lib/comment-helpers';

// ---------------------------------------------------------------------------
// getParagraphIndex
// ---------------------------------------------------------------------------

describe('getParagraphIndex', () => {
  it('extracts first element from valid tuple [3, 5]', () => {
    expect(getParagraphIndex({ paragraph_range: [3, 5] })).toBe(3);
  });

  it('extracts 0 from tuple [0, 0]', () => {
    expect(getParagraphIndex({ paragraph_range: [0, 0] })).toBe(0);
  });

  it('returns null for null range_json', () => {
    expect(getParagraphIndex(null)).toBeNull();
  });

  it('returns null for undefined range_json', () => {
    expect(getParagraphIndex(undefined)).toBeNull();
  });

  it('returns null when paragraph_range is missing', () => {
    expect(getParagraphIndex({})).toBeNull();
    expect(getParagraphIndex({ line_range: [1, 2] })).toBeNull();
  });

  it('returns null when paragraph_range is not an array', () => {
    expect(getParagraphIndex({ paragraph_range: 'bad' })).toBeNull();
    expect(getParagraphIndex({ paragraph_range: { start: 3, end: 5 } })).toBeNull();
  });

  it('returns null when paragraph_range array has non-number first element', () => {
    expect(getParagraphIndex({ paragraph_range: ['a', 'b'] })).toBeNull();
  });

  it('handles single-element array', () => {
    expect(getParagraphIndex({ paragraph_range: [7] })).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// groupCommentsByParagraph
// ---------------------------------------------------------------------------

describe('groupCommentsByParagraph', () => {
  function makeComment(id: string, targetId: string, paragraphRange: unknown) {
    return {
      id,
      target_id: targetId,
      range_json: paragraphRange ? { paragraph_range: paragraphRange } : null,
      body: 'test',
      priority: 'should' as const,
      status: 'pending' as const,
      created_at: '2026-05-01T09:00:00Z',
    };
  }

  it('groups comments by paragraph index for matching chapterId', () => {
    const comments = [
      makeComment('c1', 'ch-1', [0, 0]),
      makeComment('c2', 'ch-1', [0, 0]),
      makeComment('c3', 'ch-1', [2, 2]),
    ];
    const map = groupCommentsByParagraph(comments, 'ch-1');
    expect(map.size).toBe(2);
    expect(map.get(0)).toHaveLength(2);
    expect(map.get(0)!.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(map.get(2)).toHaveLength(1);
    expect(map.get(2)![0]!.id).toBe('c3');
  });

  it('filters out comments for different chapters', () => {
    const comments = [
      makeComment('c1', 'ch-1', [0, 0]),
      makeComment('c2', 'ch-2', [0, 0]),
      makeComment('c3', 'ch-1', [1, 1]),
    ];
    const map = groupCommentsByParagraph(comments, 'ch-1');
    expect(map.size).toBe(2);
    expect(map.has(0)).toBe(true);
    expect(map.has(1)).toBe(true);
  });

  it('skips comments with null range_json', () => {
    const comments = [makeComment('c1', 'ch-1', null)];
    const map = groupCommentsByParagraph(comments, 'ch-1');
    expect(map.size).toBe(0);
  });

  it('returns empty map for empty comments array', () => {
    const map = groupCommentsByParagraph([], 'ch-1');
    expect(map.size).toBe(0);
  });

  it('skips comments without paragraph_range key', () => {
    const comments = [
      {
        id: 'c1',
        target_id: 'ch-1',
        range_json: { line_range: [1, 5] },
        body: 'test',
        priority: 'should' as const,
        status: 'pending' as const,
        created_at: '2026-05-01T09:00:00Z',
      },
    ];
    const map = groupCommentsByParagraph(comments, 'ch-1');
    expect(map.size).toBe(0);
  });
});
