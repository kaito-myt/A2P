/**
 * books-view.ts library helpers (T-05-11 / S-009).
 *
 * Tests:
 *  - serializeBookRow: Date/Decimal normalization, genre extraction, artifacts mapping
 *  - findArtifactByKind: finds correct artifact or undefined
 */
import { describe, expect, it } from 'vitest';

import {
  serializeBookRow,
  findArtifactByKind,
  type BookArtifactSerialized,
} from '../../lib/books-view';

// ---------------------------------------------------------------------------
// serializeBookRow
// ---------------------------------------------------------------------------
describe('serializeBookRow', () => {
  function makeRawBook(overrides: Record<string, unknown> = {}) {
    return {
      id: 'book_1',
      title: 'Test Book',
      status: 'queued',
      cost_status: 'normal',
      cost_jpy_total: 432.55,
      has_pending_comments: false,
      has_blocking_comments: false,
      created_at: new Date('2026-05-25T00:00:00.000Z'),
      updated_at: new Date('2026-05-25T01:00:00.000Z'),
      account_id: 'acc_1',
      theme_id: 'theme_1',
      account: { id: 'acc_1', pen_name: 'TestPen' },
      theme: { genre: 'business' },
      artifacts: [],
      ...overrides,
    };
  }

  it('serializes Date fields to ISO strings', () => {
    const result = serializeBookRow(makeRawBook() as never);
    expect(result.created_at).toBe('2026-05-25T00:00:00.000Z');
    expect(result.updated_at).toBe('2026-05-25T01:00:00.000Z');
  });

  it('normalizes cost_jpy_total to number', () => {
    const result = serializeBookRow(makeRawBook({ cost_jpy_total: 123.45 }) as never);
    expect(result.cost_jpy_total).toBe(123.45);
  });

  it('extracts genre from theme', () => {
    const result = serializeBookRow(makeRawBook({ theme: { genre: 'self_help' } }) as never);
    expect(result.genre).toBe('self_help');
  });

  it('genre is null when theme is null', () => {
    const result = serializeBookRow(makeRawBook({ theme: null }) as never);
    expect(result.genre).toBeNull();
  });

  it('maps artifacts to id+kind pairs', () => {
    const result = serializeBookRow(
      makeRawBook({
        artifacts: [
          { id: 'art_1', kind: 'docx' },
          { id: 'art_2', kind: 'pdf' },
          { id: 'art_3', kind: 'png_cover' },
        ],
      }) as never,
    );
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts[0]).toEqual({ id: 'art_1', kind: 'docx' });
    expect(result.artifacts[1]).toEqual({ id: 'art_2', kind: 'pdf' });
    expect(result.artifacts[2]).toEqual({ id: 'art_3', kind: 'png_cover' });
  });

  it('normalizes unknown status to "queued"', () => {
    const result = serializeBookRow(makeRawBook({ status: 'bogus' }) as never);
    expect(result.status).toBe('queued');
  });

  it('normalizes unknown cost_status to "normal"', () => {
    const result = serializeBookRow(makeRawBook({ cost_status: 'xxx' }) as never);
    expect(result.cost_status).toBe('normal');
  });

  it('handles missing artifacts gracefully', () => {
    const result = serializeBookRow(makeRawBook({ artifacts: undefined }) as never);
    expect(result.artifacts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findArtifactByKind
// ---------------------------------------------------------------------------
describe('findArtifactByKind', () => {
  const artifacts: BookArtifactSerialized[] = [
    { id: 'art_1', kind: 'docx' },
    { id: 'art_2', kind: 'pdf' },
    { id: 'art_3', kind: 'png_cover' },
  ];

  it('finds artifact by kind', () => {
    expect(findArtifactByKind(artifacts, 'docx')).toBe('art_1');
    expect(findArtifactByKind(artifacts, 'pdf')).toBe('art_2');
    expect(findArtifactByKind(artifacts, 'png_cover')).toBe('art_3');
  });

  it('returns undefined for missing kind', () => {
    expect(findArtifactByKind(artifacts, 'md_source')).toBeUndefined();
  });

  it('returns undefined for empty artifacts', () => {
    expect(findArtifactByKind([], 'docx')).toBeUndefined();
  });
});
