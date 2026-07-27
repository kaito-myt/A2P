/**
 * verifyLineSignature — LINE webhook 署名検証のテスト。
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifyLineSignature } from '@/lib/line-client';

describe('verifyLineSignature', () => {
  const secret = 'test-channel-secret';
  const body = '{"events":[{"type":"message"}]}';
  const validSignature = createHmac('sha256', secret).update(body).digest('base64');

  it('正しい署名 → true', () => {
    expect(verifyLineSignature(secret, body, validSignature)).toBe(true);
  });

  it('改ざんされた本文 → false', () => {
    expect(verifyLineSignature(secret, body + 'x', validSignature)).toBe(false);
  });

  it('不正な署名文字列 → false', () => {
    expect(verifyLineSignature(secret, body, 'not-a-real-signature==')).toBe(false);
  });

  it('署名ヘッダなし (null) → false', () => {
    expect(verifyLineSignature(secret, body, null)).toBe(false);
  });

  it('違うシークレットで計算された署名 → false', () => {
    const wrongSignature = createHmac('sha256', 'wrong-secret').update(body).digest('base64');
    expect(verifyLineSignature(secret, body, wrongSignature)).toBe(false);
  });
});
