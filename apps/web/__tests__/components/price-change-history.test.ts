/**
 * PriceChangeHistory の parseAlert ユニットテスト.
 *
 * 検証する不変条件 (catalog-fetch.ts:442-457 の INSERT 形と 1:1):
 *  - 正常 payload → before/after/delta (代表値) が正しく抽出される
 *  - 不正 payload (key 名違い / 欠落 / null / 旧形式) → 全フィールド '—' フォールバック
 *  - delta_pct.input と delta_pct.output が異なる → 絶対値が大きい方が代表値になる
 *  - 旧形式 (input/output 直接キー) は今や invalid とみなして '—' になる (リグレッション保護)
 */
import { describe, expect, it } from 'vitest';
import type { Alert } from '@a2p/db';

import { parseAlert } from '../../components/models/price-change-history';

function makeAlert(payload_json: unknown, overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'alert_1',
    kind: 'catalog_price_change',
    severity: 'warning',
    payload_json: payload_json as Alert['payload_json'],
    read_at: null,
    resolved_at: null,
    created_at: new Date('2026-05-22T10:30:00.000Z'),
    ...overrides,
  };
}

const VALID_PAYLOAD = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  before: {
    input_price_per_mtok_usd: 15,
    output_price_per_mtok_usd: 75,
  },
  after: {
    input_price_per_mtok_usd: 17.5,
    output_price_per_mtok_usd: 82.5,
  },
  delta_pct: { input: 16.67, output: 10.0 },
};

describe('parseAlert', () => {
  it('正常 payload を正しく抽出する (before/after/delta 代表値)', () => {
    const row = parseAlert(makeAlert(VALID_PAYLOAD));
    expect(row.provider).toBe('anthropic');
    expect(row.model).toBe('claude-opus-4-7');
    expect(row.beforeText).toBe('in $15.0000 / out $75.0000');
    expect(row.afterText).toBe('in $17.5000 / out $82.5000');
    // |16.67| > |10.0| なので input 側が代表値
    expect(row.deltaPct).toBe(16.67);
    expect(row.kindLabel).toBe('catalog_price_change');
    // occurredAt は TZ ローカルに依存するため形式のみ確認
    expect(row.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('output 側の絶対値が大きい場合は output 側の delta_pct を代表値にする', () => {
    const row = parseAlert(
      makeAlert({
        ...VALID_PAYLOAD,
        delta_pct: { input: -5.0, output: -22.3 },
      }),
    );
    // |-22.3| > |-5.0|
    expect(row.deltaPct).toBe(-22.3);
  });

  it('|input|==|output| のときは input 側を代表値にする (安定動作)', () => {
    const row = parseAlert(
      makeAlert({
        ...VALID_PAYLOAD,
        delta_pct: { input: 12.5, output: -12.5 },
      }),
    );
    expect(row.deltaPct).toBe(12.5);
  });

  it('payload が null のときは全フィールド フォールバックする', () => {
    const row = parseAlert(makeAlert(null));
    expect(row.provider).toBe('—');
    expect(row.model).toBe('—');
    expect(row.beforeText).toBe('—');
    expect(row.afterText).toBe('—');
    expect(row.deltaPct).toBeNull();
    expect(row.kindLabel).toBe('catalog_price_change');
  });

  it('payload が空オブジェクトのときフォールバックする', () => {
    const row = parseAlert(makeAlert({}));
    expect(row.provider).toBe('—');
    expect(row.deltaPct).toBeNull();
  });

  it('旧形式 (before.input / before.output 直接キー) はフォールバックする — リグレッション保護', () => {
    // 修正前の parseAlert はこの形を期待していたが、実 catalog-fetch は
    // input_price_per_mtok_usd キーで INSERT する。旧形式は invalid とみなす。
    const legacy = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      before: { input: 15, output: 75 },
      after: { input: 17, output: 80 },
      delta_pct: 13.3, // 旧形式は number だった
    };
    const row = parseAlert(makeAlert(legacy));
    expect(row.provider).toBe('—');
    expect(row.beforeText).toBe('—');
    expect(row.deltaPct).toBeNull();
  });

  it('delta_pct が number (オブジェクトでない) のときフォールバックする', () => {
    const row = parseAlert(
      makeAlert({
        ...VALID_PAYLOAD,
        delta_pct: 16.67,
      }),
    );
    expect(row.deltaPct).toBeNull();
  });

  it('before.input_price_per_mtok_usd が文字列のときフォールバックする (型安全性)', () => {
    const row = parseAlert(
      makeAlert({
        ...VALID_PAYLOAD,
        before: { input_price_per_mtok_usd: '15', output_price_per_mtok_usd: 75 },
      }),
    );
    expect(row.beforeText).toBe('—');
  });

  it('正負の delta は符号が反映され、0.0% は "0.0%" として表示用 number が返る', () => {
    const positive = parseAlert(
      makeAlert({ ...VALID_PAYLOAD, delta_pct: { input: 1.2, output: 0.0 } }),
    );
    expect(positive.deltaPct).toBe(1.2);

    const zero = parseAlert(
      makeAlert({ ...VALID_PAYLOAD, delta_pct: { input: 0.0, output: 0.0 } }),
    );
    expect(zero.deltaPct).toBe(0);
  });

  it('id と kind は payload に依らず Alert から伝播する', () => {
    const row = parseAlert(
      makeAlert(VALID_PAYLOAD, { id: 'alert_xyz', kind: 'catalog_price_change' }),
    );
    expect(row.id).toBe('alert_xyz');
    expect(row.kindLabel).toBe('catalog_price_change');
  });
});
