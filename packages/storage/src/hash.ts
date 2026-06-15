import { createHash, type BinaryLike } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * SHA-256 helpers (docs/05 §8.1: アップロード時に SHA-256 を計算し
 * `Artifact.checksum` に hex で保存)。
 */

export function sha256Hex(data: BinaryLike): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Node Readable / Web ReadableStream のいずれも受ける。完全消費するので注意。 */
export async function sha256HexFromStream(
  stream: Readable | ReadableStream<Uint8Array>,
): Promise<string> {
  const hash = createHash('sha256');
  const nodeStream =
    stream instanceof Readable
      ? stream
      : // Node 22 の `Readable.fromWeb` は型上 lib.dom と node:stream/web の整合が
        // 取れず ts(2345) になるため、明示的に unknown 経由でキャストする
        Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
  for await (const chunk of nodeStream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
