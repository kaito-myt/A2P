import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageError } from '@a2p/contracts/errors';

// `@aws-sdk/s3-request-presigner` をモック化 (実 HTTP は行わない)
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example/r2/key?sig=test'),
}));

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  _resetR2ClientForTests,
  _setR2ClientForTests,
} from '../src/client.js';
import {
  deleteObject,
  downloadBuffer,
  getObjectMetadata,
  getSignedDownloadUrl,
  uploadBuffer,
  uploadStream,
} from '../src/operations.js';
import { sha256Hex } from '../src/hash.js';

const BUCKET = 'a2p-test';

interface StubClient {
  send: ReturnType<typeof vi.fn>;
}

function makeClient(responder: (cmd: unknown) => unknown): StubClient {
  return {
    send: vi.fn(async (cmd: unknown) => responder(cmd)),
  };
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  _resetR2ClientForTests();
  vi.mocked(getSignedUrl).mockClear();
});

afterEach(() => {
  _resetR2ClientForTests();
});

describe('uploadBuffer', () => {
  it('PutObjectCommand を bucket/key/contentType/sha256 付きで送る', async () => {
    const client = makeClient(() => ({ ETag: 'etag-1' }));
    _setR2ClientForTests(client as never, BUCKET);

    const body = Buffer.from('hello world', 'utf8');
    const result = await uploadBuffer('books/abc/manuscript/final.docx', body, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    expect(result).toEqual({
      key: 'books/abc/manuscript/final.docx',
      sha256: sha256Hex(body),
      size: body.byteLength,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(client.send).toHaveBeenCalledTimes(1);
    const cmd = client.send.mock.calls[0]?.[0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    const input = (cmd as PutObjectCommand).input;
    expect(input.Bucket).toBe(BUCKET);
    expect(input.Key).toBe('books/abc/manuscript/final.docx');
    expect(input.ContentType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(input.ContentLength).toBe(body.byteLength);
    expect(input.Metadata).toEqual({ sha256: sha256Hex(body) });
    expect(input.Body).toBe(body);
  });

  it('S3Client.send が throw すると StorageError でラップする', async () => {
    const client = makeClient(() => {
      throw new Error('network down');
    });
    _setR2ClientForTests(client as never, BUCKET);

    await expect(
      uploadBuffer('books/abc/x.docx', Buffer.from('x'), 'application/octet-stream'),
    ).rejects.toBeInstanceOf(StorageError);
  });
});

describe('uploadStream', () => {
  it('PutObjectCommand をストリーム Body で送る', async () => {
    const client = makeClient(() => ({}));
    _setR2ClientForTests(client as never, BUCKET);

    const stream = Readable.from([Buffer.from('chunk-1'), Buffer.from('chunk-2')]);
    const result = await uploadStream('books/abc/cover.png', stream, 'image/png', 14);

    expect(result).toEqual({ key: 'books/abc/cover.png', size: 14, contentType: 'image/png' });
    const cmd = client.send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input.Bucket).toBe(BUCKET);
    expect(cmd.input.Key).toBe('books/abc/cover.png');
    expect(cmd.input.ContentLength).toBe(14);
    expect(cmd.input.ContentType).toBe('image/png');
    expect(cmd.input.Body).toBe(stream);
  });
});

describe('getSignedDownloadUrl', () => {
  it('既定 TTL 900 秒 (15 分、docs/05 §8.1) で署名付き URL を返す', async () => {
    const client = makeClient(() => ({}));
    _setR2ClientForTests(client as never, BUCKET);

    const url = await getSignedDownloadUrl('books/abc/final.pdf');

    expect(url).toBe('https://signed.example/r2/key?sig=test');
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const [, command, opts] = vi.mocked(getSignedUrl).mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input.Bucket).toBe(BUCKET);
    expect((command as GetObjectCommand).input.Key).toBe('books/abc/final.pdf');
    expect(opts).toEqual({ expiresIn: 900 });
  });

  it('expiresSec を上書きできる', async () => {
    const client = makeClient(() => ({}));
    _setR2ClientForTests(client as never, BUCKET);

    await getSignedDownloadUrl('books/abc/final.pdf', 3600);
    const [, , opts] = vi.mocked(getSignedUrl).mock.calls[0] ?? [];
    expect(opts).toEqual({ expiresIn: 3600 });
  });

  it('presigner が throw すると StorageError でラップする', async () => {
    const client = makeClient(() => ({}));
    _setR2ClientForTests(client as never, BUCKET);
    vi.mocked(getSignedUrl).mockRejectedValueOnce(new Error('boom'));

    await expect(getSignedDownloadUrl('x')).rejects.toBeInstanceOf(StorageError);
  });
});

describe('deleteObject', () => {
  it('DeleteObjectCommand を送る', async () => {
    const client = makeClient(() => ({}));
    _setR2ClientForTests(client as never, BUCKET);

    await deleteObject('books/abc/final.pdf');

    const cmd = client.send.mock.calls[0]?.[0] as DeleteObjectCommand;
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input.Bucket).toBe(BUCKET);
    expect(cmd.input.Key).toBe('books/abc/final.pdf');
  });

  it('send 失敗で StorageError', async () => {
    const client = makeClient(() => {
      throw new Error('forbidden');
    });
    _setR2ClientForTests(client as never, BUCKET);
    await expect(deleteObject('x')).rejects.toBeInstanceOf(StorageError);
  });
});

describe('getObjectMetadata', () => {
  it('HEAD の結果を ObjectMetadata に変換する', async () => {
    const lastModified = new Date('2026-05-17T00:00:00Z');
    const client = makeClient(() => ({
      ContentLength: 1234,
      ContentType: 'application/pdf',
      Metadata: { sha256: 'abc'.repeat(21) + 'd' },
      LastModified: lastModified,
    }));
    _setR2ClientForTests(client as never, BUCKET);

    const meta = await getObjectMetadata('books/abc/final.pdf');
    expect(meta).toEqual({
      size: 1234,
      contentType: 'application/pdf',
      sha256: 'abc'.repeat(21) + 'd',
      lastModified,
    });
    const cmd = client.send.mock.calls[0]?.[0] as HeadObjectCommand;
    expect(cmd).toBeInstanceOf(HeadObjectCommand);
  });

  it('404 系 (NotFound) は null を返す', async () => {
    const client = makeClient(() => {
      const err = new Error('not found') as Error & { name: string; $metadata: { httpStatusCode: number } };
      err.name = 'NotFound';
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    });
    _setR2ClientForTests(client as never, BUCKET);

    expect(await getObjectMetadata('missing')).toBeNull();
  });

  it('NoSuchKey も null を返す', async () => {
    const client = makeClient(() => {
      const err = new Error('no such key') as Error & { name: string };
      err.name = 'NoSuchKey';
      throw err;
    });
    _setR2ClientForTests(client as never, BUCKET);
    expect(await getObjectMetadata('missing')).toBeNull();
  });

  it('それ以外のエラーは StorageError', async () => {
    const client = makeClient(() => {
      throw new Error('5xx');
    });
    _setR2ClientForTests(client as never, BUCKET);
    await expect(getObjectMetadata('x')).rejects.toBeInstanceOf(StorageError);
  });

  it('ContentLength 欠落時は size=0 / sha256 欠落時は undefined', async () => {
    const client = makeClient(() => ({ ContentType: 'image/png' }));
    _setR2ClientForTests(client as never, BUCKET);
    const meta = await getObjectMetadata('x');
    expect(meta).toEqual({ size: 0, contentType: 'image/png' });
  });
});

describe('downloadBuffer', () => {
  it('Body ストリームを Buffer に読み出す', async () => {
    const body = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const client = makeClient(() => ({ Body: body }));
    _setR2ClientForTests(client as never, BUCKET);

    const out = await downloadBuffer('books/abc/final.pdf');
    expect(out).not.toBeNull();
    expect(out?.toString('utf8')).toBe('hello world');
    const cmd = client.send.mock.calls[0]?.[0] as GetObjectCommand;
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    expect(cmd.input.Bucket).toBe(BUCKET);
    expect(cmd.input.Key).toBe('books/abc/final.pdf');
  });

  it('404 系は null を返す', async () => {
    const client = makeClient(() => {
      const err = new Error('not found') as Error & { name: string };
      err.name = 'NoSuchKey';
      throw err;
    });
    _setR2ClientForTests(client as never, BUCKET);
    expect(await downloadBuffer('missing')).toBeNull();
  });

  it('Body 欠落時は null', async () => {
    const client = makeClient(() => ({}));
    _setR2ClientForTests(client as never, BUCKET);
    expect(await downloadBuffer('x')).toBeNull();
  });
});

describe('options による DI', () => {
  it('options.client / options.bucket でシングルトンを上書きできる', async () => {
    const stub = makeClient(() => ({}));
    await uploadBuffer('books/abc/x.docx', Buffer.from('x'), 'application/octet-stream', {
      client: stub as never,
      bucket: 'override-bucket',
    });
    const cmd = stub.send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(cmd.input.Bucket).toBe('override-bucket');
  });
});
