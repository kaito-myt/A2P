/**
 * eval-history-view.ts のユニットテスト (T-10-06).
 *
 * 検証:
 *  - parseScoreBreakdown: Json -> ScoreBreakdown
 *  - parseJudgeComments: Json -> Record<string, string>
 *  - parseTriggeredBy: triggered_by 文字列の分解
 *  - serializeEvalResult: Date/Json 正規化
 *  - isLowScore: 閾値判定
 *  - formatScoreAxis: 軸名の日本語変換
 */
import { describe, expect, it } from 'vitest';

import {
  parseScoreBreakdown,
  parseJudgeComments,
  parseTriggeredBy,
  serializeEvalResult,
  serializeEvalResults,
  isLowScore,
  formatScoreAxis,
  SCORE_LOW_THRESHOLD,
} from '../../lib/eval-history-view';

// ---------------------------------------------------------------------------
// parseScoreBreakdown
// ---------------------------------------------------------------------------
describe('parseScoreBreakdown', () => {
  it('parses valid 6-axis object', () => {
    const result = parseScoreBreakdown({
      benefit_clarity: 15,
      logical_consistency: 18,
      style_consistency: 12,
      japanese_naturalness: 17,
      title_alignment: 14,
      genre_fit: 16,
    });
    expect(result.benefit_clarity).toBe(15);
    expect(result.logical_consistency).toBe(18);
    expect(result.genre_fit).toBe(16);
  });

  it('returns empty object for null / invalid input', () => {
    expect(parseScoreBreakdown(null)).toEqual({});
    expect(parseScoreBreakdown('invalid')).toEqual({});
    expect(parseScoreBreakdown(42)).toEqual({});
  });

  it('returns partial object when some axes are missing', () => {
    const result = parseScoreBreakdown({ benefit_clarity: 10 });
    expect(result.benefit_clarity).toBe(10);
    expect(result.logical_consistency).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseJudgeComments
// ---------------------------------------------------------------------------
describe('parseJudgeComments', () => {
  it('parses string-valued Record', () => {
    const result = parseJudgeComments({
      benefit_clarity: '有益性が高い',
      genre_fit: 'ジャンル適合良好',
    });
    expect(result['benefit_clarity']).toBe('有益性が高い');
    expect(result['genre_fit']).toBe('ジャンル適合良好');
  });

  it('skips non-string values', () => {
    const result = parseJudgeComments({ foo: 42, bar: 'valid' });
    expect(result['foo']).toBeUndefined();
    expect(result['bar']).toBe('valid');
  });

  it('returns empty object for null / array / primitive', () => {
    expect(parseJudgeComments(null)).toEqual({});
    expect(parseJudgeComments([])).toEqual({});
    expect(parseJudgeComments('str')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseTriggeredBy
// ---------------------------------------------------------------------------
describe('parseTriggeredBy', () => {
  it('"auto" -> triggeredByAuto label, no revisionRunId', () => {
    const r = parseTriggeredBy('auto');
    expect(r.label).toBe('自動');
    expect(r.revisionRunId).toBeNull();
  });

  it('"manual" -> triggeredByManual label', () => {
    const r = parseTriggeredBy('manual');
    expect(r.label).toBe('手動');
    expect(r.revisionRunId).toBeNull();
  });

  it('"revision_run:<id>" -> triggeredByRevision label + revisionRunId', () => {
    const r = parseTriggeredBy('revision_run:rev_abc123');
    expect(r.label).toBe('修正反映');
    expect(r.revisionRunId).toBe('rev_abc123');
  });

  it('unknown value -> raw label, no revisionRunId', () => {
    const r = parseTriggeredBy('some_other_value');
    expect(r.label).toBe('some_other_value');
    expect(r.revisionRunId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializeEvalResult
// ---------------------------------------------------------------------------
describe('serializeEvalResult', () => {
  function makeRaw(overrides: {
    score_total?: number;
    triggered_by?: string;
    judged_at?: Date;
    score_breakdown_json?: unknown;
    judge_comments_json?: unknown;
  } = {}) {
    return {
      id: 'eval_1',
      book_id: 'book_1',
      score_total: overrides.score_total ?? 85,
      score_breakdown_json: overrides.score_breakdown_json ?? {
        benefit_clarity: 15,
        logical_consistency: 16,
      },
      judge_comments_json: overrides.judge_comments_json ?? {
        benefit_clarity: '良好',
      },
      triggered_by: overrides.triggered_by ?? 'auto',
      judged_at: overrides.judged_at ?? new Date('2026-06-14T10:00:00.000Z'),
    };
  }

  it('serializes judged_at to ISO string', () => {
    const result = serializeEvalResult(makeRaw());
    expect(result.judged_at).toBe('2026-06-14T10:00:00.000Z');
  });

  it('preserves score_total as number', () => {
    const result = serializeEvalResult(makeRaw({ score_total: 72 }));
    expect(result.score_total).toBe(72);
  });

  it('parses score_breakdown_json', () => {
    const result = serializeEvalResult(makeRaw({
      score_breakdown_json: { benefit_clarity: 18, genre_fit: 14 },
    }));
    expect(result.score_breakdown.benefit_clarity).toBe(18);
    expect(result.score_breakdown.genre_fit).toBe(14);
  });

  it('parses judge_comments_json', () => {
    const result = serializeEvalResult(makeRaw({
      judge_comments_json: { benefit_clarity: 'コメント内容' },
    }));
    expect(result.judge_comments['benefit_clarity']).toBe('コメント内容');
  });

  it('handles invalid breakdown gracefully', () => {
    const raw = {
      id: 'eval_x',
      book_id: 'book_1',
      score_total: 85,
      score_breakdown_json: null,
      judge_comments_json: {},
      triggered_by: 'auto',
      judged_at: new Date('2026-06-14T10:00:00.000Z'),
    };
    const result = serializeEvalResult(raw as never);
    expect(result.score_breakdown).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// serializeEvalResults — empty array
// ---------------------------------------------------------------------------
describe('serializeEvalResults', () => {
  it('returns empty array for empty input', () => {
    expect(serializeEvalResults([])).toEqual([]);
  });

  it('serializes multiple results', () => {
    const results = serializeEvalResults([
      {
        id: 'e1',
        book_id: 'b1',
        score_total: 90,
        score_breakdown_json: {},
        judge_comments_json: {},
        triggered_by: 'auto',
        judged_at: new Date('2026-06-14T08:00:00.000Z'),
      },
      {
        id: 'e2',
        book_id: 'b1',
        score_total: 70,
        score_breakdown_json: {},
        judge_comments_json: {},
        triggered_by: 'manual',
        judged_at: new Date('2026-06-14T06:00:00.000Z'),
      },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('e1');
    expect(results[1]!.id).toBe('e2');
  });
});

// ---------------------------------------------------------------------------
// isLowScore
// ---------------------------------------------------------------------------
describe('isLowScore', () => {
  it(`returns true for score < ${SCORE_LOW_THRESHOLD}`, () => {
    expect(isLowScore(79)).toBe(true);
    expect(isLowScore(0)).toBe(true);
  });

  it(`returns false for score >= ${SCORE_LOW_THRESHOLD}`, () => {
    expect(isLowScore(80)).toBe(false);
    expect(isLowScore(100)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatScoreAxis
// ---------------------------------------------------------------------------
describe('formatScoreAxis', () => {
  it('maps known axes to Japanese', () => {
    expect(formatScoreAxis('benefit_clarity')).toBe('有益性');
    expect(formatScoreAxis('logical_consistency')).toBe('論理性');
    expect(formatScoreAxis('style_consistency')).toBe('スタイル');
    expect(formatScoreAxis('japanese_naturalness')).toBe('自然な日本語');
    expect(formatScoreAxis('title_alignment')).toBe('タイトル整合');
    expect(formatScoreAxis('genre_fit')).toBe('ジャンル適合');
  });

  it('returns raw for unknown axis', () => {
    expect(formatScoreAxis('unknown_axis')).toBe('unknown_axis');
  });
});
