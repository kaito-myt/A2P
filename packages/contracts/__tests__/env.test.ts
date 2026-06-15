import { describe, expect, it, vi } from 'vitest';
import { ENV_KEYS, EnvValidationError, parseEnv } from '../src/env.js';

// 29 項目すべて埋めた最小限の正常 fixture (T-02-13 で API_CRED_KEY 追加)。
const validEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/a2p',
  NEXTAUTH_SECRET: 'a'.repeat(64),
  NEXTAUTH_URL: 'https://a2p.example.com',
  NEXT_PUBLIC_APP_URL: 'https://a2p.example.com',
  AUTH_USERNAME: 'operator',
  AUTH_PASSWORD_HASH: '$2b$12$abcdefghijklmnopqrstuv',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENAI_API_KEY: 'sk-test',
  GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-test',
  TAVILY_API_KEY: 'tvly-test',
  R2_ACCOUNT_ID: 'r2-account',
  R2_ACCESS_KEY_ID: 'r2-key',
  R2_SECRET_ACCESS_KEY: 'r2-secret',
  R2_BUCKET_NAME: 'a2p-artifacts',
  R2_PUBLIC_URL_BASE: 'https://example.r2.cloudflarestorage.com/a2p-artifacts',
  RESEND_API_KEY: 're_test',
  MAIL_FROM: 'a2p@example.com',
  MAIL_TO: 'operator@example.com',
  KDP_CRED_KEY: 'b'.repeat(64),
  API_CRED_KEY: 'c'.repeat(64),
  SENTRY_DSN: 'https://abc@o0.ingest.sentry.io/0',
  LOG_LEVEL: 'info',
  WORKER_BOOK_CONCURRENCY: '5',
  WORKER_CHAPTER_CONCURRENCY: '4',
  MODEL_CATALOG_FETCH_CRON: '0 19 * * *',
  FX_RATE_API_URL: 'https://open.er-api.com/v6/latest/USD',
  COST_LIMIT_PER_BOOK_JPY: '500',
  COST_LIMIT_MONTHLY_JPY: '50000',
});

describe('ENV_KEYS', () => {
  it('docs/03 §5 + T-02-13 の正本である 29 項目を露出する', () => {
    expect(ENV_KEYS).toHaveLength(29);
  });

  it('スキーマと export の集合が一致する', () => {
    const expected = new Set([
      'NODE_ENV',
      'DATABASE_URL',
      'NEXTAUTH_SECRET',
      'NEXTAUTH_URL',
      'NEXT_PUBLIC_APP_URL',
      'AUTH_USERNAME',
      'AUTH_PASSWORD_HASH',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'TAVILY_API_KEY',
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET_NAME',
      'R2_PUBLIC_URL_BASE',
      'RESEND_API_KEY',
      'MAIL_FROM',
      'MAIL_TO',
      'KDP_CRED_KEY',
      'API_CRED_KEY',
      'SENTRY_DSN',
      'LOG_LEVEL',
      'WORKER_BOOK_CONCURRENCY',
      'WORKER_CHAPTER_CONCURRENCY',
      'MODEL_CATALOG_FETCH_CRON',
      'FX_RATE_API_URL',
      'COST_LIMIT_PER_BOOK_JPY',
      'COST_LIMIT_MONTHLY_JPY',
    ]);
    expect(new Set(ENV_KEYS)).toEqual(expected);
  });
});

describe('parseEnv (success cases)', () => {
  it('全項目埋まった env を型変換込みでパースする', () => {
    const env = parseEnv(validEnv(), { onError: 'throw' });
    expect(env.NODE_ENV).toBe('test');
    expect(env.WORKER_BOOK_CONCURRENCY).toBe(5);
    expect(env.WORKER_CHAPTER_CONCURRENCY).toBe(4);
    expect(env.COST_LIMIT_PER_BOOK_JPY).toBe(500);
    expect(env.COST_LIMIT_MONTHLY_JPY).toBe(50000);
  });

  it('任意項目を省略するとデフォルトが適用される', () => {
    const src = validEnv();
    delete src.LOG_LEVEL;
    delete src.WORKER_BOOK_CONCURRENCY;
    delete src.WORKER_CHAPTER_CONCURRENCY;
    delete src.MODEL_CATALOG_FETCH_CRON;
    delete src.FX_RATE_API_URL;
    delete src.COST_LIMIT_PER_BOOK_JPY;
    delete src.COST_LIMIT_MONTHLY_JPY;

    const env = parseEnv(src, { onError: 'throw' });
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.WORKER_BOOK_CONCURRENCY).toBe(5);
    expect(env.WORKER_CHAPTER_CONCURRENCY).toBe(4);
    expect(env.MODEL_CATALOG_FETCH_CRON).toBe('0 19 * * *');
    expect(env.FX_RATE_API_URL).toBe('https://open.er-api.com/v6/latest/USD');
    expect(env.COST_LIMIT_PER_BOOK_JPY).toBe(500);
    expect(env.COST_LIMIT_MONTHLY_JPY).toBe(50000);
  });

  it('Phase 3 専用の KDP_CRED_KEY / 本番のみ必須の NEXTAUTH_URL は省略可能', () => {
    const src = validEnv();
    delete src.KDP_CRED_KEY;
    delete src.API_CRED_KEY;
    delete src.NEXTAUTH_URL;
    delete src.TAVILY_API_KEY;
    delete src.SENTRY_DSN;

    const env = parseEnv(src, { onError: 'throw' });
    expect(env.KDP_CRED_KEY).toBeUndefined();
    expect(env.API_CRED_KEY).toBeUndefined();
    expect(env.NEXTAUTH_URL).toBeUndefined();
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('T-02-13: 4 プロバイダキーは optional 化されており未設定でも parse 通る', () => {
    const src = validEnv();
    delete src.ANTHROPIC_API_KEY;
    delete src.OPENAI_API_KEY;
    delete src.GOOGLE_GENERATIVE_AI_API_KEY;
    delete src.TAVILY_API_KEY;

    const env = parseEnv(src, { onError: 'throw' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
    expect(env.TAVILY_API_KEY).toBeUndefined();
  });

  it('T-02-13: emptyToUndef preprocess — 空文字 optional フィールドは undefined 化される', () => {
    const src = validEnv();
    src.TAVILY_API_KEY = '';
    src.SENTRY_DSN = '';
    src.NEXTAUTH_URL = '';
    src.KDP_CRED_KEY = '';
    src.API_CRED_KEY = '';
    src.ANTHROPIC_API_KEY = '';
    src.OPENAI_API_KEY = '';
    src.GOOGLE_GENERATIVE_AI_API_KEY = '';

    const env = parseEnv(src, { onError: 'throw' });
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.NEXTAUTH_URL).toBeUndefined();
    expect(env.KDP_CRED_KEY).toBeUndefined();
    expect(env.API_CRED_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
  });

  it('T-02-13: 必須フィールドの空文字は依然として拒否される', () => {
    const src = validEnv();
    src.AUTH_USERNAME = '';

    expect(() => parseEnv(src, { onError: 'throw' })).toThrow(EnvValidationError);
  });

  it('T-02-13: KDP_CRED_KEY / API_CRED_KEY に hex 不正値は依然として拒否', () => {
    const src1 = validEnv();
    src1.API_CRED_KEY = 'not-hex';
    expect(() => parseEnv(src1, { onError: 'throw' })).toThrow(EnvValidationError);

    const src2 = validEnv();
    src2.KDP_CRED_KEY = 'too-short';
    expect(() => parseEnv(src2, { onError: 'throw' })).toThrow(EnvValidationError);
  });
});

describe('parseEnv (failure cases)', () => {
  it('必須項目が欠けると process.exit(1) を呼ぶ (既定挙動)', () => {
    const src = validEnv();
    delete src.DATABASE_URL;
    // T-02-13 以降 ANTHROPIC_API_KEY は optional 化されたので、必須継続の R2_ACCOUNT_ID を使う
    delete src.R2_ACCOUNT_ID;

    const writes: string[] = [];
    const stderr = { write: vi.fn((chunk: string) => { writes.push(chunk); return true; }) };
    const exit = vi.fn((_code: number) => {
      throw new Error('__exit_called__');
    }) as unknown as (code: number) => never;

    expect(() => parseEnv(src, { stderr, exit })).toThrow('__exit_called__');
    expect(exit).toHaveBeenCalledWith(1);
    expect(writes.length).toBeGreaterThan(0);
    const combined = writes.join('');
    expect(combined).toContain('DATABASE_URL');
    expect(combined).toContain('R2_ACCOUNT_ID');
  });

  it('onError: throw 指定時は EnvValidationError を投げる', () => {
    const src = validEnv();
    delete src.NEXTAUTH_SECRET;

    expect(() => parseEnv(src, { onError: 'throw' })).toThrow(EnvValidationError);
  });

  it('NEXTAUTH_SECRET の長さ不正を検知する', () => {
    const src = validEnv();
    src.NEXTAUTH_SECRET = 'too-short';

    expect(() => parseEnv(src, { onError: 'throw' })).toThrow(EnvValidationError);
  });

  it('NODE_ENV の不正値を検知する', () => {
    const src = validEnv();
    src.NODE_ENV = 'staging';

    expect(() => parseEnv(src, { onError: 'throw' })).toThrow(EnvValidationError);
  });

  it('WORKER_BOOK_CONCURRENCY が非正なら拒否する', () => {
    const src = validEnv();
    src.WORKER_BOOK_CONCURRENCY = '0';

    expect(() => parseEnv(src, { onError: 'throw' })).toThrow(EnvValidationError);
  });

  it('R2_PUBLIC_URL_BASE が URL でないと拒否する', () => {
    const src = validEnv();
    src.R2_PUBLIC_URL_BASE = 'not-a-url';

    expect(() => parseEnv(src, { onError: 'throw' })).toThrow(EnvValidationError);
  });
});
