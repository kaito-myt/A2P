/**
 * F-056 — KDP レポート集計/取込の単体テスト。実ファイルの列名・値で検証。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  aggregateKdpRoyalties,
  importKdpRecordsCore,
  type KdpImportDeps,
} from '../../lib/kdp-report-core';

function row(over: Record<string, unknown>) {
  return {
    ロイヤリティ発生日: '2026-07-02',
    タイトル: '最強競馬予想術',
    ASIN: 'B0FVL9HDBB',
    ロイヤリティ: 279,
    通貨: 'JPY',
    ...over,
  };
}

describe('aggregateKdpRoyalties', () => {
  it('実ファイルの1行を ASIN×年月で集計する', () => {
    const agg = aggregateKdpRoyalties([row({})]);
    expect(agg.records).toEqual([
      { asin: 'B0FVL9HDBB', title: '最強競馬予想術', year_month: '2026-07', royalty_jpy: 279 },
    ]);
    expect(agg.parsedRows).toBe(1);
  });

  it('同一 ASIN×年月の複数行 (マーケットプレイス別) を合算', () => {
    const agg = aggregateKdpRoyalties([row({ ロイヤリティ: 279 }), row({ ロイヤリティ: 100 })]);
    expect(agg.records[0]!.royalty_jpy).toBe(379);
    expect(agg.records).toHaveLength(1);
  });

  it('非 JPY 通貨は除外して件数を返す', () => {
    const agg = aggregateKdpRoyalties([row({ 通貨: 'USD', ロイヤリティ: 5 }), row({})]);
    expect(agg.skippedNonJpy).toBe(1);
    expect(agg.records).toHaveLength(1);
  });

  it('別月は別レコードになる', () => {
    const agg = aggregateKdpRoyalties([row({}), row({ ロイヤリティ発生日: '2026-06-15', ロイヤリティ: 500 })]);
    expect(agg.records.map((r) => r.year_month).sort()).toEqual(['2026-06', '2026-07']);
  });

  it('ASIN/日付欠損は invalid として除外', () => {
    const agg = aggregateKdpRoyalties([row({ ASIN: '' }), row({ ロイヤリティ発生日: '' })]);
    expect(agg.skippedInvalid).toBe(2);
    expect(agg.records).toHaveLength(0);
  });
});

describe('importKdpRecordsCore', () => {
  function deps(bookByAsin: Record<string, { id: string; title: string }>, existing = new Set<string>()) {
    const upsert = vi.fn((_a: { create: Record<string, unknown>; update: Record<string, unknown>; where: unknown }) =>
      Promise.resolve({}),
    );
    const d: KdpImportDeps = {
      bookRepo: {
        findFirst: vi.fn(async ({ where }: { where: { asin?: string; title?: string } }) => {
          if (where.asin && bookByAsin[where.asin]) return bookByAsin[where.asin]!;
          if (where.title) {
            const byTitle = Object.values(bookByAsin).find((b) => b.title === where.title);
            if (byTitle) return byTitle;
          }
          return null;
        }),
      },
      salesRecordRepo: {
        findUnique: vi.fn(async ({ where }: { where: { book_id_year_month: { book_id: string; year_month: string } } }) =>
          existing.has(`${where.book_id_year_month.book_id}/${where.book_id_year_month.year_month}`) ? { id: 'x' } : null,
        ),
        upsert,
      },
    };
    return { d, upsert };
  }

  it('ASIN が一致する書籍に SalesRecord を upsert', async () => {
    const { d, upsert } = deps({ B0FVL9HDBB: { id: 'book1', title: '最強競馬予想術' } });
    const agg = aggregateKdpRoyalties([row({})]);
    const res = await importKdpRecordsCore(agg, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.inserted).toBe(1);
      expect(res.data.notFound).toHaveLength(0);
    }
    expect(upsert.mock.calls[0]![0].create).toMatchObject({ book_id: 'book1', year_month: '2026-07', royalty_jpy: 279, source: 'manual' });
  });

  it('ASIN が無くても主題(コロン前)のタイトル一致で解決する', async () => {
    const { d } = deps({ 'no-asin': { id: 'book9', title: '最強競馬予想術' } });
    const agg = aggregateKdpRoyalties([
      row({ ASIN: 'B0UNKNOWN', タイトル: '最強競馬予想術: データ×AI×感性 …' }),
    ]);
    const res = await importKdpRecordsCore(agg, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.inserted).toBe(1);
      expect(res.data.notFound).toHaveLength(0);
    }
  });

  it('ASIN 未登録は notFound に入る', async () => {
    const { d } = deps({});
    const agg = aggregateKdpRoyalties([row({})]);
    const res = await importKdpRecordsCore(agg, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.inserted).toBe(0);
      expect(res.data.notFound[0]!.asin).toBe('B0FVL9HDBB');
    }
  });

  it('createMissing 時は未登録を外部書籍として作成し取り込む', async () => {
    const { d } = deps({});
    let created = 0;
    d.createExternalBook = vi.fn(async () => { created += 1; return { id: `ext-${created}` }; });
    const agg = aggregateKdpRoyalties([row({})]);
    const res = await importKdpRecordsCore(agg, d, { createMissing: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.createdExternal).toBe(1);
      expect(res.data.inserted).toBe(1);
      expect(res.data.notFound).toHaveLength(0);
    }
  });

  it('createMissing でも createExternalBook 未指定なら notFound', async () => {
    const { d } = deps({});
    const res = await importKdpRecordsCore(aggregateKdpRoyalties([row({})]), d, { createMissing: true });
    if (res.ok) expect(res.data.notFound).toHaveLength(1);
  });

  it('既存レコードは updated としてカウント', async () => {
    const { d } = deps({ B0FVL9HDBB: { id: 'book1', title: 't' } }, new Set(['book1/2026-07']));
    const res = await importKdpRecordsCore(aggregateKdpRoyalties([row({})]), d);
    if (res.ok) expect(res.data.updated).toBe(1);
  });
});
