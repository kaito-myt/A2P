'use server';

/**
 * API Credentials Server Actions (T-02-13, F-051/F-052).
 *
 * UI 本体 (S-027 設定画面) は SP-07 で実装するが、SA + DB 基盤を SP-02 で
 * 確立しないと後続 T-02-03/04/06/09 が env 直読みで書かれて手戻りが出る。
 *
 * SA は薄いラッパ。zod 検証 / 暗号化 / audit_log は `lib/api-credentials-core.ts` 側。
 *
 * 仕様根拠: docs/05 §4.3.X.
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { decryptApiKey, encryptApiKey, maskApiKey } from '@a2p/crypto';
import { prisma } from '@a2p/db';
import { invalidateApiKeyCache, type ApiKeyProvider } from '@a2p/agents/lib/get-api-key';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';
import {
  revokeApiCredentialCore,
  setApiCredentialCore,
  testApiCredentialCore,
  type ApiCredentialsDeps,
  type ApiProvider,
  type ProviderTestClient,
} from '@/lib/api-credentials-core';

/**
 * 各 provider の公開エンドポイントを `fetch()` で叩いて疎通テスト。
 * 公式 SDK を持ち込まず追加依存ゼロで実装する (msw でモック容易)。
 * 失敗は throw せず `{ ok: false, message }` で返す (UI が表示)。
 */
const PROVIDER_TEST_ENDPOINTS: Record<
  ApiProvider,
  (key: string) => { url: string; headers: Record<string, string> }
> = {
  anthropic: (key) => ({
    url: 'https://api.anthropic.com/v1/models',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
  }),
  openai: (key) => ({
    url: 'https://api.openai.com/v1/models',
    headers: { Authorization: `Bearer ${key}` },
  }),
  google: (key) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    headers: {},
  }),
};

const defaultTestClient: ProviderTestClient = async (provider, plain) => {
  const started = Date.now();
  const { url, headers } = PROVIDER_TEST_ENDPOINTS[provider](plain);
  try {
    const res = await fetch(url, { method: 'GET', headers });
    const latency = Date.now() - started;
    if (res.ok) {
      return { ok: true, message: 'OK', http_status: res.status, latency_ms: latency };
    }
    let body = '';
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      // ignore body read failure
    }
    return {
      ok: false,
      message: body || `HTTP ${res.status}`,
      http_status: res.status,
      latency_ms: latency,
    };
  } catch (err) {
    return {
      ok: false,
      message:
        err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
          ? err.message
          : messages.apiCredentials.testFailureGeneric,
      latency_ms: Date.now() - started,
    };
  }
};

async function buildDeps(testClient?: ProviderTestClient): Promise<ApiCredentialsDeps> {
  const session = await getSessionOrThrow();
  return {
    apiCredentialRepo: prisma.apiCredential,
    auditLogRepo: prisma.auditLog,
    session,
    encrypt: (plain) => encryptApiKey(plain),
    decrypt: (enc) => decryptApiKey(enc),
    mask: (plain) => maskApiKey(plain),
    invalidateCache: (provider) => invalidateApiKeyCache(provider as ApiKeyProvider),
    testClient: testClient ?? defaultTestClient,
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.apiCredentials.errors.unknown);
}

export async function setApiCredential(
  input: unknown,
): Promise<ActionResult<{ provider: ApiProvider; key_mask: string }>> {
  let deps: ApiCredentialsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await setApiCredentialCore(input, deps);
  if (result.ok) revalidatePath('/settings');
  return result;
}

export async function revokeApiCredential(
  input: unknown,
): Promise<ActionResult<void>> {
  let deps: ApiCredentialsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await revokeApiCredentialCore(input, deps);
  if (result.ok) revalidatePath('/settings');
  return result;
}

export async function testApiCredential(
  input: unknown,
): Promise<
  ActionResult<{ ok: boolean; message: string; http_status?: number; latency_ms?: number }>
> {
  let deps: ApiCredentialsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const result = await testApiCredentialCore(input, deps);
  if (result.ok) revalidatePath('/settings');
  return result;
}
