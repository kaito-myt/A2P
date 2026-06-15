/**
 * sales-fetch-status ヘルパ単体テスト (T-12-07, F-038).
 *
 * 検証:
 *  1. serializeSalesFetchRun — Date → ISO string 変換
 *  2. formatRelativeTime — 相対時刻フォーマット
 */
import { describe, expect, it } from 'vitest';

import {
  serializeSalesFetchRun,
  formatRelativeTime,
  type SalesFetchRunSerialized,
} from '../../lib/sales-fetch-status';
import type { SalesFetchRun } from '@a2p/db';

// ---------------------------------------------------------------------------
// テスト用ファクトリ
// ---------------------------------------------------------------------------

const FROZEN_NOW = new Date('2026-06-14T10:00:00.000Z');

function makeRun(overrides: Partial<SalesFetchRun> = {}): SalesFetchRun {
  return {
    id: 'run_1',
    account_id: 'acc_1',
    year_month: '2026-06',
    status: 'done',
    records_upserted: 5,
    error_message: null,
    started_at: new Date('2026-06-14T09:55:00.000Z'),
    finished_at: new Date('2026-06-14T09:58:00.000Z'),
    ...overrides,
  } as SalesFetchRun;
}

// ---------------------------------------------------------------------------
// serializeSalesFetchRun
// ---------------------------------------------------------------------------

describe('serializeSalesFetchRun', () => {
  it('Date フィールドを ISO 文字列に変換する', () => {
    const run = makeRun();
    const result: SalesFetchRunSerialized = serializeSalesFetchRun(run);

    expect(result.started_at).toBe('2026-06-14T09:55:00.000Z');
    expect(result.finished_at).toBe('2026-06-14T09:58:00.000Z');
    expect(result.status).toBe('done');
    expect(result.records_upserted).toBe(5);
    expect(result.error_message).toBeNull();
  });

  it('finished_at が null の場合 null を返す', () => {
    const run = makeRun({ finished_at: null });
    const result = serializeSalesFetchRun(run);

    expect(result.finished_at).toBeNull();
  });

  it('error_message が設定されている場合に保持する', () => {
    const run = makeRun({ status: 'failed', error_message: 'ログイン失敗' });
    const result = serializeSalesFetchRun(run);

    expect(result.status).toBe('failed');
    expect(result.error_message).toBe('ログイン失敗');
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  it('30 秒前を正しくフォーマットする', () => {
    const iso = new Date(FROZEN_NOW.getTime() - 30 * 1000).toISOString();
    expect(formatRelativeTime(iso, FROZEN_NOW)).toBe('30 秒前');
  });

  it('5 分前を正しくフォーマットする', () => {
    const iso = new Date(FROZEN_NOW.getTime() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, FROZEN_NOW)).toBe('5 分前');
  });

  it('2 時間前を正しくフォーマットする', () => {
    const iso = new Date(FROZEN_NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, FROZEN_NOW)).toBe('2 時間前');
  });

  it('3 日前を正しくフォーマットする', () => {
    const iso = new Date(FROZEN_NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, FROZEN_NOW)).toBe('3 日前');
  });

  it('1 分未満は秒で表示する', () => {
    const iso = new Date(FROZEN_NOW.getTime() - 59 * 1000).toISOString();
    expect(formatRelativeTime(iso, FROZEN_NOW)).toBe('59 秒前');
  });

  it('1 時間未満は分で表示する', () => {
    const iso = new Date(FROZEN_NOW.getTime() - 59 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, FROZEN_NOW)).toBe('59 分前');
  });
});
