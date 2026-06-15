/**
 * themes-view.ts の S-007 詳細用ヘルパ (T-03-08) のユニットテスト。
 *
 * 検証:
 *  - parseCompetitors: 正常配列 / 空配列 / null / 非配列 / 一部不正要素を除外
 *  - parseSignals: 正常オブジェクト / null / 配列 / 全 optional 欠落 / 不正型
 *  - serializeThemeDetail: Date → ISO / market_score 抽出 /
 *    competitors_json/signals_json defensive parse / status fallback
 */
import { describe, expect, it } from 'vitest';

import {
  parseCompetitors,
  parseSignals,
  serializeThemeDetail,
} from '../../lib/themes-view';

function detailRow(overrides: {
  id?: string;
  status?: string;
  subtitle?: string | null;
  rejected_reason?: string | null;
  competitors_json?: unknown;
  signals_json?: unknown;
  decided_at?: Date | null;
}) {
  return {
    id: overrides.id ?? 't_1',
    theme_session_id: 'tses_1',
    account_id: 'acc_1',
    title: '副業 × AI で月 5 万円稼ぐ',
    subtitle: overrides.subtitle ?? null,
    hook: '差別化要素テキスト',
    target_reader: '20-40 代 副業初心者',
    genre: 'business',
    status: overrides.status ?? 'pending',
    rejected_reason: overrides.rejected_reason ?? null,
    competitors_json: overrides.competitors_json ?? [],
    signals_json: overrides.signals_json ?? null,
    created_at: new Date('2026-05-20T23:45:00.000Z'),
    decided_at: overrides.decided_at ?? null,
  };
}

describe('parseCompetitors', () => {
  it('正常な配列はそのまま返る (全 optional フィールド埋め)', () => {
    const out = parseCompetitors([
      {
        asin: 'B0X1',
        title: 'タイトル A',
        author: '著者 A',
        url: 'https://amazon.co.jp/dp/B0X1',
        rank: 100,
        review_summary: 'good',
        note: 'memo',
      },
      { title: 'タイトル B' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.asin).toBe('B0X1');
    expect(out[0]?.url).toBe('https://amazon.co.jp/dp/B0X1');
    expect(out[1]?.title).toBe('タイトル B');
  });

  it('空配列 → 空配列', () => {
    expect(parseCompetitors([])).toEqual([]);
  });

  it('null / undefined / 非配列 → 空配列 (defensive fallback)', () => {
    expect(parseCompetitors(null)).toEqual([]);
    expect(parseCompetitors(undefined)).toEqual([]);
    expect(parseCompetitors('xxx')).toEqual([]);
    expect(parseCompetitors({})).toEqual([]);
    expect(parseCompetitors(42)).toEqual([]);
  });

  it('一部の要素が不正型なら、その要素のみ除外する', () => {
    const out = parseCompetitors([
      { title: 'ok' },
      'broken-string', // not an object → drop
      { title: 123 }, // wrong field type → drop (title must be string)
      { asin: 'B0X9' }, // all optional → keep
    ]);
    expect(out.map((c) => c.title ?? c.asin)).toEqual(['ok', 'B0X9']);
  });

  it('要素を全部 {} にしても空 object として保持される (全 optional)', () => {
    expect(parseCompetitors([{}, {}, {}])).toHaveLength(3);
  });
});

describe('parseSignals', () => {
  it('Marketer 出力相当の正常 object はそのまま返る', () => {
    const out = parseSignals({
      reasoning: '副業ジャンルは検索ボリュームが多く...',
      market_score: 75,
      predicted_chapters: 8,
      search_keywords: ['副業', 'AI', '在宅'],
      search_volume: 12000,
      rank_estimate: 50,
      sources: ['https://example.com/a', 'https://example.com/b'],
    });
    expect(out.market_score).toBe(75);
    expect(out.search_keywords).toEqual(['副業', 'AI', '在宅']);
    expect(out.sources).toHaveLength(2);
  });

  it('null / undefined / 配列 / プリミティブ → 空オブジェクト', () => {
    expect(parseSignals(null)).toEqual({});
    expect(parseSignals(undefined)).toEqual({});
    expect(parseSignals([])).toEqual({});
    expect(parseSignals('xxx')).toEqual({});
    expect(parseSignals(42)).toEqual({});
  });

  it('全フィールド欠落の object でもパース成功 (= 空 object 返却)', () => {
    expect(parseSignals({})).toEqual({});
  });

  it('不正型のフィールドが含まれていたら丸ごと空 object fallback', () => {
    // market_score が string になっている → SignalsSchema 全体が fail → {}
    expect(parseSignals({ market_score: 'high' })).toEqual({});
  });

  it('一部だけ正しいフィールドがある object はそのまま部分的に返る', () => {
    expect(parseSignals({ reasoning: 'only this', market_score: 30 })).toEqual({
      reasoning: 'only this',
      market_score: 30,
    });
  });
});

describe('serializeThemeDetail', () => {
  it('Date → ISO / market_score 抽出 / competitors 構造化', () => {
    const r = serializeThemeDetail(
      detailRow({
        id: 't_x',
        subtitle: 'サブタイトル',
        competitors_json: [{ asin: 'B0X1', title: 'A' }, { title: 'B' }],
        signals_json: { market_score: 80, reasoning: 'r' },
      }),
    );
    expect(r.id).toBe('t_x');
    expect(r.subtitle).toBe('サブタイトル');
    expect(r.competitors).toHaveLength(2);
    expect(r.signals.reasoning).toBe('r');
    expect(r.market_score).toBe(80);
    expect(r.created_at).toBe('2026-05-20T23:45:00.000Z');
    expect(r.decided_at).toBeNull();
  });

  it('signals_json が null なら market_score=null + 空 signals', () => {
    const r = serializeThemeDetail(detailRow({ id: 't_1' }));
    expect(r.market_score).toBeNull();
    expect(r.signals).toEqual({});
  });

  it('competitors_json が壊れていても (非配列) UI 用に空配列で受ける', () => {
    const r = serializeThemeDetail(
      detailRow({ id: 't_1', competitors_json: 'broken' }),
    );
    expect(r.competitors).toEqual([]);
  });

  it('未知 status → pending fallback / 既知 status は preserved', () => {
    expect(serializeThemeDetail(detailRow({ id: 't_1', status: 'weird' })).status).toBe(
      'pending',
    );
    expect(serializeThemeDetail(detailRow({ id: 't_2', status: 'accepted' })).status).toBe(
      'accepted',
    );
    expect(serializeThemeDetail(detailRow({ id: 't_3', status: 'rejected' })).status).toBe(
      'rejected',
    );
  });

  it('decided_at が Date なら ISO 文字列化される', () => {
    const r = serializeThemeDetail(
      detailRow({ id: 't_1', decided_at: new Date('2026-05-21T01:23:45.000Z') }),
    );
    expect(r.decided_at).toBe('2026-05-21T01:23:45.000Z');
  });

  it('rejected ステータスで rejected_reason が保持される', () => {
    const r = serializeThemeDetail(
      detailRow({
        id: 't_1',
        status: 'rejected',
        rejected_reason: '重複テーマのため却下',
      }),
    );
    expect(r.status).toBe('rejected');
    expect(r.rejected_reason).toBe('重複テーマのため却下');
  });

  it('market_score が非数値 (NaN / 非数値型) なら null', () => {
    expect(
      serializeThemeDetail(
        detailRow({ id: 't_1', signals_json: { market_score: 'high' } }),
      ).market_score,
    ).toBeNull();
    expect(
      serializeThemeDetail(
        detailRow({ id: 't_2', signals_json: { market_score: Number.NaN } }),
      ).market_score,
    ).toBeNull();
  });
});
