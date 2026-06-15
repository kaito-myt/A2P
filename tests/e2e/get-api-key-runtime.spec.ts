/**
 * Runtime verification spec for T-02-13
 *
 * SP-02 では API キー設定 UI (S-027) はまだ実装されていないため、
 * 通常の Playwright (ブラウザ操作 → DOM 検証) で F-051/F-052 を検証することはできない。
 * 代わりに以下の API レイヤを Node ランタイム上で直接呼び出して検証する:
 *
 *   1. getApiKey('anthropic'|'openai'|'google') の env フォールバック動作
 *      (DB に api_credentials が無い初期状態で .env.local の値が返ることを確認)
 *   2. setApiCredentialCore → getApiKey (DB 経路) → revokeApiCredentialCore →
 *      getApiKey (env 経路) の round-trip
 *      → cache invalidation が `invalidateApiKeyCache` 経由で効くことも確認
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner として
 *     借用し、@a2p/db / @a2p/agents / @a2p/crypto を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local が前提 (playwright.config.ts が dotenv.config を実行済み)。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { getApiKey, invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';
import { encryptApiKey, decryptApiKey, maskApiKey } from '@a2p/crypto';
import {
  setApiCredentialCore,
  revokeApiCredentialCore,
} from '../../apps/web/lib/api-credentials-core';

test.describe('runtime: API キー解決 (T-02-13)', () => {
  test.beforeAll(async () => {
    // api_credentials を全クリアし、env フォールバックの素状態に戻す
    await prisma.apiCredential.deleteMany({});
    invalidateApiKeyCache();
  });

  test.afterAll(async () => {
    await prisma.apiCredential.deleteMany({});
    await prisma.auditLog.deleteMany({
      where: { target_kind: 'api_credential' },
    });
    invalidateApiKeyCache();
    await prisma.$disconnect();
  });

  test('env フォールバック: anthropic / openai / google が .env.local の値を返す', async () => {
    invalidateApiKeyCache();

    // DB は空 → env フォールバック経路
    const before = await prisma.apiCredential.count();
    expect(before).toBe(0);

    const anth = await getApiKey('anthropic');
    expect(anth).toMatch(/^sk-ant-api03-/);
    expect(anth).toBe(process.env.ANTHROPIC_API_KEY);

    const oai = await getApiKey('openai');
    expect(oai).toMatch(/^sk-proj-/);
    expect(oai).toBe(process.env.OPENAI_API_KEY);

    const gem = await getApiKey('google');
    expect(gem.length).toBeGreaterThan(0);
    expect(gem).toBe(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

    invalidateApiKeyCache();
  });

  test('round-trip: setApiCredentialCore → DB 経路 → revoke → env 経路', async () => {
    invalidateApiKeyCache();

    // 0. 検証用 User を確保 (AuditLog.actor_id FK 用)
    const operator = await prisma.user.upsert({
      where: { username: process.env.AUTH_USERNAME ?? 'operator' },
      create: {
        username: process.env.AUTH_USERNAME ?? 'operator',
        password_hash: process.env.AUTH_PASSWORD_HASH ?? 'placeholder',
      },
      update: {},
    });

    const fakeSession = {
      user: { id: operator.id, username: operator.username },
    };

    // 1. ダミーキーを DB に登録
    const dummyKey = 'sk-ant-test-key-12345';
    const setResult = await setApiCredentialCore(
      { provider: 'anthropic', key: dummyKey },
      {
        apiCredentialRepo: prisma.apiCredential,
        auditLogRepo: prisma.auditLog,
        session: fakeSession,
        encrypt: (p) => encryptApiKey(p),
        decrypt: (e) => decryptApiKey(e),
        mask: (p) => maskApiKey(p),
        invalidateCache: (provider) => invalidateApiKeyCache(provider),
      },
    );
    expect(setResult.ok).toBe(true);
    if (setResult.ok) {
      expect(setResult.data.provider).toBe('anthropic');
      expect(setResult.data.key_mask).toContain('…');
    }

    // 2. DB 経路で同じキーが返ることを確認
    invalidateApiKeyCache();
    const fromDb = await getApiKey('anthropic');
    expect(fromDb).toBe(dummyKey);
    expect(fromDb).not.toBe(process.env.ANTHROPIC_API_KEY);

    // 3. キャッシュ確認: 2 回目呼び出しでも同じ値 (DB 問い合わせは内部キャッシュで省略)
    const cached = await getApiKey('anthropic');
    expect(cached).toBe(dummyKey);

    // 4. revoke
    const revokeResult = await revokeApiCredentialCore(
      { provider: 'anthropic' },
      {
        apiCredentialRepo: prisma.apiCredential,
        auditLogRepo: prisma.auditLog,
        session: fakeSession,
        invalidateCache: (provider) => invalidateApiKeyCache(provider),
      },
    );
    expect(revokeResult.ok).toBe(true);

    // 5. revoke 後は env 経路に戻る
    invalidateApiKeyCache();
    const afterRevoke = await getApiKey('anthropic');
    expect(afterRevoke).toMatch(/^sk-ant-api03-/);
    expect(afterRevoke).toBe(process.env.ANTHROPIC_API_KEY);

    // AuditLog 検証 (set 1 件 + revoke 1 件)
    const logs = await prisma.auditLog.findMany({
      where: { target_kind: 'api_credential' },
      orderBy: { created_at: 'asc' },
    });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const actions = logs.map((l) => l.action);
    expect(actions).toContain('api_credential.set');
    expect(actions).toContain('api_credential.revoke');
  });
});
