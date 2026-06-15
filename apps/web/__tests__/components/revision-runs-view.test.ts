/**
 * Vitest tests for revision-runs-view.ts (T-06-09).
 *
 * Tests:
 *   - normalizeRunStatus: valid / fallback
 *   - computeRunProgress: counts + percentage
 *   - computeBookProgress: per-book grouping
 *   - buildChapterDiffs: diff extraction from revisions
 *   - formatRunStatus / runStatusVariant: label + badge variant mapping
 *   - formatDateTime / formatElapsedTime / formatCostJpy / formatTokenCount
 *   - parseStringArray / parseResultSummary edge cases (via serializeRevisionRun)
 */
import { describe, it, expect } from 'vitest';

import {
  normalizeRunStatus,
  computeRunProgress,
  computeBookProgress,
  buildChapterDiffs,
  formatRunStatus,
  runStatusVariant,
  formatDateTime,
  formatElapsedTime,
  serializeRevisionRun,
  type RunCommentSerialized,
  type RunBookSerialized,
} from '../../lib/revision-runs-view';
import { formatCostJpy, formatTokenCount } from '../../lib/cost-view';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeComment(
  overrides: Partial<RunCommentSerialized> & { id: string },
): RunCommentSerialized {
  return {
    book_id: 'book-1',
    book_title: 'Test Book',
    target_kind: 'chapter',
    target_id: 'ch-1',
    body: 'Fix the intro',
    priority: 'should',
    status: 'pending',
    application_result_json: null,
    created_at: '2026-05-01T09:00:00.000Z',
    applied_at: null,
    ...overrides,
  };
}

function makeBook(id: string, title: string): RunBookSerialized {
  return { id, title };
}

// ---------------------------------------------------------------------------
// normalizeRunStatus
// ---------------------------------------------------------------------------

describe('normalizeRunStatus', () => {
  it('returns known status as-is', () => {
    expect(normalizeRunStatus('queued')).toBe('queued');
    expect(normalizeRunStatus('running')).toBe('running');
    expect(normalizeRunStatus('done')).toBe('done');
    expect(normalizeRunStatus('failed')).toBe('failed');
    expect(normalizeRunStatus('partial')).toBe('partial');
  });

  it('falls back to queued for unknown status', () => {
    expect(normalizeRunStatus('unknown')).toBe('queued');
    expect(normalizeRunStatus('')).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// computeRunProgress
// ---------------------------------------------------------------------------

describe('computeRunProgress', () => {
  it('computes progress from mixed comment statuses', () => {
    const comments = [
      makeComment({ id: 'c1', status: 'applied' }),
      makeComment({ id: 'c2', status: 'applied' }),
      makeComment({ id: 'c3', status: 'not_applicable' }),
      makeComment({ id: 'c4', status: 'pending' }),
    ];

    const result = computeRunProgress(comments);
    expect(result.total).toBe(4);
    expect(result.applied).toBe(2);
    expect(result.not_applicable).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.percent).toBe(75);
  });

  it('returns 0% for empty array', () => {
    const result = computeRunProgress([]);
    expect(result.total).toBe(0);
    expect(result.percent).toBe(0);
  });

  it('returns 100% when all applied', () => {
    const comments = [
      makeComment({ id: 'c1', status: 'applied' }),
      makeComment({ id: 'c2', status: 'applied' }),
    ];

    const result = computeRunProgress(comments);
    expect(result.percent).toBe(100);
    expect(result.pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeBookProgress
// ---------------------------------------------------------------------------

describe('computeBookProgress', () => {
  it('groups comments by book and computes per-book progress', () => {
    const comments = [
      makeComment({ id: 'c1', book_id: 'book-1', book_title: 'Book A', status: 'applied' }),
      makeComment({ id: 'c2', book_id: 'book-1', book_title: 'Book A', status: 'pending' }),
      makeComment({ id: 'c3', book_id: 'book-2', book_title: 'Book B', status: 'applied' }),
    ];
    const books = [makeBook('book-1', 'Book A'), makeBook('book-2', 'Book B')];

    const result = computeBookProgress(comments, books);
    expect(result).toHaveLength(2);

    const bookA = result.find((b) => b.book_id === 'book-1')!;
    expect(bookA.total).toBe(2);
    expect(bookA.applied).toBe(1);
    expect(bookA.pending).toBe(1);
    expect(bookA.percent).toBe(50);

    const bookB = result.find((b) => b.book_id === 'book-2')!;
    expect(bookB.total).toBe(1);
    expect(bookB.applied).toBe(1);
    expect(bookB.percent).toBe(100);
  });

  it('returns empty array for no comments', () => {
    const result = computeBookProgress([], []);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildChapterDiffs
// ---------------------------------------------------------------------------

describe('buildChapterDiffs', () => {
  it('builds diffs when revision differs from current', () => {
    const chapters = [
      { id: 'ch-1', index: 1, heading: 'Intro', body_md: 'New intro text' },
      { id: 'ch-2', index: 2, heading: 'Body', body_md: 'Same body text' },
    ];
    const revisions = [
      { chapter_id: 'ch-1', version: 1, body_md: 'Old intro text' },
      { chapter_id: 'ch-2', version: 1, body_md: 'Same body text' },
    ];

    const result = buildChapterDiffs(chapters, revisions);
    expect(result).toHaveLength(1);
    expect(result[0]!.chapter_id).toBe('ch-1');
    expect(result[0]!.old_body_md).toBe('Old intro text');
    expect(result[0]!.new_body_md).toBe('New intro text');
  });

  it('picks the highest version revision', () => {
    const chapters = [
      { id: 'ch-1', index: 1, heading: 'Intro', body_md: 'v3 text' },
    ];
    const revisions = [
      { chapter_id: 'ch-1', version: 1, body_md: 'v1 text' },
      { chapter_id: 'ch-1', version: 2, body_md: 'v2 text' },
    ];

    const result = buildChapterDiffs(chapters, revisions);
    expect(result).toHaveLength(1);
    expect(result[0]!.old_body_md).toBe('v2 text');
  });

  it('returns empty if no revisions match', () => {
    const chapters = [
      { id: 'ch-1', index: 1, heading: 'Intro', body_md: 'text' },
    ];

    const result = buildChapterDiffs(chapters, []);
    expect(result).toHaveLength(0);
  });

  it('sorts diffs by chapter_index', () => {
    const chapters = [
      { id: 'ch-3', index: 3, heading: 'Ch3', body_md: 'new3' },
      { id: 'ch-1', index: 1, heading: 'Ch1', body_md: 'new1' },
    ];
    const revisions = [
      { chapter_id: 'ch-3', version: 1, body_md: 'old3' },
      { chapter_id: 'ch-1', version: 1, body_md: 'old1' },
    ];

    const result = buildChapterDiffs(chapters, revisions);
    expect(result[0]!.chapter_index).toBe(1);
    expect(result[1]!.chapter_index).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// formatRunStatus / runStatusVariant
// ---------------------------------------------------------------------------

describe('formatRunStatus', () => {
  it('returns Japanese labels', () => {
    expect(formatRunStatus('done')).toBe('完了');
    expect(formatRunStatus('running')).toBe('実行中');
    expect(formatRunStatus('failed')).toBe('失敗');
    expect(formatRunStatus('partial')).toBe('一部失敗');
    expect(formatRunStatus('queued')).toBe('待機中');
  });
});

describe('runStatusVariant', () => {
  it('maps status to badge variant', () => {
    expect(runStatusVariant('done')).toBe('success');
    expect(runStatusVariant('failed')).toBe('must');
    expect(runStatusVariant('partial')).toBe('should');
    expect(runStatusVariant('queued')).toBe('neutral');
    expect(runStatusVariant('running')).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// formatDateTime
// ---------------------------------------------------------------------------

describe('formatDateTime', () => {
  it('formats ISO string to YYYY-MM-DD HH:mm', () => {
    const result = formatDateTime('2026-05-20T14:30:00.000Z');
    expect(result).toMatch(/2026-05-\d{2} \d{2}:\d{2}/);
  });

  it('returns input for invalid ISO', () => {
    expect(formatDateTime('invalid')).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// formatElapsedTime
// ---------------------------------------------------------------------------

describe('formatElapsedTime', () => {
  it('computes elapsed between start and end', () => {
    const start = '2026-05-20T10:00:00.000Z';
    const end = '2026-05-20T10:08:42.000Z';
    expect(formatElapsedTime(start, end)).toBe('08:42');
  });

  it('handles zero elapsed', () => {
    const same = '2026-05-20T10:00:00.000Z';
    expect(formatElapsedTime(same, same)).toBe('00:00');
  });
});

// ---------------------------------------------------------------------------
// formatCostJpy / formatTokenCount
// ---------------------------------------------------------------------------

describe('formatCostJpy', () => {
  it('formats number to yen string', () => {
    expect(formatCostJpy(320)).toBe('¥320');
    expect(formatCostJpy(1234.5)).toBe('¥1,235');
    expect(formatCostJpy(0)).toBe('¥0');
  });
});

describe('formatTokenCount', () => {
  it('formats tokens with k/M suffix', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });
});

// ---------------------------------------------------------------------------
// serializeRevisionRun
// ---------------------------------------------------------------------------

describe('serializeRevisionRun', () => {
  it('serializes a full run with defaults', () => {
    const rawRun = {
      id: 'run-1',
      triggered_at: new Date('2026-05-20T10:00:00Z'),
      started_at: new Date('2026-05-20T10:00:01Z'),
      finished_at: new Date('2026-05-20T10:08:42Z'),
      status: 'done',
      book_ids_json: ['book-1'],
      comment_ids_json: ['c-1', 'c-2'],
      result_summary_json: { applied: 1, not_applicable: 1, failed: 0, cost_jpy: 160 },
      error: null,
    };

    const rawComments = [
      {
        id: 'c-1',
        book_id: 'book-1',
        target_kind: 'chapter',
        target_id: 'ch-1',
        body: 'Fix intro',
        priority: 'must',
        status: 'applied',
        application_result_json: null,
        created_at: new Date('2026-05-20T10:00:00Z'),
        applied_at: new Date('2026-05-20T10:05:00Z'),
        book: { id: 'book-1', title: 'Book One' },
      },
    ];

    const result = serializeRevisionRun(
      rawRun,
      rawComments,
      [{ id: 'book-1', title: 'Book One' }],
      [],
      [],
      [],
    );

    expect(result.id).toBe('run-1');
    expect(result.status).toBe('done');
    expect(result.book_ids).toEqual(['book-1']);
    expect(result.comment_ids).toEqual(['c-1', 'c-2']);
    expect(result.result_summary.applied).toBe(1);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]!.status).toBe('applied');
    expect(result.triggered_at).toBe('2026-05-20T10:00:00.000Z');
  });

  it('handles null/undefined json fields gracefully', () => {
    const rawRun = {
      id: 'run-2',
      triggered_at: new Date('2026-05-20T10:00:00Z'),
      started_at: null,
      finished_at: null,
      status: 'queued',
      book_ids_json: null,
      comment_ids_json: undefined,
      result_summary_json: null,
      error: null,
    };

    const result = serializeRevisionRun(rawRun, [], [], [], [], []);

    expect(result.book_ids).toEqual([]);
    expect(result.comment_ids).toEqual([]);
    expect(result.result_summary).toEqual({
      applied: 0,
      not_applicable: 0,
      failed: 0,
      cost_jpy: 0,
    });
  });

  it('normalizes unknown comment statuses', () => {
    const rawRun = {
      id: 'run-3',
      triggered_at: new Date('2026-05-20T10:00:00Z'),
      started_at: null,
      finished_at: null,
      status: 'running',
      book_ids_json: [],
      comment_ids_json: [],
      result_summary_json: {},
      error: null,
    };

    const rawComments = [
      {
        id: 'c-1',
        book_id: 'book-1',
        target_kind: 'unknown_kind',
        target_id: 'x',
        body: 'test',
        priority: 'invalid',
        status: 'bogus',
        application_result_json: null,
        created_at: new Date('2026-05-20T10:00:00Z'),
        applied_at: null,
        book: { id: 'book-1', title: 'Book' },
      },
    ];

    const result = serializeRevisionRun(rawRun, rawComments, [], [], [], []);
    expect(result.comments[0]!.target_kind).toBe('chapter');
    expect(result.comments[0]!.priority).toBe('may');
    expect(result.comments[0]!.status).toBe('pending');
  });
});
