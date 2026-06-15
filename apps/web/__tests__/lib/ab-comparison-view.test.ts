/**
 * ab-comparison-shared.ts 純関数の単体テスト (T-13-04, F-026).
 *
 * テスト対象:
 *  - formatJpy
 *  - formatQualityScore
 *  - formatLeadTime
 *  - formatCacheHitRate
 *  - formatDiff
 *  - formatDiffJpy
 *  - formatDateJa
 *  - buildFilterSerializedFromSearchParams
 */
import { describe, it, expect } from 'vitest';

import {
  formatJpy,
  formatQualityScore,
  formatLeadTime,
  formatCacheHitRate,
  formatDiff,
  formatDiffJpy,
  formatDateJa,
  buildFilterSerializedFromSearchParams,
} from '../../lib/ab-comparison-shared';

// ---------------------------------------------------------------------------
// formatJpy
// ---------------------------------------------------------------------------

describe('formatJpy', () => {
  it('formats integer with yen sign and comma', () => {
    expect(formatJpy(1234)).toBe('¥1,234');
    expect(formatJpy(0)).toBe('¥0');
    expect(formatJpy(100000)).toBe('¥100,000');
  });

  it('rounds fractional values', () => {
    expect(formatJpy(1234.6)).toBe('¥1,235');
    expect(formatJpy(1234.4)).toBe('¥1,234');
  });

  it('returns dash for null', () => {
    expect(formatJpy(null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// formatQualityScore
// ---------------------------------------------------------------------------

describe('formatQualityScore', () => {
  it('formats to 1 decimal', () => {
    expect(formatQualityScore(78.4)).toBe('78.4');
    expect(formatQualityScore(80)).toBe('80.0');
  });

  it('returns dash for null', () => {
    expect(formatQualityScore(null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// formatLeadTime
// ---------------------------------------------------------------------------

describe('formatLeadTime', () => {
  it('formats to 1 decimal', () => {
    expect(formatLeadTime(2.5)).toBe('2.5');
    expect(formatLeadTime(0)).toBe('0.0');
  });

  it('returns dash for null', () => {
    expect(formatLeadTime(null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// formatCacheHitRate
// ---------------------------------------------------------------------------

describe('formatCacheHitRate', () => {
  it('formats 0–1 as percentage with 1 decimal', () => {
    expect(formatCacheHitRate(0.25)).toBe('25.0%');
    expect(formatCacheHitRate(1)).toBe('100.0%');
    expect(formatCacheHitRate(0)).toBe('0.0%');
  });

  it('returns dash for null', () => {
    expect(formatCacheHitRate(null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// formatDiff
// ---------------------------------------------------------------------------

describe('formatDiff', () => {
  it('shows + sign for positive diff (B > A)', () => {
    expect(formatDiff(78, 81)).toBe('+3.0');
  });

  it('shows - sign for negative diff (B < A)', () => {
    expect(formatDiff(81, 78)).toBe('-3.0');
  });

  it('shows +0.0 for equal values', () => {
    expect(formatDiff(80, 80)).toBe('+0.0');
  });

  it('returns dash when either value is null', () => {
    expect(formatDiff(null, 80)).toBe('—');
    expect(formatDiff(80, null)).toBe('—');
    expect(formatDiff(null, null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// formatDiffJpy
// ---------------------------------------------------------------------------

describe('formatDiffJpy', () => {
  it('formats positive diff with + and yen sign', () => {
    expect(formatDiffJpy(200, 250)).toBe('+¥50');
  });

  it('formats negative diff with - and yen sign', () => {
    expect(formatDiffJpy(300, 200)).toBe('-¥100');
  });

  it('returns dash when either value is null', () => {
    expect(formatDiffJpy(null, 200)).toBe('—');
    expect(formatDiffJpy(200, null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// formatDateJa
// ---------------------------------------------------------------------------

describe('formatDateJa', () => {
  it('formats ISO date string to Japanese locale short form', () => {
    const result = formatDateJa('2026-06-14T10:00:00.000Z');
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/06|6/);
  });

  it('returns dash for null', () => {
    expect(formatDateJa(null)).toBe('—');
  });

  it('returns dash for empty string', () => {
    expect(formatDateJa('')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// buildFilterSerializedFromSearchParams
// ---------------------------------------------------------------------------

describe('buildFilterSerializedFromSearchParams', () => {
  it('defaults to mode=period when no params provided', () => {
    const filter = buildFilterSerializedFromSearchParams({});
    expect(filter.mode).toBe('period');
  });

  it('defaults minSample to 5', () => {
    const filter = buildFilterSerializedFromSearchParams({});
    expect(filter.minSample).toBe(5);
  });

  it('parses mode=prompt with role/baselineId/candidateId', () => {
    const filter = buildFilterSerializedFromSearchParams({
      mode: 'prompt',
      role: 'writer',
      baselineId: 'pv_001',
      candidateId: 'pv_002',
      minSample: '3',
    });
    expect(filter.mode).toBe('prompt');
    expect(filter.role).toBe('writer');
    expect(filter.baselineId).toBe('pv_001');
    expect(filter.candidateId).toBe('pv_002');
    expect(filter.minSample).toBe(3);
  });

  it('parses mode=model', () => {
    const filter = buildFilterSerializedFromSearchParams({
      mode: 'model',
      role: 'editor',
      baselineId: 'claude-sonnet-4-6',
      candidateId: 'gemini-2.5-flash',
    });
    expect(filter.mode).toBe('model');
    expect(filter.role).toBe('editor');
  });

  it('handles array searchParams by taking first value', () => {
    const filter = buildFilterSerializedFromSearchParams({ mode: ['prompt', 'period'] });
    expect(filter.mode).toBe('prompt');
  });

  it('sets periodA/periodB from date params as ISO strings', () => {
    const filter = buildFilterSerializedFromSearchParams({
      mode: 'period',
      dateFromA: '2026-04-01',
      dateToA: '2026-04-30',
      dateFromB: '2026-05-01',
      dateToB: '2026-05-31',
    });
    expect(filter.mode).toBe('period');
    expect(filter.periodA?.from).toBe('2026-04-01');
    expect(filter.periodB?.from).toBe('2026-05-01');
  });
});
