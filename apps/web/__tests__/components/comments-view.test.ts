/**
 * Vitest tests for comments-view.ts (T-06-06).
 *
 * Tests:
 *   - serializeCommentRow: Date -> ISO, fallback for unknown enums
 *   - computeKpi: pending / must / affectedBooks / estimatedCost
 *   - groupComments: by book / target_kind / priority
 *   - filterCommentsPage: all filter dimensions
 *   - extractBookOptions: unique book list
 *   - formatDateTime: ISO -> "YYYY-MM-DD HH:mm"
 *   - formatCostJpy: cost formatting
 */
import { describe, it, expect } from 'vitest';

import {
  serializeCommentRow,
  computeKpi,
  groupComments,
  filterCommentsPage,
  extractBookOptions,
  formatDateTime,
  formatCostJpy,
  type CommentRowSerialized,
} from '../../lib/comments-view';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<CommentRowSerialized> & { id: string }): CommentRowSerialized {
  return {
    book_id: 'book-1',
    book_title: 'Test Book',
    target_kind: 'chapter',
    target_id: 'ch-1',
    range_json: null,
    body: 'test comment',
    priority: 'should',
    status: 'pending',
    created_at: '2026-05-01T09:00:00.000Z',
    applied_at: null,
    ...overrides,
  };
}

function makeRawRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    book_id: 'book-1',
    target_kind: 'chapter',
    target_id: 'ch-1',
    range_json: null,
    body: 'test',
    priority: 'must',
    status: 'pending',
    created_at: new Date('2026-05-01T09:00:00Z'),
    applied_at: null,
    book: { id: 'book-1', title: 'Book One' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// serializeCommentRow
// ---------------------------------------------------------------------------

describe('serializeCommentRow', () => {
  it('serializes dates to ISO strings', () => {
    const row = serializeCommentRow(makeRawRow({
      applied_at: new Date('2026-05-02T10:00:00Z'),
    }));
    expect(row.created_at).toBe('2026-05-01T09:00:00.000Z');
    expect(row.applied_at).toBe('2026-05-02T10:00:00.000Z');
  });

  it('handles null applied_at', () => {
    const row = serializeCommentRow(makeRawRow());
    expect(row.applied_at).toBeNull();
  });

  it('falls back unknown target_kind to chapter', () => {
    const row = serializeCommentRow(makeRawRow({ target_kind: 'unknown_kind' }));
    expect(row.target_kind).toBe('chapter');
  });

  it('falls back unknown priority to may', () => {
    const row = serializeCommentRow(makeRawRow({ priority: 'critical' }));
    expect(row.priority).toBe('may');
  });

  it('falls back unknown status to pending', () => {
    const row = serializeCommentRow(makeRawRow({ status: 'unknown_status' }));
    expect(row.status).toBe('pending');
  });

  it('passes through valid range_json object', () => {
    const range = { paragraph_range: [1, 3] };
    const row = serializeCommentRow(makeRawRow({ range_json: range }));
    expect(row.range_json).toEqual(range);
  });

  it('normalizes array range_json to null', () => {
    const row = serializeCommentRow(makeRawRow({ range_json: [1, 2, 3] }));
    expect(row.range_json).toBeNull();
  });

  it('preserves book title from join', () => {
    const row = serializeCommentRow(makeRawRow({
      book: { id: 'b-x', title: 'Custom Title' },
    }));
    expect(row.book_title).toBe('Custom Title');
    expect(row.book_id).toBe('book-1');
  });
});

// ---------------------------------------------------------------------------
// computeKpi
// ---------------------------------------------------------------------------

describe('computeKpi', () => {
  it('counts pending, must, affected books, and estimates cost', () => {
    const rows = [
      makeRow({ id: '1', status: 'pending', priority: 'must', book_id: 'b1' }),
      makeRow({ id: '2', status: 'pending', priority: 'should', book_id: 'b1' }),
      makeRow({ id: '3', status: 'pending', priority: 'may', book_id: 'b2' }),
      makeRow({ id: '4', status: 'applied', priority: 'must', book_id: 'b3' }),
    ];
    const kpi = computeKpi(rows);
    expect(kpi.pending).toBe(3);
    expect(kpi.must).toBe(1);
    expect(kpi.affectedBooks).toBe(2);
    expect(kpi.estimatedCostJpy).toBe(150); // 3 * 50
  });

  it('returns zeros for empty array', () => {
    const kpi = computeKpi([]);
    expect(kpi.pending).toBe(0);
    expect(kpi.must).toBe(0);
    expect(kpi.affectedBooks).toBe(0);
    expect(kpi.estimatedCostJpy).toBe(0);
  });

  it('excludes applied/not_applicable from pending count', () => {
    const rows = [
      makeRow({ id: '1', status: 'applied' }),
      makeRow({ id: '2', status: 'not_applicable' }),
    ];
    const kpi = computeKpi(rows);
    expect(kpi.pending).toBe(0);
    expect(kpi.estimatedCostJpy).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// groupComments
// ---------------------------------------------------------------------------

describe('groupComments', () => {
  const rows = [
    makeRow({ id: '1', book_id: 'b1', book_title: 'Book A', target_kind: 'chapter', priority: 'must' }),
    makeRow({ id: '2', book_id: 'b1', book_title: 'Book A', target_kind: 'cover', priority: 'should' }),
    makeRow({ id: '3', book_id: 'b2', book_title: 'Book B', target_kind: 'chapter', priority: 'may' }),
    makeRow({ id: '4', book_id: 'b2', book_title: 'Book B', target_kind: 'metadata', priority: 'must' }),
  ];

  it('groups by book', () => {
    const groups = groupComments(rows, 'book');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.label).toBe('Book A');
    expect(groups[0]!.rows).toHaveLength(2);
    expect(groups[1]!.label).toBe('Book B');
    expect(groups[1]!.rows).toHaveLength(2);
  });

  it('groups by target_kind in defined order', () => {
    const groups = groupComments(rows, 'target_kind');
    expect(groups.map((g) => g.key)).toEqual(['chapter', 'cover', 'metadata']);
    expect(groups[0]!.rows).toHaveLength(2);
    expect(groups[1]!.rows).toHaveLength(1);
    expect(groups[2]!.rows).toHaveLength(1);
  });

  it('groups by priority in must > should > may order', () => {
    const groups = groupComments(rows, 'priority');
    expect(groups.map((g) => g.key)).toEqual(['must', 'should', 'may']);
    expect(groups[0]!.rows).toHaveLength(2);
    expect(groups[1]!.rows).toHaveLength(1);
    expect(groups[2]!.rows).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(groupComments([], 'book')).toEqual([]);
    expect(groupComments([], 'target_kind')).toEqual([]);
    expect(groupComments([], 'priority')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterCommentsPage
// ---------------------------------------------------------------------------

describe('filterCommentsPage', () => {
  const rows = [
    makeRow({ id: '1', status: 'pending', priority: 'must', target_kind: 'chapter', book_id: 'b1' }),
    makeRow({ id: '2', status: 'applied', priority: 'should', target_kind: 'cover', book_id: 'b1' }),
    makeRow({ id: '3', status: 'pending', priority: 'may', target_kind: 'metadata', book_id: 'b2' }),
    makeRow({ id: '4', status: 'not_applicable', priority: 'must', target_kind: 'chapter', book_id: 'b2' }),
  ];

  it('filters by status', () => {
    const result = filterCommentsPage(rows, { status: 'pending' });
    expect(result.map((r) => r.id)).toEqual(['1', '3']);
  });

  it('filters by priority', () => {
    const result = filterCommentsPage(rows, { priority: 'must' });
    expect(result.map((r) => r.id)).toEqual(['1', '4']);
  });

  it('filters by target_kind', () => {
    const result = filterCommentsPage(rows, { target_kind: 'chapter' });
    expect(result.map((r) => r.id)).toEqual(['1', '4']);
  });

  it('filters by book_id', () => {
    const result = filterCommentsPage(rows, { book_id: 'b2' });
    expect(result.map((r) => r.id)).toEqual(['3', '4']);
  });

  it('combines multiple filters', () => {
    const result = filterCommentsPage(rows, { status: 'pending', book_id: 'b1' });
    expect(result.map((r) => r.id)).toEqual(['1']);
  });

  it('returns all when no filter specified', () => {
    const result = filterCommentsPage(rows, {});
    expect(result).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// extractBookOptions
// ---------------------------------------------------------------------------

describe('extractBookOptions', () => {
  it('extracts unique book options', () => {
    const rows = [
      makeRow({ id: '1', book_id: 'b1', book_title: 'Book A' }),
      makeRow({ id: '2', book_id: 'b1', book_title: 'Book A' }),
      makeRow({ id: '3', book_id: 'b2', book_title: 'Book B' }),
    ];
    const options = extractBookOptions(rows);
    expect(options).toEqual([
      { id: 'b1', title: 'Book A' },
      { id: 'b2', title: 'Book B' },
    ]);
  });

  it('returns empty array for no rows', () => {
    expect(extractBookOptions([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatDateTime
// ---------------------------------------------------------------------------

describe('formatDateTime', () => {
  it('formats ISO to YYYY-MM-DD HH:mm', () => {
    const result = formatDateTime('2026-05-01T09:30:00.000Z');
    expect(result).toMatch(/2026-05-01/);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it('returns original string for invalid date', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// formatCostJpy
// ---------------------------------------------------------------------------

describe('formatCostJpy', () => {
  it('formats cost with locale separators', () => {
    const result = formatCostJpy(1500);
    expect(result).toContain('1');
    expect(result).toContain('500');
  });

  it('handles zero', () => {
    expect(formatCostJpy(0)).toBe('0');
  });
});
