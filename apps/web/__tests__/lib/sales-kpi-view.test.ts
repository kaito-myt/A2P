import { describe, it, expect } from 'vitest';

import {
  formatJpy,
  formatStars,
  formatRoi,
  formatCostSalesRatio,
  formatBsr,
  formatQuality,
  serializeBookKpiRow,
  buildMonthRange,
  monthRangeBounds,
  parsePeriodParam,
  buildHeatmapFromAggregates,
  buildTrendChartFromAggregates,
} from '@/lib/sales-kpi-view';

import type { BooksKpiRow } from '@a2p/db/books-kpi';

// ---------------------------------------------------------------------------
// formatJpy
// ---------------------------------------------------------------------------

describe('formatJpy', () => {
  it('formats with yen prefix and comma separator', () => {
    expect(formatJpy(0)).toBe('¥0');
    expect(formatJpy(1500)).toBe('¥1,500');
    expect(formatJpy(124500)).toBe('¥124,500');
  });

  it('rounds fractional values', () => {
    expect(formatJpy(1500.7)).toBe('¥1,501');
    expect(formatJpy(1500.3)).toBe('¥1,500');
  });
});

// ---------------------------------------------------------------------------
// formatStars
// ---------------------------------------------------------------------------

describe('formatStars', () => {
  it('returns dash for null', () => {
    expect(formatStars(null)).toBe('—');
  });

  it('formats to one decimal and appends star', () => {
    expect(formatStars(4.2)).toBe('4.2 ★');
    expect(formatStars(5.0)).toBe('5.0 ★');
    expect(formatStars(3.15)).toBe('3.2 ★');
  });
});

// ---------------------------------------------------------------------------
// formatRoi
// ---------------------------------------------------------------------------

describe('formatRoi', () => {
  it('returns dash for null', () => {
    expect(formatRoi(null)).toBe('—');
  });

  it('shows positive sign for ROI >= 1', () => {
    // roi = cumRoyalty / cost, e.g. 3.12 → +312%
    expect(formatRoi(3.12)).toBe('+312%');
  });

  it('shows positive sign for ROI between 0 and 1', () => {
    expect(formatRoi(0.5)).toBe('+50%');
  });

  it('shows negative for ROI < 0', () => {
    expect(formatRoi(-0.2)).toBe('-20%');
  });

  it('handles zero ROI', () => {
    expect(formatRoi(0)).toBe('+0%');
  });
});

// ---------------------------------------------------------------------------
// formatCostSalesRatio
// ---------------------------------------------------------------------------

describe('formatCostSalesRatio', () => {
  it('returns dash for null', () => {
    expect(formatCostSalesRatio(null)).toBe('—');
  });

  it('computes cost/sales percentage from inverse ratio', () => {
    // SalesKpiSummary.cost_sales_ratio = royalty / cost
    // so cost/sales% = 1/ratio * 100
    // ratio=2 → cost/sales = 50%
    expect(formatCostSalesRatio(2)).toBe('50%');
    // ratio=1 → 100%
    expect(formatCostSalesRatio(1)).toBe('100%');
  });

  it('handles zero ratio (avoids divide by zero)', () => {
    expect(formatCostSalesRatio(0)).toBe('0%');
  });
});

// ---------------------------------------------------------------------------
// formatBsr
// ---------------------------------------------------------------------------

describe('formatBsr', () => {
  it('returns dash for null', () => {
    expect(formatBsr(null)).toBe('—');
  });

  it('formats with locale separators', () => {
    expect(formatBsr(12345)).toMatch(/12[,.]?345/);
  });
});

// ---------------------------------------------------------------------------
// formatQuality
// ---------------------------------------------------------------------------

describe('formatQuality', () => {
  it('returns dash for null', () => {
    expect(formatQuality(null)).toBe('—');
  });

  it('rounds score to integer', () => {
    expect(formatQuality(87.5)).toBe('88');
    expect(formatQuality(72.1)).toBe('72');
  });
});

// ---------------------------------------------------------------------------
// serializeBookKpiRow
// ---------------------------------------------------------------------------

describe('serializeBookKpiRow', () => {
  function makeRow(overrides: Partial<BooksKpiRow & { genre?: string }> = {}): BooksKpiRow & { genre?: string } {
    return {
      book_id: 'b1',
      title: 'テスト書籍',
      subtitle: null,
      thumbnail_r2_key: null,
      published_at: new Date('2026-01-15T00:00:00.000Z'),
      asin: 'B09XXXXXX',
      monthly_royalty_jpy: 3000,
      cumulative_royalty_jpy: 12000,
      monthly_kenp_read: 500,
      cumulative_kenp_read: 2000,
      latest_bsr: 5000,
      avg_stars: 4.3,
      quality_score: 82,
      cost_jpy: 400,
      roi: 30, // 12000/400 = 30
      ...overrides,
    };
  }

  it('serializes dates to ISO string', () => {
    const result = serializeBookKpiRow(makeRow());
    expect(typeof result.published_at).toBe('string');
    expect(result.published_at).toMatch(/^2026-01-15/);
  });

  it('returns null for null published_at', () => {
    const result = serializeBookKpiRow(makeRow({ published_at: null }));
    expect(result.published_at).toBeNull();
  });

  it('formats ROI display as +3000%', () => {
    const result = serializeBookKpiRow(makeRow({ roi: 30 }));
    expect(result.roi_display).toBe('+3000%');
  });

  it('formats null ROI as dash', () => {
    const result = serializeBookKpiRow(makeRow({ roi: null }));
    expect(result.roi_display).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// buildMonthRange
// ---------------------------------------------------------------------------

describe('buildMonthRange', () => {
  it('returns 1 entry for period 1', () => {
    const months = buildMonthRange(1);
    expect(months).toHaveLength(1);
    // Should be YYYY-MM format
    expect(months[0]).toMatch(/^\d{4}-\d{2}$/);
  });

  it('returns 3 months ending with current month', () => {
    const months = buildMonthRange(3);
    expect(months).toHaveLength(3);
    // Last element is current month
    const now = new Date();
    const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(months[2]).toBe(currentYm);
  });

  it('returns 12 months for period 12', () => {
    const months = buildMonthRange(12);
    expect(months).toHaveLength(12);
  });

  it('months are chronologically ordered', () => {
    const months = buildMonthRange(6);
    for (let i = 1; i < months.length; i++) {
      expect(months[i]! > months[i - 1]!).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// monthRangeBounds
// ---------------------------------------------------------------------------

describe('monthRangeBounds', () => {
  it('returns null for empty array', () => {
    expect(monthRangeBounds([])).toBeNull();
  });

  it('returns first and last of array', () => {
    const result = monthRangeBounds(['2026-01', '2026-02', '2026-03']);
    expect(result).toEqual({ from: '2026-01', to: '2026-03' });
  });

  it('single element: from === to', () => {
    const result = monthRangeBounds(['2026-05']);
    expect(result).toEqual({ from: '2026-05', to: '2026-05' });
  });
});

// ---------------------------------------------------------------------------
// parsePeriodParam
// ---------------------------------------------------------------------------

describe('parsePeriodParam', () => {
  it('parses valid period values', () => {
    expect(parsePeriodParam('1')).toBe(1);
    expect(parsePeriodParam('3')).toBe(3);
    expect(parsePeriodParam('6')).toBe(6);
    expect(parsePeriodParam('12')).toBe(12);
  });

  it('falls back to 1 for invalid values', () => {
    expect(parsePeriodParam('0')).toBe(1);
    expect(parsePeriodParam('7')).toBe(1);
    expect(parsePeriodParam(undefined)).toBe(1);
    expect(parsePeriodParam('foo')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildHeatmapFromAggregates
// ---------------------------------------------------------------------------

describe('buildHeatmapFromAggregates', () => {
  const months = ['2026-01', '2026-02'];
  const genres = ['practical', 'business', 'self_help'];

  it('maps aggregates to correct cells', () => {
    const aggs = [
      { ym: '2026-01', genre: 'practical', royalty_jpy: 10000 },
      { ym: '2026-02', genre: 'business', royalty_jpy: 5000 },
    ];
    const matrix = buildHeatmapFromAggregates(aggs, months, genres);
    const p01 = matrix.cells.find((c) => c.genre === 'practical' && c.ym === '2026-01');
    const b02 = matrix.cells.find((c) => c.genre === 'business' && c.ym === '2026-02');
    expect(p01?.value).toBe(10000);
    expect(b02?.value).toBe(5000);
  });

  it('maxValue is the highest single cell value', () => {
    const aggs = [
      { ym: '2026-01', genre: 'practical', royalty_jpy: 20000 },
      { ym: '2026-02', genre: 'business', royalty_jpy: 8000 },
    ];
    const matrix = buildHeatmapFromAggregates(aggs, months, genres);
    expect(matrix.maxValue).toBe(20000);
  });

  it('handles empty aggregates gracefully', () => {
    const matrix = buildHeatmapFromAggregates([], months, genres);
    expect(matrix.maxValue).toBe(0);
    expect(matrix.cells.every((c) => c.value === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildTrendChartFromAggregates
// ---------------------------------------------------------------------------

describe('buildTrendChartFromAggregates', () => {
  const months = ['2026-01', '2026-02', '2026-03'];

  it('maps genre aggregates to correct month buckets', () => {
    const aggs = [
      { ym: '2026-01', genre: 'practical', royalty_jpy: 5000 },
      { ym: '2026-01', genre: 'business', royalty_jpy: 3000 },
      { ym: '2026-02', genre: 'self_help', royalty_jpy: 2000 },
    ];
    const data = buildTrendChartFromAggregates(aggs, months);
    const jan = data.find((d) => d.ym === '2026-01')!;
    expect(jan.practical).toBe(5000);
    expect(jan.business).toBe(3000);
    expect(jan.self_help).toBe(0);

    const feb = data.find((d) => d.ym === '2026-02')!;
    expect(feb.self_help).toBe(2000);
    expect(feb.practical).toBe(0);
  });

  it('total = sum of all genres', () => {
    const aggs = [
      { ym: '2026-01', genre: 'practical', royalty_jpy: 1000 },
      { ym: '2026-01', genre: 'business', royalty_jpy: 2000 },
      { ym: '2026-01', genre: 'self_help', royalty_jpy: 3000 },
    ];
    const data = buildTrendChartFromAggregates(aggs, months);
    const jan = data.find((d) => d.ym === '2026-01')!;
    expect(jan.total).toBe(6000);
  });

  it('returns zeros for months with no data', () => {
    const data = buildTrendChartFromAggregates([], months);
    for (const d of data) {
      expect(d.practical).toBe(0);
      expect(d.business).toBe(0);
      expect(d.self_help).toBe(0);
      expect(d.total).toBe(0);
    }
  });

  it('preserves all months even if empty', () => {
    const data = buildTrendChartFromAggregates([], months);
    expect(data).toHaveLength(3);
    expect(data.map((d) => d.ym)).toEqual(months);
  });
});

