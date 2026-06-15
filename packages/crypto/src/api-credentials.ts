import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { ConfigError, ValidationError } from '@a2p/contracts/errors';

/**
 * LLM プロバイダ API キーの AES-256-GCM 暗号化ヘルパ (docs/05 §4.3.X, F-051/F-052).
 *
 * KDP credentials と同形式 (`base64(iv || authTag || ciphertext)`) を採用するが、
 * 鍵は `API_CRED_KEY` (32 bytes hex = 64 chars) を用いて KDP と分離する。
 *
 * `maskApiKey()` は UI 表示用に `<prefix>...<suffix>` 形式でマスクする。
 */

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

function validateKeyHex(keyHex: string): Buffer {
  if (typeof keyHex !== 'string') {
    throw new ValidationError('API encryption key must be a string', {
      userMessage: 'API 暗号鍵の形式が不正です',
    });
  }
  if (keyHex.length !== KEY_HEX_LEN) {
    throw new ValidationError(
      `API encryption key must be ${KEY_HEX_LEN} hex chars (${KEY_BYTES} bytes), got ${keyHex.length}`,
      { userMessage: 'API 暗号鍵の長さが不正です' },
    );
  }
  if (!HEX_PATTERN.test(keyHex)) {
    throw new ValidationError('API encryption key must be hex-encoded', {
      userMessage: 'API 暗号鍵は 16 進文字列である必要があります',
    });
  }
  return Buffer.from(keyHex, 'hex');
}

function loadKeyFromEnv(): Buffer {
  const raw = process.env.API_CRED_KEY;
  if (!raw) {
    throw new ConfigError(
      'API_CRED_KEY env is not set (required to encrypt/decrypt API credentials)',
      { userMessage: 'API 暗号鍵 (API_CRED_KEY) が設定されていません' },
    );
  }
  return validateKeyHex(raw);
}

function resolveKey(key?: Buffer): Buffer {
  if (key === undefined) return loadKeyFromEnv();
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new ValidationError(
      `API encryption key must be a ${KEY_BYTES}-byte Buffer`,
      { userMessage: 'API 暗号鍵の形式が不正です' },
    );
  }
  return key;
}

/**
 * 平文を AES-256-GCM で暗号化し、`base64(iv || authTag || ciphertext)` を返す。
 */
export function encryptApiKey(plaintext: string, key?: Buffer): string {
  if (typeof plaintext !== 'string') {
    throw new ValidationError('plaintext must be a string', {
      userMessage: 'API キーの形式が不正です',
    });
  }
  if (plaintext.length === 0) {
    throw new ValidationError('API key must not be empty', {
      userMessage: 'API キーを入力してください',
    });
  }
  const k = resolveKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, k, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * `encryptApiKey` の出力を復号する。
 * GCM 認証失敗 (改ざん検知 / 鍵不一致) は ValidationError として throw。
 */
export function decryptApiKey(encoded: string, key?: Buffer): string {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new ValidationError('encoded ciphertext must be a non-empty string', {
      userMessage: '暗号文の形式が不正です',
    });
  }
  const blob = Buffer.from(encoded, 'base64');
  if (blob.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new ValidationError('encoded ciphertext is shorter than iv+authTag', {
      userMessage: '暗号文の形式が不正です',
    });
  }
  const k = resolveKey(key);
  const iv = blob.subarray(0, IV_BYTES);
  const authTag = blob.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGO, k, iv);
  decipher.setAuthTag(authTag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (err) {
    throw new ValidationError(
      'API credentials decryption failed (authTag mismatch or corrupted ciphertext)',
      { userMessage: 'API キーの復号に失敗しました', cause: err },
    );
  }
}

const MASK_PREFIX_LEN = 3;
const MASK_SUFFIX_LEN = 4;

/**
 * UI 表示用の API キーマスク。短すぎる入力でも壊れず、機密部分を `…` で隠す。
 * 例: `sk-ant-api03-xxxxxxxxAbCd` → `sk-…AbCd`
 */
export function maskApiKey(plain: string): string {
  if (typeof plain !== 'string' || plain.length === 0) return '';
  if (plain.length <= MASK_PREFIX_LEN + MASK_SUFFIX_LEN) {
    return '*'.repeat(plain.length);
  }
  const prefix = plain.slice(0, MASK_PREFIX_LEN);
  const suffix = plain.slice(-MASK_SUFFIX_LEN);
  return `${prefix}…${suffix}`;
}
