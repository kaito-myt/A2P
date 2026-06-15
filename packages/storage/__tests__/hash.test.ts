import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { sha256Hex, sha256HexFromStream } from '../src/hash.js';

// 公式テストベクトル: SHA-256("") と SHA-256("abc")
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256Hex', () => {
  it('空文字列 (公式ベクトル)', () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe(SHA256_EMPTY);
  });

  it('"abc" (公式ベクトル)', () => {
    expect(sha256Hex(Buffer.from('abc', 'utf8'))).toBe(SHA256_ABC);
  });

  it('決定的 (同じ入力 → 同じ hex)', () => {
    const buf = Buffer.from('hello world', 'utf8');
    expect(sha256Hex(buf)).toBe(sha256Hex(buf));
  });

  it('hex 文字列 (64 文字、小文字)', () => {
    const out = sha256Hex(Buffer.from('a2p', 'utf8'));
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256HexFromStream', () => {
  it('Node Readable 経由でも同じ hex を返す', async () => {
    const buf = Buffer.from('abc', 'utf8');
    const stream = Readable.from([buf]);
    expect(await sha256HexFromStream(stream)).toBe(SHA256_ABC);
  });

  it('複数チャンクでも累積で同じ hex を返す', async () => {
    const stream = Readable.from([Buffer.from('he'), Buffer.from('llo')]);
    const expected = sha256Hex(Buffer.from('hello', 'utf8'));
    expect(await sha256HexFromStream(stream)).toBe(expected);
  });
});
