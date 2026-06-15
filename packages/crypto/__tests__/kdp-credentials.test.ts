import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { A2PError, ConfigError, ValidationError } from '@a2p/contracts/errors';

import {
  decryptKdpCredentials,
  encryptKdpCredentials,
  validateKey,
} from '../src/kdp-credentials.js';

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const KEY_A_HEX = KEY_A.toString('hex');

describe('validateKey', () => {
  it('正しい hex 64 文字 → Buffer (32 bytes)', () => {
    const buf = validateKey(KEY_A_HEX);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(32);
    expect(buf.equals(KEY_A)).toBe(true);
  });

  it('hex 文字数が 64 未満 → ValidationError', () => {
    expect(() => validateKey('ab'.repeat(31))).toThrow(ValidationError);
  });

  it('hex 文字数が 64 超過 → ValidationError', () => {
    expect(() => validateKey('ab'.repeat(33))).toThrow(ValidationError);
  });

  it('非 hex 文字を含む → ValidationError', () => {
    const bad = 'z'.repeat(64);
    expect(() => validateKey(bad)).toThrow(ValidationError);
  });

  it('空文字 → ValidationError', () => {
    expect(() => validateKey('')).toThrow(ValidationError);
  });

  it('ValidationError は A2PError 派生', () => {
    try {
      validateKey('short');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect(e).toBeInstanceOf(A2PError);
      return;
    }
    throw new Error('expected throw');
  });
});

describe('encrypt → decrypt round-trip', () => {
  it('ASCII 文字列', () => {
    const plain = 'kdp_user@example.com';
    const enc = encryptKdpCredentials(plain, KEY_A);
    expect(typeof enc).toBe('string');
    expect(enc.length).toBeGreaterThan(0);
    expect(decryptKdpCredentials(enc, KEY_A)).toBe(plain);
  });

  it('空文字列', () => {
    const enc = encryptKdpCredentials('', KEY_A);
    expect(decryptKdpCredentials(enc, KEY_A)).toBe('');
  });

  it('日本語含む長文字列 (JSON ライク)', () => {
    const plain = JSON.stringify({
      email: 'kdp担当@例.jp',
      password: 'パスワード文字列・記号 !@#$%^&*()_+ 末尾',
      note: 'a'.repeat(2000) + 'あ'.repeat(2000),
    });
    const enc = encryptKdpCredentials(plain, KEY_A);
    expect(decryptKdpCredentials(enc, KEY_A)).toBe(plain);
  });

  it('出力は base64 形式 (URL 安全文字に限定されない)', () => {
    const enc = encryptKdpCredentials('hello', KEY_A);
    expect(enc).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});

describe('encrypt: IV ランダム性', () => {
  it('同一平文を 2 回暗号化 → 異なる出力 (IV が毎回ランダム)', () => {
    const plain = 'same plaintext';
    const a = encryptKdpCredentials(plain, KEY_A);
    const b = encryptKdpCredentials(plain, KEY_A);
    expect(a).not.toBe(b);
    // しかし両者とも復号できる
    expect(decryptKdpCredentials(a, KEY_A)).toBe(plain);
    expect(decryptKdpCredentials(b, KEY_A)).toBe(plain);
  });
});

describe('decrypt: 改ざん・鍵不一致の検出', () => {
  it('異なる鍵で復号失敗 (authTag 不一致 → ValidationError)', () => {
    const enc = encryptKdpCredentials('secret', KEY_A);
    expect(() => decryptKdpCredentials(enc, KEY_B)).toThrow(ValidationError);
  });

  it('ciphertext を 1 byte 改ざん → ValidationError', () => {
    const enc = encryptKdpCredentials('secret payload here', KEY_A);
    const buf = Buffer.from(enc, 'base64');
    // ciphertext の先頭 (= iv(12) + tag(16) = offset 28) を 1 byte 反転
    const target = 28;
    buf[target] = (buf[target] ?? 0) ^ 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptKdpCredentials(tampered, KEY_A)).toThrow(ValidationError);
  });

  it('authTag を 1 byte 改ざん → ValidationError', () => {
    const enc = encryptKdpCredentials('secret payload', KEY_A);
    const buf = Buffer.from(enc, 'base64');
    // authTag (offset 12..28) の先頭を反転
    const target = 12;
    buf[target] = (buf[target] ?? 0) ^ 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptKdpCredentials(tampered, KEY_A)).toThrow(ValidationError);
  });

  it('IV を 1 byte 改ざん → ValidationError (平文が変わり authTag 不一致)', () => {
    const enc = encryptKdpCredentials('secret payload', KEY_A);
    const buf = Buffer.from(enc, 'base64');
    buf[0] = (buf[0] ?? 0) ^ 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptKdpCredentials(tampered, KEY_A)).toThrow(ValidationError);
  });

  it('改ざん時の ValidationError は A2PError 派生 (一元処理可能)', () => {
    const enc = encryptKdpCredentials('secret', KEY_A);
    const buf = Buffer.from(enc, 'base64');
    buf[12] = (buf[12] ?? 0) ^ 0xff;
    const tampered = buf.toString('base64');
    try {
      decryptKdpCredentials(tampered, KEY_A);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect(e).toBeInstanceOf(A2PError);
      // 元の GCM エラーが cause として保存されている
      expect((e as ValidationError).cause).toBeDefined();
      return;
    }
    throw new Error('expected throw');
  });

  it('空文字列の encoded → ValidationError', () => {
    expect(() => decryptKdpCredentials('', KEY_A)).toThrow(ValidationError);
  });

  it('iv+tag 長未満の encoded → ValidationError', () => {
    const tooShort = Buffer.alloc(10).toString('base64');
    expect(() => decryptKdpCredentials(tooShort, KEY_A)).toThrow(ValidationError);
  });
});

describe('key 引数バリデーション', () => {
  it('encrypt: 鍵長 != 32 bytes Buffer → ValidationError', () => {
    expect(() => encryptKdpCredentials('x', Buffer.alloc(16))).toThrow(ValidationError);
  });

  it('decrypt: 鍵長 != 32 bytes Buffer → ValidationError', () => {
    const enc = encryptKdpCredentials('x', KEY_A);
    expect(() => decryptKdpCredentials(enc, Buffer.alloc(31))).toThrow(ValidationError);
  });

  it('encrypt: plaintext が string でない → ValidationError', () => {
    // @ts-expect-error: runtime guard test
    expect(() => encryptKdpCredentials(123, KEY_A)).toThrow(ValidationError);
  });
});

describe('env KDP_CRED_KEY 経由', () => {
  const originalKey = process.env.KDP_CRED_KEY;

  beforeEach(() => {
    delete process.env.KDP_CRED_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.KDP_CRED_KEY;
    } else {
      process.env.KDP_CRED_KEY = originalKey;
    }
  });

  it('未設定 → ConfigError (Phase 3 必須を明示)', () => {
    expect(() => encryptKdpCredentials('x')).toThrow(ConfigError);
    // decrypt 側にも env 不在を確認させるため、iv+tag 長を満たすダミーを与える
    const dummy = Buffer.alloc(32).toString('base64');
    expect(() => decryptKdpCredentials(dummy)).toThrow(ConfigError);
  });

  it('正しい env で round-trip 成功', () => {
    process.env.KDP_CRED_KEY = KEY_A_HEX;
    const enc = encryptKdpCredentials('via-env');
    expect(decryptKdpCredentials(enc)).toBe('via-env');
  });

  it('env が hex 不正 → ValidationError', () => {
    process.env.KDP_CRED_KEY = 'not-hex-string';
    expect(() => encryptKdpCredentials('x')).toThrow(ValidationError);
  });
});
