import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { ConfigError, ValidationError } from '@a2p/contracts/errors';

/**
 * KDP 認証情報の AES-256-GCM 暗号化ヘルパ (docs/03 §KDP-04, Phase 3 先取り)。
 *
 * フォーマット: `base64(iv || authTag || ciphertext)` (単一文字列)
 *   - iv:        12 bytes (GCM 推奨)
 *   - authTag:   16 bytes (固定)
 *   - ciphertext: 可変長
 *
 * 鍵は呼び出し側で DI（テスト容易性 + 将来の KMS 連携余地）するか、
 * 省略時は env `KDP_CRED_KEY` (hex 64 文字 = 32 bytes) を使用する。
 */

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * hex 64 文字 (32 bytes) を検証して Buffer を返す。
 * 不正な入力は ValidationError を throw。
 */
export function validateKey(keyHex: string): Buffer {
  if (typeof keyHex !== 'string') {
    throw new ValidationError('KDP encryption key must be a string', {
      userMessage: 'KDP 暗号鍵の形式が不正です',
    });
  }
  if (keyHex.length !== KEY_HEX_LEN) {
    throw new ValidationError(
      `KDP encryption key must be ${KEY_HEX_LEN} hex chars (${KEY_BYTES} bytes), got ${keyHex.length}`,
      { userMessage: 'KDP 暗号鍵の長さが不正です' },
    );
  }
  if (!HEX_PATTERN.test(keyHex)) {
    throw new ValidationError('KDP encryption key must be hex-encoded', {
      userMessage: 'KDP 暗号鍵は 16 進文字列である必要があります',
    });
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * env `KDP_CRED_KEY` から鍵を取得。Phase 3 必須なため、未設定時は ConfigError。
 * 内部利用想定 (Buffer DI 経路を優先)。
 */
function loadKeyFromEnv(): Buffer {
  const raw = process.env.KDP_CRED_KEY;
  if (!raw) {
    throw new ConfigError(
      'KDP_CRED_KEY env is not set (required to encrypt/decrypt KDP credentials)',
      { userMessage: 'KDP 暗号鍵 (KDP_CRED_KEY) が設定されていません' },
    );
  }
  return validateKey(raw);
}

function resolveKey(key?: Buffer): Buffer {
  if (key === undefined) return loadKeyFromEnv();
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new ValidationError(
      `KDP encryption key must be a ${KEY_BYTES}-byte Buffer`,
      { userMessage: 'KDP 暗号鍵の形式が不正です' },
    );
  }
  return key;
}

/**
 * 平文を AES-256-GCM で暗号化し、`base64(iv || authTag || ciphertext)` を返す。
 *
 * @param plaintext UTF-8 文字列。空文字も許容（KDP 入力途中の空値保存用）。
 * @param key       省略時は env `KDP_CRED_KEY` から取得。
 */
export function encryptKdpCredentials(plaintext: string, key?: Buffer): string {
  if (typeof plaintext !== 'string') {
    throw new ValidationError('plaintext must be a string', {
      userMessage: 'KDP 認証情報の形式が不正です',
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
 * `encryptKdpCredentials` の出力を復号する。
 * GCM 認証失敗 (改ざん検知 / 鍵不一致) は ValidationError として throw され、
 * 呼び出し側 SA が `instanceof A2PError` で一元処理できる (docs/05 §9.1)。
 */
export function decryptKdpCredentials(encoded: string, key?: Buffer): string {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new ValidationError('encoded ciphertext must be a non-empty string', {
      userMessage: '暗号文の形式が不正です',
    });
  }
  // Buffer.from(_, 'base64') は throw しない (不正文字は無音で破棄) ため try/catch 不要。
  // 長さ不足は下の length チェックで検出する。
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
      'KDP credentials decryption failed (authTag mismatch or corrupted ciphertext)',
      { userMessage: 'KDP 認証情報の復号に失敗しました', cause: err },
    );
  }
}
