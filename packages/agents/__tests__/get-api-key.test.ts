import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '@a2p/contracts/errors';

// `@a2p/db` (Prisma) を引かないようモック化する。`getApiKey` には deps 注入の口があるため
// 単体テストでは直接 deps を渡し、プロバイダ別 env を mock する。
vi.mock('@a2p/db', () => ({ prisma: { apiCredential: { findUnique: vi.fn() } } }));
vi.mock('@a2p/crypto', () => ({
  decryptApiKey: vi.fn((enc: string) => `dec(${enc})`),
}));

import {
  _getCacheSize,
  getApiKey,
  invalidateApiKeyCache,
} from '../src/lib/get-api-key.js';

function makeRepo(rows: Record<string, { key_enc: string } | null>) {
  return {
    findUnique: vi.fn(async ({ where }: { where: { provider: string } }) => rows[where.provider] ?? null),
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  invalidateApiKeyCache();
  for (const k of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
  ]) {
    delete process.env[k];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  invalidateApiKeyCache();
});

describe('getApiKey', () => {
  it('DB ヒット時は復号値を返す (env より DB 優先)', async () => {
    const repo = makeRepo({ anthropic: { key_enc: 'ENC_AAA' } });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-fallback';

    const v = await getApiKey('anthropic', {
      apiCredentialRepo: repo,
      decrypt: (e) => `decrypted:${e}`,
      env: process.env,
    });
    expect(v).toBe('decrypted:ENC_AAA');
    expect(repo.findUnique).toHaveBeenCalledTimes(1);
  });

  it('DB miss → env フォールバック', async () => {
    const repo = makeRepo({ openai: null });
    process.env.OPENAI_API_KEY = 'sk-openai-from-env';

    const v = await getApiKey('openai', {
      apiCredentialRepo: repo,
      decrypt: () => 'should-not-be-called',
      env: process.env,
    });
    expect(v).toBe('sk-openai-from-env');
  });

  it('DB miss + env miss → ConfigError', async () => {
    const repo = makeRepo({ google: null });
    await expect(
      getApiKey('google', { apiCredentialRepo: repo, env: {} }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('DB ヒット + 復号失敗 → ConfigError (env フォールバックしない / 改ざん検知)', async () => {
    const repo = makeRepo({ anthropic: { key_enc: 'BROKEN' } });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-fallback';
    await expect(
      getApiKey('anthropic', {
        apiCredentialRepo: repo,
        decrypt: () => {
          throw new Error('GCM authTag mismatch');
        },
        env: process.env,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('DB 接続失敗 (PrismaClientKnownRequestError 模擬) → env フォールバック', async () => {
    const repo = {
      findUnique: vi.fn(async () => {
        const err = new Error('connection lost');
        (err as { name: string }).name = 'PrismaClientKnownRequestError';
        throw err;
      }),
    };
    process.env.OPENAI_API_KEY = 'sk-openai-env';
    const v = await getApiKey('openai', { apiCredentialRepo: repo, env: process.env });
    expect(v).toBe('sk-openai-env');
  });

  it('既知でない DB エラーは throw を呑まない (バグ顕在化)', async () => {
    const repo = {
      findUnique: vi.fn(async () => {
        throw new TypeError('boom unknown');
      }),
    };
    await expect(
      getApiKey('anthropic', { apiCredentialRepo: repo, env: {} }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('60 秒キャッシュ — 2 回目は DB 問い合わせを発生させない', async () => {
    const repo = makeRepo({ anthropic: { key_enc: 'ENC_X' } });
    const a = await getApiKey('anthropic', { apiCredentialRepo: repo, decrypt: () => 'KEYX' });
    const b = await getApiKey('anthropic', { apiCredentialRepo: repo, decrypt: () => 'KEYX' });
    expect(a).toBe('KEYX');
    expect(b).toBe('KEYX');
    expect(repo.findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidate 後は再度 DB から読み直す', async () => {
    let current: { key_enc: string } | null = { key_enc: 'ENC_V1' };
    const repo = {
      findUnique: vi.fn(async () => current),
    };
    let decryptCount = 0;
    const decrypt = (e: string) => `dec(${e})${++decryptCount}`;

    const a = await getApiKey('google', { apiCredentialRepo: repo, decrypt });
    invalidateApiKeyCache('google');
    current = { key_enc: 'ENC_V2' };
    const b = await getApiKey('google', { apiCredentialRepo: repo, decrypt });

    expect(a).toBe('dec(ENC_V1)1');
    expect(b).toBe('dec(ENC_V2)2');
    expect(repo.findUnique).toHaveBeenCalledTimes(2);
  });

  it('invalidate (provider 省略) で全プロバイダ クリア', async () => {
    const repo = makeRepo({
      anthropic: { key_enc: 'A' },
      openai: { key_enc: 'B' },
    });
    await getApiKey('anthropic', { apiCredentialRepo: repo, decrypt: (x) => x });
    await getApiKey('openai', { apiCredentialRepo: repo, decrypt: (x) => x });
    expect(_getCacheSize()).toBe(2);
    invalidateApiKeyCache();
    expect(_getCacheSize()).toBe(0);
  });

  it('env フォールバック値もキャッシュされる (2 回目は env 参照しない)', async () => {
    const repo = makeRepo({ openai: null });
    let envReads = 0;
    const envProxy = new Proxy(
      { OPENAI_API_KEY: 'sk-openai-env' } as NodeJS.ProcessEnv,
      {
        get(target, key) {
          envReads++;
          return (target as Record<string, string>)[key as string];
        },
      },
    );

    await getApiKey('openai', { apiCredentialRepo: repo, env: envProxy });
    await getApiKey('openai', { apiCredentialRepo: repo, env: envProxy });
    expect(envReads).toBe(1);
    expect(repo.findUnique).toHaveBeenCalledTimes(1);
  });
});
