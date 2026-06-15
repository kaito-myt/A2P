/**
 * books-view.ts のユニットテスト (T-04-09).
 *
 * 検証:
 *  - normalizeBookStatus / normalizeCostStatus / normalizeOutlineStatus / normalizeJobStatus
 *  - parseOutlineChapters: defensive parse
 *  - serializeBookDetail: Date/Decimal/Json 正規化 + outline/chapters/jobs sort
 *  - formatBookStatus / formatCostStatus / formatGenre / formatDateTime
 *  - costThresholdPercent
 *  - formatJobKind
 */
import { describe, expect, it } from 'vitest';

import {
  normalizeBookStatus,
  normalizeCostStatus,
  normalizeOutlineStatus,
  normalizeJobStatus,
  parseOutlineChapters,
  serializeBookDetail,
  formatBookStatus,
  formatCostStatus,
  formatGenre,
  formatDateTime,
  costThresholdPercent,
  formatJobKind,
  COST_THRESHOLD_WARN,
  COST_THRESHOLD_PAUSE,
} from '../../lib/books-view';

// ---------------------------------------------------------------------------
// normalizeBookStatus
// ---------------------------------------------------------------------------
describe('normalizeBookStatus', () => {
  it.each([
    'queued', 'running', 'editing', 'judging', 'thumbnail',
    'exporting', 'done', 'needs_human_review', 'failed', 'cancelled', 'paused_cost',
  ] as const)('known status "%s" is returned as-is', (s) => {
    expect(normalizeBookStatus(s)).toBe(s);
  });

  it('unknown status falls back to "queued"', () => {
    expect(normalizeBookStatus('bogus')).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// normalizeCostStatus
// ---------------------------------------------------------------------------
describe('normalizeCostStatus', () => {
  it.each(['normal', 'warn', 'paused', 'exceeded'] as const)(
    'known "%s" is returned as-is',
    (s) => {
      expect(normalizeCostStatus(s)).toBe(s);
    },
  );

  it('unknown → "normal"', () => {
    expect(normalizeCostStatus('???')).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// normalizeOutlineStatus
// ---------------------------------------------------------------------------
describe('normalizeOutlineStatus', () => {
  it.each(['draft', 'pending_review', 'approved', 'rejected'] as const)(
    '"%s" is returned as-is',
    (s) => {
      expect(normalizeOutlineStatus(s)).toBe(s);
    },
  );

  it('unknown → "draft"', () => {
    expect(normalizeOutlineStatus('foo')).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// normalizeJobStatus
// ---------------------------------------------------------------------------
describe('normalizeJobStatus', () => {
  it.each(['queued', 'running', 'done', 'failed', 'cancelled'] as const)(
    '"%s" is returned as-is',
    (s) => {
      expect(normalizeJobStatus(s)).toBe(s);
    },
  );

  it('unknown → "queued"', () => {
    expect(normalizeJobStatus('unknown')).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// parseOutlineChapters
// ---------------------------------------------------------------------------
describe('parseOutlineChapters', () => {
  it('non-array returns empty', () => {
    expect(parseOutlineChapters(null)).toEqual([]);
    expect(parseOutlineChapters(undefined)).toEqual([]);
    expect(parseOutlineChapters('string')).toEqual([]);
    expect(parseOutlineChapters(42)).toEqual([]);
  });

  it('broken elements are skipped (heading required)', () => {
    const result = parseOutlineChapters([
      { heading: 'Valid', target_chars: 5000 },
      { no_heading: true },
      { heading: 'Also Valid' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.heading).toBe('Valid');
    expect(result[1]?.heading).toBe('Also Valid');
  });

  it('optional fields are preserved when present', () => {
    const result = parseOutlineChapters([
      {
        index: 1,
        heading: 'Ch1',
        summary: 'Summary',
        target_chars: 5000,
        subheadings: ['A', 'B'],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      index: 1,
      heading: 'Ch1',
      summary: 'Summary',
      target_chars: 5000,
      subheadings: ['A', 'B'],
    });
  });
});

// ---------------------------------------------------------------------------
// serializeBookDetail
// ---------------------------------------------------------------------------
describe('serializeBookDetail', () => {
  function makeRawBook(overrides: Partial<{
    id: string;
    status: string;
    cost_status: string;
    cost_jpy_total: number;
    outline: unknown;
    chapters: unknown[];
    jobs: unknown[];
    theme: unknown;
    done_at: Date | null;
  }> = {}) {
    return {
      id: overrides.id ?? 'book_1',
      title: 'Test Book',
      subtitle: 'Subtitle',
      asin: null,
      status: overrides.status ?? 'queued',
      cost_status: overrides.cost_status ?? 'normal',
      cost_jpy_total: overrides.cost_jpy_total ?? 123.45,
      has_pending_comments: false,
      has_blocking_comments: false,
      created_at: new Date('2026-05-25T00:00:00.000Z'),
      updated_at: new Date('2026-05-25T01:00:00.000Z'),
      done_at: overrides.done_at ?? null,
      prompt_version_ids_json: {},
      model_assignment_snapshot: {},
      account_id: 'acc_1',
      theme_id: 'theme_1',
      account: { id: 'acc_1', pen_name: 'TestPen' },
      theme: overrides.theme !== undefined ? overrides.theme : { genre: 'business' },
      outline: overrides.outline !== undefined ? overrides.outline : null,
      chapters: (overrides.chapters as never[]) ?? [],
      jobs: (overrides.jobs as never[]) ?? [],
    };
  }

  it('serializes Date fields to ISO strings', () => {
    const result = serializeBookDetail(makeRawBook() as never);
    expect(result.created_at).toBe('2026-05-25T00:00:00.000Z');
    expect(result.updated_at).toBe('2026-05-25T01:00:00.000Z');
    expect(result.done_at).toBeNull();
  });

  it('serializes done_at when present', () => {
    const result = serializeBookDetail(
      makeRawBook({ done_at: new Date('2026-05-25T05:00:00.000Z') }) as never,
    );
    expect(result.done_at).toBe('2026-05-25T05:00:00.000Z');
  });

  it('normalizes cost_jpy_total to number', () => {
    const result = serializeBookDetail(makeRawBook({ cost_jpy_total: 432.55 }) as never);
    expect(result.cost_jpy_total).toBe(432.55);
  });

  it('extracts genre from theme', () => {
    const result = serializeBookDetail(makeRawBook({ theme: { genre: 'self_help' } }) as never);
    expect(result.genre).toBe('self_help');
  });

  it('genre is null when theme is null', () => {
    const result = serializeBookDetail(makeRawBook({ theme: null }) as never);
    expect(result.genre).toBeNull();
  });

  it('sorts chapters by index ASC', () => {
    const result = serializeBookDetail(
      makeRawBook({
        chapters: [
          { id: 'c3', index: 3, heading: 'Ch3', body_md: '# Ch3', status: 'done', char_count: 3000, version: 1, updated_at: new Date() },
          { id: 'c1', index: 1, heading: 'Ch1', body_md: '# Ch1', status: 'done', char_count: 5000, version: 1, updated_at: new Date() },
          { id: 'c2', index: 2, heading: 'Ch2', body_md: '# Ch2', status: 'draft', char_count: 4000, version: 1, updated_at: new Date() },
        ],
      }) as never,
    );
    expect(result.chapters.map((c) => c.index)).toEqual([1, 2, 3]);
  });

  it('sorts jobs by created_at DESC', () => {
    const result = serializeBookDetail(
      makeRawBook({
        jobs: [
          { id: 'j1', kind: 'pipeline.book.kickoff', status: 'done', started_at: null, finished_at: null, created_at: new Date('2026-05-25T01:00:00Z'), error: null, retries: 0 },
          { id: 'j3', kind: 'pipeline.book.editor', status: 'running', started_at: null, finished_at: null, created_at: new Date('2026-05-25T03:00:00Z'), error: null, retries: 0 },
          { id: 'j2', kind: 'pipeline.book.marketer', status: 'done', started_at: null, finished_at: null, created_at: new Date('2026-05-25T02:00:00Z'), error: null, retries: 0 },
        ],
      }) as never,
    );
    expect(result.jobs.map((j) => j.id)).toEqual(['j3', 'j2', 'j1']);
  });

  it('serializes outline when present', () => {
    const result = serializeBookDetail(
      makeRawBook({
        outline: {
          id: 'ol_1',
          status: 'pending_review',
          reject_note: null,
          approved_at: null,
          created_at: new Date('2026-05-25T02:00:00.000Z'),
          chapters_json: [
            { heading: 'A', target_chars: 5000 },
            { heading: 'B', target_chars: 6000 },
          ],
        },
      }) as never,
    );
    expect(result.outline).not.toBeNull();
    expect(result.outline!.id).toBe('ol_1');
    expect(result.outline!.status).toBe('pending_review');
    expect(result.outline!.chapters).toHaveLength(2);
    expect(result.outline!.total_target_chars).toBe(11000);
    expect(result.outline!.created_at).toBe('2026-05-25T02:00:00.000Z');
  });

  it('outline is null when not present', () => {
    const result = serializeBookDetail(makeRawBook({ outline: null }) as never);
    expect(result.outline).toBeNull();
  });

  it('serializes revisionComments with Date fields', () => {
    const raw = makeRawBook() as Record<string, unknown>;
    raw.revisionComments = [
      {
        id: 'rc_1',
        book_id: 'book_1',
        target_kind: 'chapter',
        target_id: 'ch_1',
        range_json: { paragraph_range: [2, 2] },
        body: 'Fix paragraph',
        priority: 'must',
        status: 'pending',
        created_at: new Date('2026-05-25T03:00:00.000Z'),
        applied_at: null,
      },
    ];
    const result = serializeBookDetail(raw as never);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]!.id).toBe('rc_1');
    expect(result.comments[0]!.created_at).toBe('2026-05-25T03:00:00.000Z');
    expect(result.comments[0]!.applied_at).toBeNull();
    expect(result.comments[0]!.range_json).toEqual({ paragraph_range: [2, 2] });
    expect(result.comments[0]!.priority).toBe('must');
    expect(result.comments[0]!.status).toBe('pending');
  });

  it('serializes revisionComment applied_at when present', () => {
    const raw = makeRawBook() as Record<string, unknown>;
    raw.revisionComments = [
      {
        id: 'rc_2',
        book_id: 'book_1',
        target_kind: 'outline',
        target_id: 'ol_1',
        range_json: null,
        body: 'Check structure',
        priority: 'should',
        status: 'applied',
        created_at: new Date('2026-05-25T03:00:00.000Z'),
        applied_at: new Date('2026-05-25T04:00:00.000Z'),
      },
    ];
    const result = serializeBookDetail(raw as never);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]!.applied_at).toBe('2026-05-25T04:00:00.000Z');
    expect(result.comments[0]!.range_json).toBeNull();
  });

  it('returns empty comments array when revisionComments is omitted', () => {
    const result = serializeBookDetail(makeRawBook() as never);
    expect(result.comments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatBookStatus
// ---------------------------------------------------------------------------
describe('formatBookStatus', () => {
  it('maps known statuses to Japanese', () => {
    expect(formatBookStatus('done')).toBe('完了');
    expect(formatBookStatus('running')).toBe('実行中');
    expect(formatBookStatus('failed')).toBe('失敗');
  });
});

// ---------------------------------------------------------------------------
// formatCostStatus
// ---------------------------------------------------------------------------
describe('formatCostStatus', () => {
  it('maps known statuses', () => {
    expect(formatCostStatus('normal')).toBe('正常');
    expect(formatCostStatus('warn')).toBe('警告');
    expect(formatCostStatus('exceeded')).toBe('超過');
  });
});

// ---------------------------------------------------------------------------
// formatGenre
// ---------------------------------------------------------------------------
describe('formatGenre', () => {
  it('maps known genres', () => {
    expect(formatGenre('business')).toBe('ビジネス書');
    expect(formatGenre('practical')).toBe('実用書');
    expect(formatGenre('self_help')).toBe('自己啓発');
  });

  it('returns raw for unknown', () => {
    expect(formatGenre('mystery')).toBe('mystery');
  });

  it('returns null for null/undefined', () => {
    expect(formatGenre(null)).toBeNull();
    expect(formatGenre(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatDateTime
// ---------------------------------------------------------------------------
describe('formatDateTime', () => {
  it('formats ISO to YYYY-MM-DD HH:mm', () => {
    const result = formatDateTime('2026-05-25T10:30:00.000Z');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('returns raw on invalid date', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// costThresholdPercent
// ---------------------------------------------------------------------------
describe('costThresholdPercent', () => {
  it('returns percentage capped at 100', () => {
    expect(costThresholdPercent(250, 500)).toBe(50);
    expect(costThresholdPercent(500, 500)).toBe(100);
    expect(costThresholdPercent(600, 500)).toBe(100);
  });

  it('returns 0 for threshold <= 0', () => {
    expect(costThresholdPercent(100, 0)).toBe(0);
    expect(costThresholdPercent(100, -1)).toBe(0);
  });

  it('rounds to nearest integer', () => {
    expect(costThresholdPercent(333, 1000)).toBe(33);
    expect(costThresholdPercent(337, 1000)).toBe(34);
  });
});

// ---------------------------------------------------------------------------
// COST_THRESHOLD constants
// ---------------------------------------------------------------------------
describe('cost threshold constants', () => {
  it('COST_THRESHOLD_WARN is 500', () => {
    expect(COST_THRESHOLD_WARN).toBe(500);
  });

  it('COST_THRESHOLD_PAUSE is 750', () => {
    expect(COST_THRESHOLD_PAUSE).toBe(750);
  });
});

// ---------------------------------------------------------------------------
// formatJobKind
// ---------------------------------------------------------------------------
describe('formatJobKind', () => {
  it('maps known job kinds to Japanese', () => {
    expect(formatJobKind('pipeline.book.kickoff')).toBe('キックオフ');
    expect(formatJobKind('pipeline.book.marketer')).toBe('Marketer');
    expect(formatJobKind('pipeline.book.writer.outline')).toBe('Writer (アウトライン)');
    expect(formatJobKind('pipeline.book.writer.chapter')).toBe('Writer (章)');
    expect(formatJobKind('pipeline.book.editor')).toBe('Editor');
  });

  it('returns raw for unknown kind', () => {
    expect(formatJobKind('some.unknown.task')).toBe('some.unknown.task');
  });
});
