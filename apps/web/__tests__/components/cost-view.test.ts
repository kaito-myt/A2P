/**
 * cost-view.ts のユニットテスト (T-04-10).
 *
 * 検証:
 *  - serializeCostGroupBy: raw groupBy 結果をシリアライズ + ソート + 合計
 *  - formatCostJpy: 円表示フォーマット
 *  - formatTokenCount: k/M 省略表記
 *  - formatRole: role ラベル
 *  - formatProvider: 先頭大文字
 */
import { describe, expect, it } from 'vitest';

import {
  serializeCostGroupBy,
  formatCostJpy,
  formatTokenCount,
  formatRole,
  formatProvider,
  type CostGroupByRaw,
} from '../../lib/cost-view';

// ---------------------------------------------------------------------------
// serializeCostGroupBy
// ---------------------------------------------------------------------------
describe('serializeCostGroupBy', () => {
  function makeRaw(overrides: Partial<{
    provider: string;
    model: string;
    role: string;
    input_tokens: number | null;
    output_tokens: number | null;
    cached_input_tokens: number | null;
    image_count: number | null;
    cost_jpy: unknown;
    count: number;
  }> = {}): CostGroupByRaw {
    return {
      provider: overrides.provider ?? 'anthropic',
      model: overrides.model ?? 'claude-sonnet-4-20250514',
      role: overrides.role ?? 'writer',
      _sum: {
        input_tokens: overrides.input_tokens ?? 10000,
        output_tokens: overrides.output_tokens ?? 30000,
        cached_input_tokens: overrides.cached_input_tokens ?? 500,
        image_count: overrides.image_count ?? 0,
        cost_jpy: overrides.cost_jpy ?? 45.5,
      },
      _count: { _all: overrides.count ?? 3 },
    };
  }

  it('serializes single row', () => {
    const result = serializeCostGroupBy([makeRaw()]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      role: 'writer',
      input_tokens: 10000,
      output_tokens: 30000,
      cached_input_tokens: 500,
      image_count: 0,
      cost_jpy: 45.5,
      call_count: 3,
    });
    expect(result.total_cost_jpy).toBe(45.5);
    expect(result.total_input_tokens).toBe(10000);
    expect(result.total_output_tokens).toBe(30000);
    expect(result.total_call_count).toBe(3);
  });

  it('sorts rows by cost_jpy descending', () => {
    const result = serializeCostGroupBy([
      makeRaw({ role: 'editor', cost_jpy: 10 }),
      makeRaw({ role: 'writer', cost_jpy: 50 }),
      makeRaw({ role: 'marketer', cost_jpy: 30 }),
    ]);
    expect(result.rows.map((r) => r.role)).toEqual(['writer', 'marketer', 'editor']);
  });

  it('computes totals across multiple rows', () => {
    const result = serializeCostGroupBy([
      makeRaw({ input_tokens: 1000, output_tokens: 2000, cost_jpy: 10, count: 1 }),
      makeRaw({ input_tokens: 3000, output_tokens: 4000, cost_jpy: 20, count: 2 }),
    ]);
    expect(result.total_cost_jpy).toBe(30);
    expect(result.total_input_tokens).toBe(4000);
    expect(result.total_output_tokens).toBe(6000);
    expect(result.total_call_count).toBe(3);
  });

  it('handles empty array', () => {
    const result = serializeCostGroupBy([]);
    expect(result.rows).toEqual([]);
    expect(result.total_cost_jpy).toBe(0);
    expect(result.total_input_tokens).toBe(0);
    expect(result.total_output_tokens).toBe(0);
    expect(result.total_call_count).toBe(0);
  });

  it('handles null _sum values gracefully', () => {
    const raw: CostGroupByRaw = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      role: 'writer',
      _sum: {
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        image_count: null,
        cost_jpy: null,
      },
      _count: { _all: 3 },
    };
    const result = serializeCostGroupBy([raw]);
    expect(result.rows[0]).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      role: 'writer',
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      image_count: 0,
      cost_jpy: 0,
      call_count: 3,
    });
  });

  it('handles Decimal-like cost_jpy (string representation)', () => {
    const result = serializeCostGroupBy([makeRaw({ cost_jpy: '123.4567' })]);
    expect(result.rows[0]!.cost_jpy).toBeCloseTo(123.4567);
  });
});

// ---------------------------------------------------------------------------
// formatCostJpy
// ---------------------------------------------------------------------------
describe('formatCostJpy', () => {
  it('formats integer cost with yen sign', () => {
    expect(formatCostJpy(500)).toBe('¥500');
  });

  it('rounds decimal cost', () => {
    expect(formatCostJpy(123.456)).toBe('¥123');
  });

  it('formats zero', () => {
    expect(formatCostJpy(0)).toBe('¥0');
  });

  it('formats thousands with locale separator', () => {
    const result = formatCostJpy(1234);
    expect(result).toContain('1');
    expect(result).toContain('234');
  });
});

// ---------------------------------------------------------------------------
// formatTokenCount
// ---------------------------------------------------------------------------
describe('formatTokenCount', () => {
  it('formats small values as-is', () => {
    expect(formatTokenCount(500)).toBe('500');
  });

  it('formats thousands with k suffix', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(42300)).toBe('42.3k');
  });

  it('formats millions with M suffix', () => {
    expect(formatTokenCount(1000000)).toBe('1.0M');
    expect(formatTokenCount(2500000)).toBe('2.5M');
  });

  it('formats zero', () => {
    expect(formatTokenCount(0)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// formatRole
// ---------------------------------------------------------------------------
describe('formatRole', () => {
  it('maps known roles to Japanese labels', () => {
    expect(formatRole('writer')).toBe('Writer');
    expect(formatRole('editor')).toBe('Editor');
    expect(formatRole('marketer')).toBe('Marketer');
    expect(formatRole('judge')).toBe('Judge');
    expect(formatRole('thumbnail_text')).toBe('サムネテキスト');
    expect(formatRole('thumbnail_image')).toBe('サムネ画像');
    expect(formatRole('revision')).toBe('修正反映');
  });

  it('returns raw for unknown role', () => {
    expect(formatRole('custom_role')).toBe('custom_role');
  });
});

// ---------------------------------------------------------------------------
// formatProvider
// ---------------------------------------------------------------------------
describe('formatProvider', () => {
  it('capitalizes first letter', () => {
    expect(formatProvider('anthropic')).toBe('Anthropic');
    expect(formatProvider('openai')).toBe('Openai');
    expect(formatProvider('google')).toBe('Google');
  });

  it('handles already capitalized', () => {
    expect(formatProvider('Anthropic')).toBe('Anthropic');
  });

  it('handles empty string', () => {
    expect(formatProvider('')).toBe('');
  });
});
