import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import { normalizeKdpRows, normalizeCurrency } from '@/lib/kdp-sales/normalize';
import { parseKdpReportWorkbook, parseMonth } from '@/lib/kdp-sales/parse';

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

  it('targetMonth 指定で対象月のみ集約する', () => {
    const res = normalizeKdpRows(
      [
        { asin: 'B00A', month: '2026-06', currency: 'JPY', units_sold: 1, kenp_read: 100, royalty: 200 },
        { asin: 'B00A', month: '2026-05', currency: 'JPY', units_sold: 9, kenp_read: 900, royalty: 999 },
      ],
      { targetMonth: '2026-06' },
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.units_sold).toBe(1);
    expect(res.rows[0]!.royalty_jpy).toBe(200);
  });

  it('KENP ロイヤリティ明細 (kind=kenp) を有料販売と合算する', () => {
    const res = normalizeKdpRows(
      [
        { asin: 'B00A', month: '2026-06', currency: 'JPY', units_sold: 1, kenp_read: 0, royalty: 279, royalty_kind: 'paid' },
        { asin: 'B00A', month: '2026-06', currency: 'JPY', units_sold: 0, kenp_read: 145, royalty: 54, royalty_kind: 'kenp' },
      ],
      { targetMonth: '2026-06' },
    );
    const a = res.rows[0]!;
    expect(a.royalty_jpy).toBe(333); // 279 + 54
    expect(a.kenp_read).toBe(145);
    expect(res.allocatedKenpRoyaltyJpy).toBe(0); // 明細金額があるので按分なし
  });

  it('KENP 金額が無い(Estimator)場合、概要合計から KENP ページ数で按分する', () => {
    const res = normalizeKdpRows(
      [
        // 有料販売 0、KENP 金額列なし (royalty=0)
        { asin: 'B00A', month: '2026-06', currency: 'JPY', units_sold: 0, kenp_read: 300, royalty: 0, royalty_kind: 'kenp' },
        { asin: 'B00B', month: '2026-06', currency: 'JPY', units_sold: 0, kenp_read: 100, royalty: 0, royalty_kind: 'kenp' },
      ],
      {
        targetMonth: '2026-06',
        monthlySummaries: [{ month: '2026-06', kenp_read: 400, royalty_jpy: 200 }],
      },
    );
    // pool 200 を 300:100 = 3:1 で按分 → 150 / 50
    const a = res.rows.find((r) => r.asin === 'B00A')!;
    const b = res.rows.find((r) => r.asin === 'B00B')!;
    expect(a.royalty_jpy).toBe(150);
    expect(b.royalty_jpy).toBe(50);
    expect(res.allocatedKenpRoyaltyJpy).toBe(200);
    expect(res.totals.royalty_jpy).toBe(200); // 按分で合計ズレなし
  });

  it('按分は 概要合計 − 有料販売合計 を原資にする', () => {
    const res = normalizeKdpRows(
      [
        { asin: 'B00A', month: '2026-07', currency: 'JPY', units_sold: 1, kenp_read: 0, royalty: 279, royalty_kind: 'paid' },
        { asin: 'B00A', month: '2026-07', currency: 'JPY', units_sold: 0, kenp_read: 555, royalty: 0, royalty_kind: 'kenp' },
      ],
      {
        targetMonth: '2026-07',
        // 当月は概要合計=有料販売のみ(279) → KENP 原資 0 → 按分なし
        monthlySummaries: [{ month: '2026-07', kenp_read: 555, royalty_jpy: 279 }],
      },
    );
    expect(res.rows[0]!.royalty_jpy).toBe(279);
    expect(res.allocatedKenpRoyaltyJpy).toBe(0);
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

describe('parseMonth', () => {
  it('各種表記から YYYY-MM を取り出す', () => {
    expect(parseMonth('2026-07')).toBe('2026-07');
    expect(parseMonth('2026-07-01')).toBe('2026-07');
    expect(parseMonth('2026/7')).toBe('2026-07');
    expect(parseMonth('2026年7月')).toBe('2026-07');
    expect(parseMonth('6月 2026')).toBe('2026-06');
    expect(parseMonth('July 2026')).toBe('2026-07');
    expect(parseMonth('')).toBeNull();
    expect(parseMonth('タイトル')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseKdpReportWorkbook
// ---------------------------------------------------------------------------

function makeWorkbook(sheets: { name: string; aoa: unknown[][] }[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('parseKdpReportWorkbook', () => {
  it('英語ヘッダの単一シート(combined)レポートを抽出する', () => {
    const buf = makeWorkbook([
      {
        name: 'Sheet1',
        aoa: [
          ['Some KDP export note'],
          ['Title', 'ASIN', 'Marketplace', 'Units Sold', 'KENP Read', 'Royalty', 'Currency'],
          ['本A', 'B012345678', 'Amazon.co.jp', '5', '1200', '1500', 'JPY'],
          ['本B', 'B0ABCDEF12', 'Amazon.com', '2', '0', '3.5', 'USD'],
          ['合計', '', '', '7', '1200', '', ''], // ASIN でない行は無視
        ],
      },
    ]);
    const res = parseKdpReportWorkbook(buf);
    expect(res.sheetsParsed).toContain('Sheet1');
    expect(res.reportKind).toBe('confirmed');
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
      {
        name: 'Sheet1',
        aoa: [
          ['タイトル', 'ASIN', '販売部数', 'ロイヤリティ', '通貨'],
          ['本C', 'B0JPTEST01', '1,234', '¥12,345', '円'],
        ],
      },
    ]);
    const res = parseKdpReportWorkbook(buf);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.units_sold).toBe(1234);
    expect(res.rows[0]!.royalty).toBe(12345);
  });

  it('「ロイヤリティ発生日」列を金額列と誤検出しない (BUG1 回帰)', () => {
    const buf = makeWorkbook([
      {
        name: '電子書籍のロイヤリティ',
        aoa: [
          ['ロイヤリティ発生日', 'タイトル', '著者名', 'ASIN', 'マーケットプレイス', '注文数', '払い戻し数', '実質注文数', 'ロイヤリティの種類', 'コンテンツ区分', '通貨', '平均希望小売価格 (税別)', '平均販売価格 (税別)', '平均ファイルサイズ（MB）', '平均配信コスト', 'ロイヤリティ'],
          ['2026-07', '最強競馬予想術', '宮田海斗', 'B0FVL9HDBB', 'Amazon.co.jp', 1, 0, 1, '70%', '標準', 'JPY', 400, 400, 0.22, 1, 279],
        ],
      },
    ]);
    const res = parseKdpReportWorkbook(buf);
    expect(res.rows).toHaveLength(1);
    const r = res.rows[0]!;
    expect(r.royalty).toBe(279); // 日付(0)ではなく金額列(279)
    expect(r.units_sold).toBe(1); // 実質注文数を優先
    expect(r.month).toBe('2026-07');
    expect(r.royalty_kind).toBe('paid');
  });

  it('月別ロイヤリティ明細形式 (販売期間メタ行 + 既読KENPCの金額列) を確定値として読む', () => {
    const buf = makeWorkbook([
      {
        name: '電子書籍のロイヤリティ',
        aoa: [
          ['販売期間', '6月 2026'],
          ['タイトル', '著者', 'ASIN', 'マーケットプレイス', '注文数', '払い戻し数', '実質注文数', 'ロイヤリティの種類', 'コンテンツ区分', '通貨', '平均希望小売価格 (税別)', '平均販売価格 (税別)', '平均ファイルサイズ（MB）', '平均配信コスト', 'ロイヤリティ'],
          // 6月は有料販売なし → データ行なし
        ],
      },
      {
        name: '既読 KENPC',
        aoa: [
          ['販売期間', '6月 2026'],
          ['タイトル', '著者', 'ASIN', 'マーケットプレイス', '既読 KENP (Kindle Edition Normalized Pages)', 'ロイヤリティ', '通貨'],
          ['最強競馬予想術', '宮田海斗', 'B0FVL9HDBB', 'Amazon.co.jp', 145, 54.01, 'JPY'],
          ['福島競馬場 完全攻略バイブル', '競馬の楽しみ方研究会', 'B0H6MNVSY3', 'Amazon.co.jp', 242, 90.14, 'JPY'],
        ],
      },
    ]);
    const res = parseKdpReportWorkbook(buf);
    expect(res.reportKind).toBe('confirmed');
    expect(res.months).toEqual(['2026-06']);
    const a = res.rows.find((r) => r.asin === 'B0FVL9HDBB')!;
    expect(a.month).toBe('2026-06');
    expect(a.kenp_read).toBe(145);
    expect(a.royalty).toBe(54.01);
    expect(a.royalty_kind).toBe('kenp');

    // 正規化: 6月の確定 KENP ロイヤリティが円で入る
    const norm = normalizeKdpRows(res.rows, { targetMonth: '2026-06', monthlySummaries: res.monthlySummaries });
    const na = norm.rows.find((r) => r.asin === 'B0FVL9HDBB')!;
    expect(na.royalty_jpy).toBe(54); // round(54.01)
    expect(norm.allocatedKenpRoyaltyJpy).toBe(0);
  });

  it('Estimator形式 (概要シートあり) は見込みとして種別判定される', () => {
    const buf = makeWorkbook([
      {
        name: '概要',
        aoa: [
          ['日付', '実質注文数 (電子書籍)', '既読 KENP (Kindle Edition Normalized Pages)', 'ロイヤリティ (USD)', 'ロイヤリティ (JPY)'],
          ['6月 2026', 0, 400, 0, 200],
        ],
      },
      {
        name: '既読 KENPC',
        aoa: [
          ['日付', 'タイトル', '著者名', 'ASIN', 'マーケットプレイス', '既読 KENP (Kindle Edition Normalized Pages)'],
          ['2026-06-01', '本A', '著者', 'B00A000001', 'Amazon.co.jp', 300],
          ['2026-06-01', '本B', '著者', 'B00B000002', 'Amazon.co.jp', 100],
        ],
      },
    ]);
    const res = parseKdpReportWorkbook(buf);
    expect(res.reportKind).toBe('estimate');
    expect(res.monthlySummaries).toEqual([{ month: '2026-06', kenp_read: 400, royalty_jpy: 200 }]);

    const norm = normalizeKdpRows(res.rows, { targetMonth: '2026-06', monthlySummaries: res.monthlySummaries });
    const a = norm.rows.find((r) => r.asin === 'B00A000001')!;
    const b = norm.rows.find((r) => r.asin === 'B00B000002')!;
    expect(a.royalty_jpy).toBe(150); // 200 を 300:100 で按分
    expect(b.royalty_jpy).toBe(50);
    expect(norm.allocatedKenpRoyaltyJpy).toBe(200);
  });

  it('ヘッダ検出できないシートは空 (throw しない)', () => {
    const buf = makeWorkbook([{ name: 'Sheet1', aoa: [['foo', 'bar'], ['1', '2']] }]);
    const res = parseKdpReportWorkbook(buf);
    expect(res.rows).toEqual([]);
    expect(res.sheetsParsed).toEqual([]);
  });
});
