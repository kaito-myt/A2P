import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import { normalizeKdpRows, normalizeCurrency } from '@/lib/kdp-sales/normalize';
import { parseKdpReportWorkbook } from '@/lib/kdp-sales/parse';

// ---------------------------------------------------------------------------
// normalizeKdpRows
// ---------------------------------------------------------------------------

describe('normalizeKdpRows', () => {
  it('同一 ASIN をマーケットプレイス跨ぎで合算する', () => {
    const res = normalizeKdpRows([
      { asin: 'B00A', currency: 'JPY', units_sold: 3, kenp_read: 1000, royalty: 900 },
      { asin: 'B00A', currency: 'JPY', units_sold: 2, kenp_read: 500, royalty: 600 },
      { asin: 'B00B', currency: 'JPY', units_sold: 1, kenp_read: 0, royalty: 300 },
    ]);
    const a = res.rows.find((r) => r.asin === 'B00A')!;
    expect(a.units_sold).toBe(5);
    expect(a.kenp_read).toBe(1500);
    expect(a.royalty_jpy).toBe(1500);
    expect(res.totals).toEqual({ royalty_jpy: 1800, units_sold: 6, kenp_read: 1500 });
  });

  it('USD は fx で円換算し、未対応通貨は royalty を除外して計上 (units は残す)', () => {
    const res = normalizeKdpRows(
      [
        { asin: 'B00A', currency: 'USD', units_sold: 1, kenp_read: 0, royalty: 2 },
        { asin: 'B00A', currency: 'EUR', units_sold: 4, kenp_read: 0, royalty: 5 },
      ],
      { fxToJpy: { USD: 150 } },
    );
    const a = res.rows[0]!;
    // USD 2 * 150 = 300、EUR は換算不可 → royalty 除外だが units は 1+4=5
    expect(a.royalty_jpy).toBe(300);
    expect(a.units_sold).toBe(5);
    expect(res.unconvertedCurrencies).toEqual({ EUR: 1 });
  });

  it('royalty 降順で並ぶ', () => {
    const res = normalizeKdpRows([
      { asin: 'LOW', currency: 'JPY', units_sold: 0, kenp_read: 0, royalty: 100 },
      { asin: 'HIGH', currency: 'JPY', units_sold: 0, kenp_read: 0, royalty: 999 },
    ]);
    expect(res.rows.map((r) => r.asin)).toEqual(['HIGH', 'LOW']);
  });
});

describe('normalizeCurrency', () => {
  it('¥ / 円 / 空 は JPY', () => {
    expect(normalizeCurrency('¥')).toBe('JPY');
    expect(normalizeCurrency('円')).toBe('JPY');
    expect(normalizeCurrency('')).toBe('JPY');
    expect(normalizeCurrency(null)).toBe('JPY');
    expect(normalizeCurrency('usd')).toBe('USD');
  });
});

// ---------------------------------------------------------------------------
// parseKdpReportWorkbook
// ---------------------------------------------------------------------------

function makeWorkbook(aoa: unknown[][], sheetName = 'Sheet1'): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('parseKdpReportWorkbook', () => {
  it('英語ヘッダの KDP レポートを抽出する', () => {
    const buf = makeWorkbook([
      ['Some KDP export note'],
      ['Title', 'ASIN', 'Marketplace', 'Units Sold', 'KENP Read', 'Royalty', 'Currency'],
      ['本A', 'B012345678', 'Amazon.co.jp', '5', '1200', '1500', 'JPY'],
      ['本B', 'B0ABCDEF12', 'Amazon.com', '2', '0', '3.5', 'USD'],
      ['合計', '', '', '7', '1200', '', ''], // ASIN でない行は無視
    ]);
    const res = parseKdpReportWorkbook(buf);
    expect(res.sheetsParsed).toContain('Sheet1');
    expect(res.rows).toHaveLength(2);
    const a = res.rows.find((r) => r.asin === 'B012345678')!;
    expect(a.units_sold).toBe(5);
    expect(a.kenp_read).toBe(1200);
    expect(a.royalty).toBe(1500);
    expect(a.currency).toBe('JPY');
    const b = res.rows.find((r) => r.asin === 'B0ABCDEF12')!;
    expect(b.royalty).toBe(3.5);
    expect(b.currency).toBe('USD');
  });

  it('日本語ヘッダ + カンマ/¥ 付き数値を抽出する', () => {
    const buf = makeWorkbook([
      ['タイトル', 'ASIN', '販売部数', 'ロイヤリティ', '通貨'],
      ['本C', 'B0JPTEST01', '1,234', '¥12,345', '円'],
    ]);
    const res = parseKdpReportWorkbook(buf);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.units_sold).toBe(1234);
    expect(res.rows[0]!.royalty).toBe(12345);
  });

  it('パース→正規化の統合: 円換算合算', () => {
    const buf = makeWorkbook([
      ['ASIN', 'Units Sold', 'Royalty', 'Currency'],
      ['B012345678', '5', '1500', 'JPY'],
      ['B012345678', '1', '2', 'USD'],
    ]);
    const parsed = parseKdpReportWorkbook(buf);
    const norm = normalizeKdpRows(parsed.rows, { fxToJpy: { USD: 150 } });
    expect(norm.rows).toHaveLength(1);
    expect(norm.rows[0]!.units_sold).toBe(6);
    expect(norm.rows[0]!.royalty_jpy).toBe(1500 + 300);
  });

  it('ヘッダ検出できないシートは空 (throw しない)', () => {
    const buf = makeWorkbook([['foo', 'bar'], ['1', '2']]);
    const res = parseKdpReportWorkbook(buf);
    expect(res.rows).toEqual([]);
    expect(res.sheetsParsed).toEqual([]);
  });
});
