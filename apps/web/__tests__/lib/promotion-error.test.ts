/**
 * explainPromotionError — 失敗理由文字列 → 人間可読な説明への分類テスト。
 */
import { describe, expect, it } from 'vitest';

import { explainPromotionError } from '@/lib/promotion-error';
import { messages } from '@/lib/messages';

const pe = messages.promotionChannels.postError;

describe('explainPromotionError', () => {
  it('X 403 not permitted → 書き込み権限の説明', () => {
    const raw =
      'auth: X API responded 403: {"detail":"You are not permitted to perform this action.","status":403,"title":"Forbidden","type":"about:blank"}';
    const ex = explainPromotionError(raw);
    expect(ex?.title).toBe(pe.xForbidden.title);
    expect(ex?.raw).toBe(raw);
  });

  it('IG not_connected → 未連携の説明', () => {
    const ex = explainPromotionError(
      'not_connected: channel instagram needs a webhook_url or token to publish',
    );
    expect(ex?.title).toBe(pe.notConnected.title);
  });

  it('429 → レート上限', () => {
    expect(explainPromotionError('rate_limit: X API responded 429: ...')?.title).toBe(
      pe.rateLimit.title,
    );
  });

  it('402 → 課金/枠', () => {
    expect(explainPromotionError('auth: X API responded 402: payment required')?.title).toBe(
      pe.xPayment.title,
    );
  });

  it('webhook 5xx → 中継エラー', () => {
    expect(explainPromotionError('unknown: webhook responded 500: boom')?.title).toBe(
      pe.webhookRelay.title,
    );
  });

  it('空文字/null → null', () => {
    expect(explainPromotionError(null)).toBeNull();
    expect(explainPromotionError('')).toBeNull();
    expect(explainPromotionError('   ')).toBeNull();
  });

  it('未知パターン → generic + 生文字列保持', () => {
    const ex = explainPromotionError('something totally unexpected happened');
    expect(ex?.title).toBe(pe.generic.title);
    expect(ex?.raw).toBe('something totally unexpected happened');
  });
});
