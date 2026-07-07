/**
 * themes-view.ts のユニットテスト (T-03-07).
 *
 * 検証:
 *  - serializeThemeRow: Date → ISO / 未知 status → pending fallback /
 *    competitors_json/signals_json 抽出
 *  - summarizeRows: 各 status カウント
 *  - pickPendingIds / pickSelectedIds: rows 順を保つ
 *  - truncate / formatDateTime の基本動作
 */
import { describe, expect, it } from 'vitest';

import {
  formatDateTime,
  pickPendingIds,
  pickSelectedIds,
  serializeThemeRow,
  summarizeRows,
  truncate,
  type ThemeRowSerialized,
} from '../../lib/themes-view';

function rawRow(overrides: {
  id: string;
  status?: string;
  competitors_json?: unknown;
  signals_json?: unknown;
}) {
  return {
    id: overrides.id,
    theme_session_id: 'tses_1',
    account_id: 'acc_1',
    title: 'タイトル',
    hook: '差別化要素',
    target_reader: '20-40 代',
    genre: 'business',
    status: overrides.status ?? 'pending',
    competitors_json: overrides.competitors_json ?? [],
    signals_json: overrides.signals_json ?? null,
    created_at: new Date('2026-05-20T23:45:00.000Z'),
    decided_at: null,
  };
}

describe('serializeThemeRow', () => {
  it('Date → ISO、競合カウント + market_score 抽出', () => {
    const r = serializeThemeRow(
      rawRow({
        id: 't_1',
        competitors_json: [
          { asin: 'B0X1' },
          { asin: 'B0X2' },
          { asin: 'B0X3' },
        ],
        signals_json: { market_score: 75, reasoning: 'foo' },
      }),
    );
    expect(r.id).toBe('t_1');
    expect(r.competitor_count).toBe(3);
    expect(r.market_score).toBe(75);
    expect(r.created_at).toBe('2026-05-20T23:45:00.000Z');
    expect(r.decided_at).toBeNull();
  });

  it('signals_json が null / 非オブジェクトなら market_score=null', () => {
    expect(serializeThemeRow(rawRow({ id: 't_1', signals_json: null })).market_score).toBeNull();
    expect(serializeThemeRow(rawRow({ id: 't_2', signals_json: 'xxx' })).market_score).toBeNull();
    expect(serializeThemeRow(rawRow({ id: 't_3', signals_json: {} })).market_score).toBeNull();
  });

  it('competitors_json が非配列なら count=0', () => {
    expect(
      serializeThemeRow(rawRow({ id: 't_1', competitors_json: 'broken' })).competitor_count,
    ).toBe(0);
  });

  it('未知 status は pending fallback', () => {
    expect(serializeThemeRow(rawRow({ id: 't_1', status: 'weird' })).status).toBe('pending');
  });

  it('既知 status は preserved', () => {
    expect(serializeThemeRow(rawRow({ id: 't_1', status: 'accepted' })).status).toBe('accepted');
    expect(serializeThemeRow(rawRow({ id: 't_2', status: 'rejected' })).status).toBe('rejected');
  });
});

describe('summarizeRows', () => {
  function mkRow(id: string, status: ThemeRowSerialized['status']): ThemeRowSerialized {
    return {
      id,
      theme_session_id: 'tses_1',
      account_id: 'acc_1',
      title: 't',
      hook: 'h',
      target_reader: null,
      genre: 'business',
      status,
      competitor_count: 0,
      market_score: null,
      demand_level: null,
      created_at: '2026-05-20T00:00:00.000Z',
      decided_at: null,
    };
  }

  it('全 status をカウント', () => {
    const rows = [
      mkRow('t1', 'pending'),
      mkRow('t2', 'pending'),
      mkRow('t3', 'accepted'),
      mkRow('t4', 'rejected'),
      mkRow('t5', 'rejected'),
    ];
    expect(summarizeRows(rows)).toEqual({
      total: 5,
      pending: 2,
      accepted: 1,
      rejected: 2,
    });
  });

  it('空配列 → 全 0', () => {
    expect(summarizeRows([])).toEqual({ total: 0, pending: 0, accepted: 0, rejected: 0 });
  });
});

describe('pickPendingIds / pickSelectedIds', () => {
  function mkRow(id: string, status: ThemeRowSerialized['status']): ThemeRowSerialized {
    return {
      id,
      theme_session_id: 'tses_1',
      account_id: 'acc_1',
      title: 't',
      hook: 'h',
      target_reader: null,
      genre: 'business',
      status,
      competitor_count: 0,
      market_score: null,
      demand_level: null,
      created_at: '2026-05-20T00:00:00.000Z',
      decided_at: null,
    };
  }

  const rows = [
    mkRow('t_p1', 'pending'),
    mkRow('t_a', 'accepted'),
    mkRow('t_p2', 'pending'),
    mkRow('t_r', 'rejected'),
  ];

  it('pickPendingIds は pending のみ抽出し、rows 順を保つ', () => {
    const sel = new Set(['t_p1', 't_a', 't_p2', 't_r']);
    expect(pickPendingIds(rows, sel)).toEqual(['t_p1', 't_p2']);
  });

  it('pickSelectedIds は status を問わず rows 順', () => {
    const sel = new Set(['t_r', 't_p1', 't_a']);
    expect(pickSelectedIds(rows, sel)).toEqual(['t_p1', 't_a', 't_r']);
  });
});

describe('truncate', () => {
  it('max 以下はそのまま', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('max を超えたら … が付く', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});

describe('formatDateTime', () => {
  it('ISO → YYYY-MM-DD HH:mm', () => {
    // ローカル TZ 依存だが pattern を確認
    expect(formatDateTime('2026-05-20T10:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('不正値はそのまま返す', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
