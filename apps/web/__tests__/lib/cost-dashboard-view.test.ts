import { describe, it, expect } from 'vitest';

import {
  computeCostKpi,
  getPredictionLevel,
  getForecastLevel,
  aggregateByKey,
  serializeTopCostBook,
  serializePausedBook,
  formatCostJpy,
  formatTokenCount,
  buildCostCsv,
  buildCostCsvFilename,
} from '@/lib/cost-dashboard-view';

// ---------------------------------------------------------------------------
// computeCostKpi
// ---------------------------------------------------------------------------

describe('computeCostKpi', () => {
  it('computes KPI for mid-month with non-zero actual', () => {
    const now = new Date(2026, 4, 15); // May 15
    const kpi = computeCostKpi(25000, 10, now);

    expect(kpi.actual).toBe(25000);
    expect(kpi.elapsedDays).toBe(15);
    expect(kpi.totalDays).toBe(31);
    // forecast = 25000/15 * 31 ~= 51667
    expect(kpi.forecast).toBeGreaterThan(50000);
    expect(kpi.remaining).toBe(25000);
    expect(kpi.ratioPct).toBe(50);
    expect(kpi.perBook).toBe(2500);
    expect(kpi.bookCount).toBe(10);
  });

  it('handles zero actual and zero books', () => {
    const now = new Date(2026, 0, 10); // Jan 10
    const kpi = computeCostKpi(0, 0, now);

    expect(kpi.actual).toBe(0);
    expect(kpi.forecast).toBe(0);
    expect(kpi.remaining).toBe(50000);
    expect(kpi.ratioPct).toBe(0);
    expect(kpi.perBook).toBe(0);
  });

  it('clamps remaining to zero when over limit', () => {
    const now = new Date(2026, 2, 20);
    const kpi = computeCostKpi(55000, 5, now);

    expect(kpi.remaining).toBe(0);
    expect(kpi.ratioPct).toBe(110);
    expect(kpi.perBook).toBe(11000);
  });

  it('first day of month uses elapsed=1', () => {
    const now = new Date(2026, 5, 1); // June 1
    const kpi = computeCostKpi(1000, 1, now);

    expect(kpi.elapsedDays).toBe(1);
    expect(kpi.totalDays).toBe(30);
    // forecast = 1000/1 * 30 = 30000
    expect(kpi.forecast).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// getPredictionLevel / getForecastLevel
// ---------------------------------------------------------------------------

describe('getPredictionLevel', () => {
  it('returns safe below 80%', () => {
    expect(getPredictionLevel(0)).toBe('safe');
    expect(getPredictionLevel(79.9)).toBe('safe');
  });
  it('returns yellow at 80%', () => {
    expect(getPredictionLevel(80)).toBe('yellow');
    expect(getPredictionLevel(94.9)).toBe('yellow');
  });
  it('returns orange at 95%', () => {
    expect(getPredictionLevel(95)).toBe('orange');
    expect(getPredictionLevel(99.9)).toBe('orange');
  });
  it('returns red at 100%', () => {
    expect(getPredictionLevel(100)).toBe('red');
    expect(getPredictionLevel(150)).toBe('red');
  });
});

describe('getForecastLevel', () => {
  it('maps the same thresholds', () => {
    expect(getForecastLevel(50)).toBe('safe');
    expect(getForecastLevel(85)).toBe('yellow');
    expect(getForecastLevel(97)).toBe('orange');
    expect(getForecastLevel(105)).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// aggregateByKey
// ---------------------------------------------------------------------------

describe('aggregateByKey', () => {
  it('aggregates rows by key and computes share', () => {
    const rows = [
      { key: 'anthropic', cost_jpy: 300, input_tokens: 1000, output_tokens: 500, call_count: 2 },
      { key: 'openai', cost_jpy: 200, input_tokens: 800, output_tokens: 400, call_count: 1 },
      { key: 'anthropic', cost_jpy: 500, input_tokens: 2000, output_tokens: 1000, call_count: 3 },
    ];

    const result = aggregateByKey(rows);

    expect(result).toHaveLength(2);
    // anthropic first (higher cost)
    const anthropic = result.find((r) => r.key === 'anthropic')!;
    const openai = result.find((r) => r.key === 'openai')!;

    expect(anthropic.key).toBe('anthropic');
    expect(anthropic.cost_jpy).toBe(800);
    expect(anthropic.input_tokens).toBe(3000);
    expect(anthropic.output_tokens).toBe(1500);
    expect(anthropic.call_count).toBe(5);
    expect(anthropic.share_pct).toBe(80);

    expect(openai.key).toBe('openai');
    expect(openai.cost_jpy).toBe(200);
    expect(openai.share_pct).toBe(20);
  });

  it('returns empty for empty input', () => {
    expect(aggregateByKey([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// serializeTopCostBook
// ---------------------------------------------------------------------------

describe('serializeTopCostBook', () => {
  it('marks books over 500 as over_threshold', () => {
    const titleMap = new Map([['b1', 'Test Book']]);
    const result = serializeTopCostBook(
      { book_id: 'b1', total_cost_jpy: 600, total_input_tokens: 1000, total_output_tokens: 500, total_image_count: 2 },
      titleMap,
    );
    expect(result.over_threshold).toBe(true);
    expect(result.title).toBe('Test Book');
    expect(result.total_cost_jpy).toBe(600);
  });

  it('marks books at or below 500 as not over', () => {
    const titleMap = new Map<string, string>();
    const result = serializeTopCostBook(
      { book_id: 'b2', total_cost_jpy: 500, total_input_tokens: 0, total_output_tokens: 0, total_image_count: 0 },
      titleMap,
    );
    expect(result.over_threshold).toBe(false);
    expect(result.title).toBe('b2'); // fallback to book_id
  });
});

// ---------------------------------------------------------------------------
// serializePausedBook
// ---------------------------------------------------------------------------

describe('serializePausedBook', () => {
  it('serializes paused book with Decimal cost', () => {
    const result = serializePausedBook({
      id: 'b1',
      title: 'My Book',
      status: 'paused_cost',
      cost_status: 'paused',
      cost_jpy_total: '750.00',
      account: { pen_name: 'Author A' },
    });
    expect(result.cost_jpy_total).toBe(750);
    expect(result.account_pen_name).toBe('Author A');
  });

  it('handles null account', () => {
    const result = serializePausedBook({
      id: 'b2',
      title: 'Book2',
      status: 'paused_cost',
      cost_status: 'paused',
      cost_jpy_total: null,
      account: null,
    });
    expect(result.cost_jpy_total).toBe(0);
    expect(result.account_pen_name).toBe('');
  });
});

// ---------------------------------------------------------------------------
// formatCostJpy / formatTokenCount
// ---------------------------------------------------------------------------

describe('formatCostJpy', () => {
  it('formats with yen prefix and comma separator', () => {
    expect(formatCostJpy(12345.6)).toBe('¥12,346');
    expect(formatCostJpy(0)).toBe('¥0');
    expect(formatCostJpy(50000)).toBe('¥50,000');
  });
});

describe('formatTokenCount', () => {
  it('formats millions with M suffix', () => {
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });
  it('formats thousands with k suffix', () => {
    expect(formatTokenCount(1_500)).toBe('1.5k');
  });
  it('formats small numbers as-is', () => {
    expect(formatTokenCount(999)).toBe('999');
  });
});

// ---------------------------------------------------------------------------
// CSV builder
// ---------------------------------------------------------------------------

describe('buildCostCsv', () => {
  it('builds BOM-prefixed CSV with headers and rows', () => {
    const csv = buildCostCsv([
      {
        date: '2026-05-01',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        role: 'writer',
        input_tokens: 1000,
        output_tokens: 5000,
        cached_input_tokens: 200,
        image_count: 0,
        cost_jpy: 25.5,
      },
    ]);

    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('date,provider,model,role,input_tokens,output_tokens,cached_input_tokens,image_count,cost_jpy');
    expect(csv).toContain('2026-05-01,anthropic,claude-sonnet-4-20250514,writer,1000,5000,200,0,25.5');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('returns only header for empty rows', () => {
    const csv = buildCostCsv([]);
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines).toHaveLength(1);
  });
});

describe('buildCostCsvFilename', () => {
  it('generates filename with zero-padded month', () => {
    expect(buildCostCsvFilename(2026, 5)).toBe('cost-detail-2026-05.csv');
    expect(buildCostCsvFilename(2026, 12)).toBe('cost-detail-2026-12.csv');
  });
});
