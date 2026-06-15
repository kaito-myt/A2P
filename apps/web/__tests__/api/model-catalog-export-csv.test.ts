/**
 * model-catalog-csv.ts のユニットテスト (T-02-10 / F-025).
 *
 * 検証:
 *  - ヘッダー行は spec 通り 8 列
 *  - UTF-8 BOM が先頭に付く
 *  - 改行 / カンマ / `"` を含むフィールドが RFC 4180 でクオート + エスケープされる
 *  - image_price が null の場合は空セル
 *  - Date を渡しても ISO 文字列化される
 *  - filename が UTC 日付ベースの `model-catalog-YYYY-MM-DD.csv`
 *
 * Route Handler 本体 (route.ts) は Prisma + auth() に依存するため統合層。
 * CSV 生成ロジック自体は本ファイルで網羅する。
 */
import { describe, expect, it } from 'vitest';

import {
  buildCsvFilename,
  buildModelCatalogCsv,
  type ModelCatalogCsvRow,
} from '../../lib/model-catalog-csv';

const BOM = '﻿';

function row(overrides: Partial<ModelCatalogCsvRow> = {}): ModelCatalogCsvRow {
  return {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    input_price_per_mtok_usd: '15.000000',
    output_price_per_mtok_usd: '75.000000',
    image_price_per_image_usd: null,
    fx_rate_usd_jpy: '150.0000',
    fetched_at: '2026-05-20T06:00:00.000Z',
    source: 'anthropic_pricing_page_v1',
    ...overrides,
  };
}

describe('buildModelCatalogCsv', () => {
  it('先頭に UTF-8 BOM が付く', () => {
    const csv = buildModelCatalogCsv([]);
    expect(csv.startsWith(BOM)).toBe(true);
  });

  it('ヘッダー行は固定 8 列', () => {
    const csv = buildModelCatalogCsv([]);
    const firstLine = csv.replace(BOM, '').split('\r\n')[0];
    expect(firstLine).toBe(
      'provider,model,input_price_usd,output_price_usd,image_price_usd,fx_rate,fetched_at,source',
    );
  });

  it('空配列でもヘッダーのみで終端 CRLF が付く', () => {
    const csv = buildModelCatalogCsv([]);
    expect(csv).toBe(`${BOM}provider,model,input_price_usd,output_price_usd,image_price_usd,fx_rate,fetched_at,source\r\n`);
  });

  it('単一行の正常シリアライズ', () => {
    const csv = buildModelCatalogCsv([row()]);
    const lines = csv.replace(BOM, '').split('\r\n');
    expect(lines[1]).toBe(
      'anthropic,claude-opus-4-7,15.000000,75.000000,,150.0000,2026-05-20T06:00:00.000Z,anthropic_pricing_page_v1',
    );
    expect(lines[2]).toBe(''); // 末尾 CRLF
  });

  it('image_price_per_image_usd が数値なら数値、null なら空セル', () => {
    const csv = buildModelCatalogCsv([
      row({ provider: 'openai', model: 'gpt-image-1', image_price_per_image_usd: '0.040000' }),
      row({ provider: 'anthropic', model: 'claude-opus-4-7', image_price_per_image_usd: null }),
    ]);
    const lines = csv.replace(BOM, '').split('\r\n');
    expect(lines[1]).toContain(',0.040000,');
    // 空セル: 連続カンマで判定
    expect(lines[2]).toContain(',,');
  });

  it('Date オブジェクトを fetched_at に渡すと ISO 文字列化される', () => {
    const d = new Date('2026-05-20T06:00:00.000Z');
    const csv = buildModelCatalogCsv([row({ fetched_at: d })]);
    expect(csv).toContain('2026-05-20T06:00:00.000Z');
  });

  it('カンマを含む値はダブルクオートで囲まれる', () => {
    const csv = buildModelCatalogCsv([
      row({ model: 'foo,bar' }),
    ]);
    expect(csv).toContain('"foo,bar"');
  });

  it('ダブルクオートを含む値は "" にエスケープされてクオート', () => {
    const csv = buildModelCatalogCsv([
      row({ source: 'manual "edit" v1' }),
    ]);
    expect(csv).toContain('"manual ""edit"" v1"');
  });

  it('改行を含む値もクオート', () => {
    const csv = buildModelCatalogCsv([
      row({ source: 'line1\nline2' }),
    ]);
    expect(csv).toContain('"line1\nline2"');
  });
});

describe('buildCsvFilename', () => {
  it('UTC 日付ベースの ファイル名を返す', () => {
    const f = buildCsvFilename(new Date('2026-05-22T15:30:00.000Z'));
    expect(f).toBe('model-catalog-2026-05-22.csv');
  });

  it('月/日が 0 パディングされる', () => {
    const f = buildCsvFilename(new Date('2026-01-05T00:00:00.000Z'));
    expect(f).toBe('model-catalog-2026-01-05.csv');
  });
});
