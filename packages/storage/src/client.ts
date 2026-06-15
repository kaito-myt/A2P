import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

import { ConfigError } from '@a2p/contracts/errors';

/**
 * Cloudflare R2 用 S3 互換クライアント (docs/03 §C-10, docs/05 §8)
 *
 * R2 endpoint は `https://<account_id>.r2.cloudflarestorage.com`、region は `auto` を使う。
 * 認証は `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`。
 *
 * `getR2Client()` はプロセス内シングルトン。`packages/contracts/env.ts` の parseEnv が
 * 起動時に必須項目を検証する前提で、ここでは「未設定なら ConfigError」のみガード。
 * 後続で `parseEnv` 経由の DI に切り替えやすいよう、`resolveR2Config()` を export する。
 */

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** docs/05 §8 規約: 単一バケット。`R2_BUCKET_NAME` から取得。 */
}

/** `process.env` から R2 設定を組み立てる。env 不足は ConfigError。 */
export function resolveR2Config(source: NodeJS.ProcessEnv = process.env): R2Config {
  const accountId = source.R2_ACCOUNT_ID;
  const accessKeyId = source.R2_ACCESS_KEY_ID;
  const secretAccessKey = source.R2_SECRET_ACCESS_KEY;
  const bucket = source.R2_BUCKET_NAME;
  const missing: string[] = [];
  if (!accountId) missing.push('R2_ACCOUNT_ID');
  if (!accessKeyId) missing.push('R2_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
  if (!bucket) missing.push('R2_BUCKET_NAME');
  if (missing.length > 0) {
    throw new ConfigError(`R2 環境変数が未設定です: ${missing.join(', ')}`, {
      details: { missing },
    });
  }
  return {
    accountId: accountId as string,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
    bucket: bucket as string,
  };
}

export function buildR2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function createR2Client(config: R2Config, overrides: Partial<S3ClientConfig> = {}): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: buildR2Endpoint(config.accountId),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
    ...overrides,
  });
}

interface SingletonState {
  client: S3Client;
  bucket: string;
}

let cached: SingletonState | null = null;

/** プロセス内シングルトン S3Client を返す。テスト時は `_resetR2ClientForTests()` で破棄。 */
export function getR2Client(): S3Client {
  if (!cached) {
    const config = resolveR2Config();
    cached = { client: createR2Client(config), bucket: config.bucket };
  }
  return cached.client;
}

/** バケット名を返す。`getR2Client()` と同じ env を参照する。 */
export function getR2Bucket(): string {
  if (!cached) {
    const config = resolveR2Config();
    cached = { client: createR2Client(config), bucket: config.bucket };
  }
  return cached.bucket;
}

/** テスト用途: 注入したクライアント/バケットでシングルトンを差し替える。 */
export function _setR2ClientForTests(client: S3Client, bucket: string): void {
  cached = { client, bucket };
}

/** テスト用途: シングルトンを破棄する。 */
export function _resetR2ClientForTests(): void {
  cached = null;
}
