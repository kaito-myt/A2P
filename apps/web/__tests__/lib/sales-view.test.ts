/**
 * sales-view.ts ユニットテスト (T-08-06).
 *
 * 検証:
 *  1. serializeBookSelectorItems: ASIN あり/なし のラベル生成
 *  2. serializeSalesHistory: Decimal-like オブジェクト → number 変換
 *  3. serializeSalesHistory: null avg_stars の扱い
 *  4. buildSalesTemplateCsv: ヘッダ + サンプル行を含む
 *  5. buildSalesTemplateCsvFilename: ファイル名形式
 */
import { describe, expect, it } from 'vitest';

import {
  serializeBookSelectorItems,
  serializeSalesHistory,
  buildSalesTemplateCsv,
  buildSalesTemplateCsvFilename,
} from '../../lib/sales-view';

// ---------------------------------------------------------------------------
// serializeBookSelectorItems
// ---------------------------------------------------------------------------

describe('serializeBookSelectorItems', () => {
  it('ASIN あり: label に ASIN を付与する', () => {
    const items = serializeBookSelectorItems([
      { id: 'book_1', title: '副業完全攻略ガイド', asin: 'B0XXXXXXXX' },
    ]);
    expect(items[0]!.label).toBe('副業完全攻略ガイド (B0XXXXXXXX)');
  });

  it('ASIN なし: label はタイトルのみ', () => {
    const items = serializeBookSelectorItems([
      { id: 'book_2', title: 'AI 活用術', asin: null },
    ]);
    expect(items[0]!.label).toBe('AI 活用術');
  });

  it('複数件返す', () => {
    const raw = [
      { id: 'a', title: 'Title A', asin: 'B0AAA' },
      { id: 'b', title: 'Title B', asin: null },
    ];
    const result = serializeBookSelectorItems(raw);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('a');
    expect(result[1]!.id).toBe('b');
  });

  it('空配列を受け取ると空配列を返す', () => {
    expect(serializeBookSelectorItems([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// serializeSalesHistory
// ---------------------------------------------------------------------------

describe('serializeSalesHistory', () => {
  const book = { id: 'book_1', title: '副業完全攻略ガイド' };

  it('Decimal-like オブジェクト (toNumber()) を number に変換する', () => {
    const records = [
      {
        year_month: '2026-05',
        royalty_jpy: 1500,
        review_count: 12,
        avg_stars: { toNumber: () => 4.3 },
      },
    ];
    const result = serializeSalesHistory(book, records);
    expect(result.rows[0]!.avg_stars).toBe(4.3);
  });

  it('avg_stars が null → null のまま', () => {
    const records = [
      {
        year_month: '2026-04',
        royalty_jpy: 800,
        review_count: 5,
        avg_stars: null,
      },
    ];
    const result = serializeSalesHistory(book, records);
    expect(result.rows[0]!.avg_stars).toBeNull();
  });

  it('avg_stars が number → number のまま', () => {
    const records = [
      {
        year_month: '2026-03',
        royalty_jpy: 600,
        review_count: 3,
        avg_stars: 3.8,
      },
    ];
    const result = serializeSalesHistory(book, records);
    expect(result.rows[0]!.avg_stars).toBe(3.8);
  });

  it('book_id / book_title を正しく返す', () => {
    const result = serializeSalesHistory(book, []);
    expect(result.book_id).toBe('book_1');
    expect(result.book_title).toBe('副業完全攻略ガイド');
    expect(result.rows).toHaveLength(0);
  });

  it('royalty_jpy / review_count をそのまま返す', () => {
    const records = [
      { year_month: '2026-05', royalty_jpy: 2000, review_count: 20, avg_stars: null },
    ];
    const result = serializeSalesHistory(book, records);
    expect(result.rows[0]!.royalty_jpy).toBe(2000);
    expect(result.rows[0]!.review_count).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// buildSalesTemplateCsv / buildSalesTemplateCsvFilename
// ---------------------------------------------------------------------------

describe('buildSalesTemplateCsv', () => {
  it('正しいヘッダ行を含む', () => {
    const csv = buildSalesTemplateCsv();
    const lines = csv.split('\n').filter((l) => l.trim() !== '');
    expect(lines[0]).toBe('asin,year_month,royalty_jpy,review_count,avg_stars,bsr');
  });

  it('サンプル行を含む (ヘッダ行以外に 1 行以上)', () => {
    const csv = buildSalesTemplateCsv();
    const lines = csv.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('サンプル行は 6 列', () => {
    const csv = buildSalesTemplateCsv();
    const lines = csv.split('\n').filter((l) => l.trim() !== '');
    const sampleRow = lines[1]!.split(',');
    expect(sampleRow).toHaveLength(6);
  });
});

describe('buildSalesTemplateCsvFilename', () => {
  it('.csv で終わる', () => {
    expect(buildSalesTemplateCsvFilename()).toMatch(/\.csv$/);
  });
});
