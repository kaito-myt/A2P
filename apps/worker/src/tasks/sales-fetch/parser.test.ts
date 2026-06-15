import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseAmazonPublicPage,
  parseKdpSalesHtml,
  type KdpPublicPageData,
  type KdpSalesRow,
} from './parser.js';

// ---------------------------------------------------------------------------
// fixture ローダ
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(__dirname, '../../../../../tests/fixtures/kdp-report');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
}

// ---------------------------------------------------------------------------
// parseKdpSalesHtml
// ---------------------------------------------------------------------------

describe('parseKdpSalesHtml', () => {
  it('sample-report.html から KdpSalesRow[] が返る', () => {
    const html = loadFixture('sample-report.html');
    const rows: KdpSalesRow[] = parseKdpSalesHtml(html, '2026-05');

    expect(rows.length).toBeGreaterThanOrEqual(1);

    for (const row of rows) {
      expect(row.year_month).toBe('2026-05');
      expect(row.asin).toMatch(/^B0[A-Z0-9]{8}$/i);
      expect(row.royalty_jpy).toBeGreaterThanOrEqual(0);
      expect(row.units_sold).toBeGreaterThanOrEqual(0);
      expect(row.review_count).toBeGreaterThanOrEqual(0);
      if (row.avg_stars !== null) {
        expect(row.avg_stars).toBeGreaterThanOrEqual(0);
        expect(row.avg_stars).toBeLessThanOrEqual(5);
      }
    }
  });

  it('sample-report.html の最初の行が B0TESTAA01 / royalty_jpy=12500 / units=42', () => {
    const html = loadFixture('sample-report.html');
    const rows = parseKdpSalesHtml(html, '2026-05');

    const rowA = rows.find((r) => r.asin === 'B0TESTAA01');
    expect(rowA).toBeDefined();
    expect(rowA!.royalty_jpy).toBe(12500);
    expect(rowA!.units_sold).toBe(42);
    expect(rowA!.review_count).toBe(15);
    expect(rowA!.avg_stars).toBe(4.3);
  });

  it('sample-report.html の 2 行目 B0TESTBB02 が正しく取れる', () => {
    const html = loadFixture('sample-report.html');
    const rows = parseKdpSalesHtml(html, '2026-05');

    const rowB = rows.find((r) => r.asin === 'B0TESTBB02');
    expect(rowB).toBeDefined();
    expect(rowB!.royalty_jpy).toBe(3200);
    expect(rowB!.units_sold).toBe(7);
    expect(rowB!.review_count).toBe(3);
    expect(rowB!.avg_stars).toBe(4.7);
  });

  it('sample-report.html の 3 行目 B0TESTCC03 が royalty_jpy=0 / avg_stars=null', () => {
    const html = loadFixture('sample-report.html');
    const rows = parseKdpSalesHtml(html, '2026-05');

    const rowC = rows.find((r) => r.asin === 'B0TESTCC03');
    expect(rowC).toBeDefined();
    expect(rowC!.royalty_jpy).toBe(0);
    expect(rowC!.units_sold).toBe(0);
    expect(rowC!.avg_stars).toBeNull();
  });

  it('empty-report.html では空配列を返す', () => {
    const html = loadFixture('empty-report.html');
    const rows = parseKdpSalesHtml(html, '2026-05');

    expect(rows).toEqual([]);
  });

  it('壊れた HTML でも throw しない', () => {
    expect(() => parseKdpSalesHtml('<html><body><br unclosed', '2026-05')).not.toThrow();
    expect(() => parseKdpSalesHtml('', '2026-05')).not.toThrow();
    expect(() => parseKdpSalesHtml('not html at all ####', '2026-05')).not.toThrow();
  });

  it('壊れた HTML は空配列を返す（データなし）', () => {
    const result = parseKdpSalesHtml('', '2026-05');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('year_month は引数で渡した値が各行に反映される', () => {
    const html = loadFixture('sample-report.html');
    const rows = parseKdpSalesHtml(html, '2025-12');

    for (const row of rows) {
      expect(row.year_month).toBe('2025-12');
    }
  });
});

// ---------------------------------------------------------------------------
// parseAmazonPublicPage
// ---------------------------------------------------------------------------

describe('parseAmazonPublicPage', () => {
  it('amazon-product-page.html から { bsr, avg_stars, review_count } を返す', () => {
    const html = loadFixture('amazon-product-page.html');
    const data: KdpPublicPageData = parseAmazonPublicPage(html);

    expect(data.avg_stars).toBe(4.3);
    expect(data.review_count).toBe(15);
    expect(data.bsr).toBe(2345);
  });

  it('bsr は正の整数', () => {
    const html = loadFixture('amazon-product-page.html');
    const data = parseAmazonPublicPage(html);

    expect(typeof data.bsr).toBe('number');
    expect(data.bsr!).toBeGreaterThan(0);
  });

  it('avg_stars は 0 以上 5 以下', () => {
    const html = loadFixture('amazon-product-page.html');
    const data = parseAmazonPublicPage(html);

    if (data.avg_stars !== null) {
      expect(data.avg_stars).toBeGreaterThanOrEqual(0);
      expect(data.avg_stars).toBeLessThanOrEqual(5);
    }
  });

  it('壊れた HTML でも throw しない', () => {
    expect(() => parseAmazonPublicPage('')).not.toThrow();
    expect(() => parseAmazonPublicPage('<html><body>no data')).not.toThrow();
    expect(() => parseAmazonPublicPage('###garbage###')).not.toThrow();
  });

  it('壊れた HTML は null フィールドで返す', () => {
    const data = parseAmazonPublicPage('');
    expect(data.bsr).toBeNull();
    expect(data.avg_stars).toBeNull();
    expect(data.review_count).toBeNull();
  });
});
