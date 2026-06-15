import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { A2PError, ConfigError, ValidationError } from '@a2p/contracts/errors';

import {
  decryptApiKey,
  encryptApiKey,
  maskApiKey,
} from '../src/api-credentials.js';

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const KEY_A_HEX = KEY_A.toString('hex');

describe('encrypt/decrypt round-trip (API キー専用ヘルパ)', () => {
  it('ASCII の API キー文字列を round-trip できる', () => {
    const key = 'sk-ant-api03-AbCdEf0123456789';
    const enc = encryptApiKey(key, KEY_A);
    expect(typeof enc).toBe('string');
    expect(enc.length).toBeGreaterThan(0);
    expect(decryptApiKey(enc, KEY_A)).toBe(key);
  });

  it('長い OpenAI 形式キーを round-trip できる', () => {
    const key = `sk-proj-${'X'.repeat(200)}`;
    const enc = encryptApiKey(key, KEY_A);
    expect(decryptApiKey(enc, KEY_A)).toBe(key);
  });

  it('空文字は ValidationError (API キーは空であってはならない)', () => {
    expect(() => encryptApiKey('', KEY_A)).toThrow(ValidationError);
  });

  it('plaintext が string 以外なら ValidationError', () => {
    // @ts-expect-error: runtime guard test
    expect(() => encryptApiKey(123, KEY_A)).toThrow(ValidationError);
  });

  it('IV はランダムなので同一鍵・同一平文でも暗号文が異なる', () => {
    const key = 'sk-ant-test-1234';
    const a = encryptApiKey(key, KEY_A);
    const b = encryptApiKey(key, KEY_A);
    expect(a).not.toBe(b);
    expect(decryptApiKey(a, KEY_A)).toBe(key);
    expect(decryptApiKey(b, KEY_A)).toBe(key);
  });
});

describe('decrypt: 改ざん・鍵不一致の検出', () => {
  it('異なる鍵での復号失敗は ValidationError', () => {
    const enc = encryptApiKey('sk-test', KEY_A);
    expect(() => decryptApiKey(enc, KEY_B)).toThrow(ValidationError);
  });

  it('ciphertext を 1 byte 改ざんすると ValidationError', () => {
    const enc = encryptApiKey('sk-test-secret-payload', KEY_A);
    const buf = Buffer.from(enc, 'base64');
    const target = 28; // iv(12) + tag(16) = 28
    buf[target] = (buf[target] ?? 0) ^ 0xff;
    expect(() => decryptApiKey(buf.toString('base64'), KEY_A)).toThrow(ValidationError);
  });

  it('改ざんエラーは A2PError 派生で一元処理可能', () => {
    const enc = encryptApiKey('sk-test', KEY_A);
    const buf = Buffer.from(enc, 'base64');
    buf[12] = (buf[12] ?? 0) ^ 0xff;
    try {
      decryptApiKey(buf.toString('base64'), KEY_A);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect(e).toBeInstanceOf(A2PError);
      expect((e as ValidationError).cause).toBeDefined();
      return;
    }
    throw new Error('expected throw');
  });

  it('空 encoded は ValidationError', () => {
    expect(() => decryptApiKey('', KEY_A)).toThrow(ValidationError);
  });
});

describe('maskApiKey', () => {
  it('長いキーは先頭 3 + 末尾 4 をプレビューする', () => {
    expect(maskApiKey('sk-ant-api03-xxxxxxxxAbCd')).toBe('sk-…AbCd');
    expect(maskApiKey('sk-proj-abc123def456')).toBe('sk-…f456');
  });

  it('短いキーは全て * でマスク', () => {
    expect(maskApiKey('abc')).toBe('***');
    expect(maskApiKey('abcdefg')).toBe('*******');
  });

  it('空文字 / 非 string は空文字を返す', () => {
    expect(maskApiKey('')).toBe('');
    // @ts-expect-error
    expect(maskApiKey(null)).toBe('');
  });
});

describe('env API_CRED_KEY 経由', () => {
  const original = process.env.API_CRED_KEY;
  beforeEach(() => {
    delete process.env.API_CRED_KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.API_CRED_KEY;
    else process.env.API_CRED_KEY = original;
  });

  it('未設定 → ConfigError (Phase 1 必須)', () => {
    expect(() => encryptApiKey('sk-test')).toThrow(ConfigError);
    const dummy = Buffer.alloc(32).toString('base64');
    expect(() => decryptApiKey(dummy)).toThrow(ConfigError);
  });

  it('正しい env で round-trip 成功', () => {
    process.env.API_CRED_KEY = KEY_A_HEX;
    const enc = encryptApiKey('via-env-key');
    expect(decryptApiKey(enc)).toBe('via-env-key');
  });

  it('env が hex 不正 → ValidationError', () => {
    process.env.API_CRED_KEY = 'not-hex-string';
    expect(() => encryptApiKey('x')).toThrow(ValidationError);
  });
});
