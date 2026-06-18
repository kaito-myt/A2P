import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { StorageError } from '@a2p/contracts/errors';
import { createLogger } from '@a2p/contracts/logger';

import { getR2Bucket, getR2Client } from './client.js';
import { sha256Hex, sha256HexFromStream } from './hash.js';

const log = createLogger('storage.r2');

/** R2 PUT/GET/DELETE 共通の戻り値メタ。 */
export interface UploadResult {
  key: string;
  sha256: string;
  size: number;
  contentType: string;
}

export interface ObjectMetadata {
  size: number;
  contentType: string;
  sha256?: string;
  lastModified?: Date;
}

/**
 * テスト等で `getR2Client()` / `getR2Bucket()` の env シングルトンを上書きしたい場合に使う。
 *
 * `client` を渡す場合は `bucket` も必須（env から取りに行かないため）。両方省略すれば
 * `R2_*` env のシングルトンが使われる。
 */
export type OperationOptions =
  | { client?: undefined; bucket?: undefined }
  | { client: S3Client; bucket: string };

function resolveClient(opts: OperationOptions): { client: S3Client; bucket: string } {
  return {
    client: opts.client ?? getR2Client(),
    bucket: opts.bucket ?? getR2Bucket(),
  };
}

/** `process.env.NODE_ENV !== 'test'` 限定のログ。テストで noisy にしないため。 */
function logInfo(event: string, fields: Record<string, unknown>): void {
  if (process.env.NODE_ENV === 'test') return;
  log.info(fields, event);
}

/**
 * Buffer を R2 にアップロードする。SHA-256 を計算し `x-amz-meta-sha256` に格納、
 * 戻り値にも hex で含める（`Artifact.checksum` に保存可能）。
 */
export async function uploadBuffer(
  key: string,
  buffer: Buffer,
  contentType: string,
  options: OperationOptions = {},
): Promise<UploadResult> {
  const { client, bucket } = resolveClient(options);
  const sha256 = sha256Hex(buffer);
  const input: PutObjectCommandInput = {
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ContentLength: buffer.byteLength,
    Metadata: { sha256 },
  };
  try {
    await client.send(new PutObjectCommand(input));
  } catch (err) {
    throw new StorageError('R2 PUT に失敗しました', {
      details: { bucket, key, contentType, size: buffer.byteLength },
      cause: err,
    });
  }
  logInfo('r2.put', { key, size: buffer.byteLength, contentType, sha256 });
  return { key, sha256, size: buffer.byteLength, contentType };
}

/**
 * ストリームを R2 にアップロードする。大容量 PDF/PNG 対応。
 *
 * ストリーミング中の SHA-256 計算が必要な場合は呼び出し側で `PassThrough` 経由
 * もしくは「先に Buffer 化してから `uploadBuffer`」を選択する。本関数は SHA-256 を
 * 付与せず、`contentLength` のみ受け取る。
 */
export async function uploadStream(
  key: string,
  stream: Readable | ReadableStream<Uint8Array>,
  contentType: string,
  contentLength: number,
  options: OperationOptions = {},
): Promise<{ key: string; size: number; contentType: string }> {
  const { client, bucket } = resolveClient(options);
  const body =
    stream instanceof Readable
      ? stream
      : Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
  const input: PutObjectCommandInput = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentLength: contentLength,
  };
  try {
    await client.send(new PutObjectCommand(input));
  } catch (err) {
    throw new StorageError('R2 PUT (stream) に失敗しました', {
      details: { bucket, key, contentType, size: contentLength },
      cause: err,
    });
  }
  logInfo('r2.put.stream', { key, size: contentLength, contentType });
  return { key, size: contentLength, contentType };
}

/**
 * 署名付きダウンロード URL を生成する。
 * 既定 TTL は 15 分 (900 秒) — docs/05 §8.1。長時間 URL が必要な特殊ケースでのみ
 * `expiresSec` を明示的に上書きすること。
 */
export async function getSignedDownloadUrl(
  key: string,
  expiresSec = 900,
  options: OperationOptions = {},
  /**
   * 指定すると署名 URL に `response-content-disposition=attachment; filename=...`
   * を付与し、ブラウザでのインライン表示ではなく**ダウンロード**を強制する。
   */
  downloadFilename?: string,
): Promise<string> {
  const { client, bucket } = resolveClient(options);
  try {
    const commandInput: ConstructorParameters<typeof GetObjectCommand>[0] = {
      Bucket: bucket,
      Key: key,
    };
    if (downloadFilename) {
      // RFC 5987 で非 ASCII (日本語) ファイル名も安全に渡す。
      const encoded = encodeURIComponent(downloadFilename);
      commandInput.ResponseContentDisposition = `attachment; filename*=UTF-8''${encoded}`;
    }
    const url = await getSignedUrl(client, new GetObjectCommand(commandInput), {
      expiresIn: expiresSec,
    });
    logInfo('r2.signed_url', { key, expiresSec, attachment: Boolean(downloadFilename) });
    return url;
  } catch (err) {
    throw new StorageError('R2 署名付き URL 生成に失敗しました', {
      details: { bucket, key },
      cause: err,
    });
  }
}

/** R2 オブジェクトを削除する (物理削除)。論理削除はキー側で `_deleted/` 移動を行う。 */
export async function deleteObject(key: string, options: OperationOptions = {}): Promise<void> {
  const { client, bucket } = resolveClient(options);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    throw new StorageError('R2 DELETE に失敗しました', {
      details: { bucket, key },
      cause: err,
    });
  }
  logInfo('r2.delete', { key });
}

/** HEAD で メタデータを取得する。存在しないキーは `null`。それ以外の失敗は throw。 */
export async function getObjectMetadata(
  key: string,
  options: OperationOptions = {},
): Promise<ObjectMetadata | null> {
  const { client, bucket } = resolveClient(options);
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const meta: ObjectMetadata = {
      size: typeof res.ContentLength === 'number' ? res.ContentLength : 0,
      contentType: res.ContentType ?? 'application/octet-stream',
    };
    if (res.LastModified) meta.lastModified = res.LastModified;
    const sha = res.Metadata?.sha256;
    if (typeof sha === 'string' && sha.length > 0) meta.sha256 = sha;
    return meta;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new StorageError('R2 HEAD に失敗しました', {
      details: { bucket, key },
      cause: err,
    });
  }
}

/** GET したオブジェクトを Buffer に読み出す。存在しないキーは `null`。 */
export async function downloadBuffer(
  key: string,
  options: OperationOptions = {},
): Promise<Buffer | null> {
  const { client, bucket } = resolveClient(options);
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) return null;
    return await streamToBuffer(res.Body as Readable | ReadableStream<Uint8Array>);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new StorageError('R2 GET に失敗しました', {
      details: { bucket, key },
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
  if (e.Code === 'NoSuchKey' || e.Code === 'NotFound') return true;
  return e.$metadata?.httpStatusCode === 404;
}

async function streamToBuffer(
  stream: Readable | ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const nodeStream =
    stream instanceof Readable
      ? stream
      : Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of nodeStream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

// re-export hash helpers for callers that want raw SHA-256 (e.g. KDP screenshot streaming)
export { sha256Hex, sha256HexFromStream };
