/**
 * docs/05 §6.1.3 / F-051・F-052 / T-02-13 — LLM プロバイダ API キー取得ヘルパ。
 *
 * 解決順序:
 *  1. DB (`ApiCredential` テーブル) を引いて復号 → ヒットすればそれを返す
 *  2. DB 未登録なら `process.env` (ANTHROPIC_API_KEY 等) にフォールバック
 *  3. どちらも無ければ `ConfigError`
 *
 * 復号失敗 (`API_CRED_KEY` ローテ漏れ / DB 改ざん) は **env フォールバックせず**
 * `ConfigError` を即時 throw する (運用者に気づかせる)。
 *
 * DB 接続自体が失敗した場合 (PrismaClientKnownRequestError) のみ env にフォールバック。
 *
 * `60s LRU` キャッシュで provider あたり最大 1 query/min に抑える。
 * UI が `setApiCredential` 等で更新したら `invalidateApiKeyCache(provider)` を呼ぶ。
 */
import { LRUCache } from 'lru-cache';

import { ConfigError } from '@a2p/contracts/errors';
import { decryptApiKey } from '@a2p/crypto';
import { prisma } from '@a2p/db';

export type ApiKeyProvider = 'anthropic' | 'openai' | 'google';

const ENV_VAR_MAP: Record<ApiKeyProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

interface CacheValue {
  key: string;
}

const cache = new LRUCache<ApiKeyProvider, CacheValue>({
  max: 10,
  ttl: 60_000,
});

interface GetApiKeyDeps {
  apiCredentialRepo?: {
    findUnique(args: {
      where: { provider: string };
    }): Promise<{ key_enc: string } | null>;
  };
  env?: NodeJS.ProcessEnv;
  /** DB ヒット時の復号関数 (テスト時に差し替え可)。 */
  decrypt?: (enc: string) => string;
}

function readFromEnv(provider: ApiKeyProvider, env: NodeJS.ProcessEnv): string | undefined {
  const name = ENV_VAR_MAP[provider];
  const v = env[name];
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return v;
}

/**
 * docs/05 §13 #1 — Prisma の既知エラーは「DB 取得失敗」として env にフォールバックしてよい。
 * ただし、`PrismaClientValidationError` 等 (我々のスキーマ不整合) は throw に任せる。
 */
function isTransientDbError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (typeof name !== 'string') return false;
  return (
    name === 'PrismaClientKnownRequestError' ||
    name === 'PrismaClientUnknownRequestError' ||
    name === 'PrismaClientRustPanicError' ||
    name === 'PrismaClientInitializationError'
  );
}

/**
 * provider の API キーを取得。詳細はファイル冒頭コメント参照。
 *
 * @throws ConfigError DB 未登録 + env 未設定、または DB 復号失敗。
 */
export async function getApiKey(
  provider: ApiKeyProvider,
  deps: GetApiKeyDeps = {},
): Promise<string> {
  const cached = cache.get(provider);
  if (cached) return cached.key;

  const env = deps.env ?? process.env;
  const repo = deps.apiCredentialRepo ?? prisma.apiCredential;
  const decrypt = deps.decrypt ?? decryptApiKey;

  let row: { key_enc: string } | null = null;
  try {
    row = await repo.findUnique({ where: { provider } });
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    row = null;
  }

  if (row) {
    // 改ざん検知のため、ここでの復号失敗は env フォールバックせず即時 throw。
    let plain: string;
    try {
      plain = decrypt(row.key_enc);
    } catch (err) {
      throw new ConfigError(
        `Failed to decrypt API key for provider=${provider} (check API_CRED_KEY rotation)`,
        {
          userMessage: `API キー (${provider}) の復号に失敗しました。API_CRED_KEY を確認してください`,
          cause: err,
        },
      );
    }
    cache.set(provider, { key: plain });
    return plain;
  }

  const fromEnv = readFromEnv(provider, env);
  if (fromEnv !== undefined) {
    cache.set(provider, { key: fromEnv });
    return fromEnv;
  }

  throw new ConfigError(
    `API key for provider=${provider} is not configured (no DB row, no env ${ENV_VAR_MAP[provider]})`,
    {
      userMessage: `${provider} の API キーが未設定です。設定画面または .env から登録してください`,
    },
  );
}

/**
 * 指定プロバイダ (または全プロバイダ) のキャッシュを破棄する。
 * `setApiCredential` / `revokeApiCredential` / 鍵ローテ時に呼ぶ。
 */
export function invalidateApiKeyCache(provider?: ApiKeyProvider): void {
  if (provider === undefined) {
    cache.clear();
    return;
  }
  cache.delete(provider);
}

/** テスト用: 内部キャッシュサイズを取得。 */
export function _getCacheSize(): number {
  return cache.size;
}
