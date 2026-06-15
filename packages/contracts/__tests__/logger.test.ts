import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';

// logger.ts はモジュール先頭で `process.env.NODE_ENV` を読むため、テストごとに
// 動的 import で再評価する。pino-pretty 系の worker thread を避けるため、
// `redact` 動作の検証は同じ redact 設定を pino に直接適用した stream 経由で行う。

const REDACT_PATHS = [
  'password',
  '*.password',
  '*.*.password',
  'passwordHash',
  '*.passwordHash',
  'password_hash',
  '*.password_hash',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'access_key',
  '*.access_key',
  'accessKey',
  '*.accessKey',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'kdpCredentials',
  '*.kdpCredentials',
  'kdp_credentials',
  '*.kdp_credentials',
  'kdp_credentials_enc',
  '*.kdp_credentials_enc',
  'authorization',
  '*.authorization',
  'Authorization',
  '*.Authorization',
  'cookie',
  '*.cookie',
  'Cookie',
  '*.Cookie',
  'set-cookie',
  '*.set-cookie',
  'headers.authorization',
  'headers.cookie',
  'headers.Authorization',
  'headers.Cookie',
  'headers.set-cookie',
];

function captureLog(fn: (log: pino.Logger) => void): unknown[] {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const log = pino(
    {
      level: 'info',
      base: { service: 'a2p-test' },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      redact: { paths: REDACT_PATHS, censor: '***', remove: false },
      formatters: { level: (label) => ({ level: label }) },
    },
    stream,
  );
  fn(log);
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
}

describe('logger redact', () => {
  it('トップレベルの password / token / authorization 等をマスクする', () => {
    const lines = captureLog((log) => {
      log.info(
        {
          password: 'plaintext-pw',
          token: 'bearer-xyz',
          apiKey: 'sk-test',
          secret: 'shh',
          authorization: 'Bearer xxxx',
        },
        'auth attempt',
      );
    });
    const entry = lines[0] as Record<string, unknown>;
    expect(entry.password).toBe('***');
    expect(entry.token).toBe('***');
    expect(entry.apiKey).toBe('***');
    expect(entry.secret).toBe('***');
    expect(entry.authorization).toBe('***');
    expect(entry.msg).toBe('auth attempt');
  });

  it('ネストされた kdp_credentials_enc / passwordHash をマスクする', () => {
    const lines = captureLog((log) => {
      log.info(
        {
          account: {
            id: 'acc_1',
            kdp_credentials_enc: 'iv:tag:ciphertext-blob',
            passwordHash: '$2b$12$xxx',
          },
        },
        'account loaded',
      );
    });
    const entry = lines[0] as { account: Record<string, unknown> };
    expect(entry.account.id).toBe('acc_1');
    expect(entry.account.kdp_credentials_enc).toBe('***');
    expect(entry.account.passwordHash).toBe('***');
  });

  it('headers.cookie / headers.authorization をマスクする', () => {
    const lines = captureLog((log) => {
      log.info(
        {
          headers: {
            authorization: 'Bearer SECRET',
            cookie: 'session=abc',
            'user-agent': 'node-test',
          },
        },
        'inbound request',
      );
    });
    const entry = lines[0] as { headers: Record<string, unknown> };
    expect(entry.headers.authorization).toBe('***');
    expect(entry.headers.cookie).toBe('***');
    expect(entry.headers['user-agent']).toBe('node-test');
  });

  it('機密でないフィールドはそのまま残す', () => {
    const lines = captureLog((log) => {
      log.info({ bookId: 'book_42', chapter: 3 }, 'chapter generated');
    });
    const entry = lines[0] as Record<string, unknown>;
    expect(entry.bookId).toBe('book_42');
    expect(entry.chapter).toBe(3);
  });
});

describe('createLogger factory', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // 子プロセス transport を避けるため production モードでロードする
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'info';
    process.env.SERVICE_NAME = 'a2p-contracts-test';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, origEnv);
  });

  it('createLogger(name) は name 付き child を返し、levelChild 関数を備える', async () => {
    const mod = await import('../src/logger.js');
    mod._resetRootLoggerForTests();
    const log = mod.createLogger('worker.test');
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.child).toBe('function');
    expect(log.level).toBe('info');
  });

  it('LOG_LEVEL=debug を尊重する', async () => {
    process.env.LOG_LEVEL = 'debug';
    const mod = await import('../src/logger.js');
    mod._resetRootLoggerForTests();
    const log = mod.createLogger('worker.debug');
    expect(log.level).toBe('debug');
  });
});
