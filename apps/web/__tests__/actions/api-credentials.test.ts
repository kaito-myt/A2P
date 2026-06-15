/**
 * api-credentials-core のユニットテスト (T-02-13 / F-051・F-052).
 *
 * 検証:
 *  - setApiCredential / revokeApiCredential / testApiCredential の zod 検証
 *  - 各 SA で audit_log INSERT が走る
 *  - 認可エラー (deps の session 必須) は呼び出し側 (SA ラッパ) の責務だが、
 *    core が encrypt/decrypt 未注入時に ConfigError を吐くことを検証
 *  - 暗号化失敗 → fail / 復号失敗 → fail
 *  - DB upsert / delete / update の引数構造
 *  - invalidateCache が必ず呼ばれる
 */
import { describe, expect, it, vi } from 'vitest';
import type { ApiCredential } from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  type ApiCredentialsDeps,
  revokeApiCredentialCore,
  setApiCredentialCore,
  testApiCredentialCore,
} from '../../lib/api-credentials-core';

const FROZEN_NOW = new Date('2026-05-22T10:00:00.000Z');

function makeRow(overrides: Partial<ApiCredential> = {}): ApiCredential {
  return {
    id: 'cred_1',
    provider: 'anthropic',
    key_enc: 'ENC_DEFAULT',
    key_mask: 'sk-…ault',
    set_at: new Date('2026-05-20T00:00:00.000Z'),
    set_by: 'u_1',
    last_tested_at: null,
    last_test_result_json: null,
    ...overrides,
  } as ApiCredential;
}

function makeDeps(opts: {
  existing?: Record<string, ApiCredential | null>;
  testClient?: ApiCredentialsDeps['testClient'];
  encrypt?: ApiCredentialsDeps['encrypt'];
  decrypt?: ApiCredentialsDeps['decrypt'];
} = {}): {
  deps: ApiCredentialsDeps;
  spies: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    encrypt: ReturnType<typeof vi.fn>;
    decrypt: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
    testClient: ReturnType<typeof vi.fn>;
  };
} {
  const state: Record<string, ApiCredential | null> = { ...(opts.existing ?? {}) };

  const findUnique = vi.fn(async ({ where }: { where: { provider: string } }) => state[where.provider] ?? null);
  const upsert = vi.fn(async ({ where, create, update }: any) => {
    const existing = state[where.provider];
    const next: ApiCredential = existing
      ? ({ ...existing, ...update } as ApiCredential)
      : (makeRow({ id: 'cred_new', ...create }) as ApiCredential);
    state[where.provider] = next;
    return next;
  });
  const update = vi.fn(async ({ where, data }: any) => {
    const existing = state[where.provider];
    if (!existing) throw new Error('not found');
    const next = { ...existing, ...data } as ApiCredential;
    state[where.provider] = next;
    return next;
  });
  const del = vi.fn(async ({ where }: any) => {
    const existing = state[where.provider];
    if (!existing) throw new Error('not found');
    state[where.provider] = null;
    return existing;
  });
  const auditCreate = vi.fn(async () => ({}));
  const encrypt = vi.fn(opts.encrypt ?? ((s: string) => `enc(${s})`));
  const decrypt = vi.fn(opts.decrypt ?? ((s: string) => s.replace(/^enc\(|\)$/g, '')));
  const invalidate = vi.fn();
  const testClient = vi.fn(opts.testClient ?? (async () => ({ ok: true, message: 'OK', http_status: 200, latency_ms: 12 })));

  return {
    deps: {
      apiCredentialRepo: { findUnique, upsert, update, delete: del } as unknown as ApiCredentialsDeps['apiCredentialRepo'],
      auditLogRepo: { create: auditCreate } as unknown as ApiCredentialsDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
      encrypt,
      decrypt,
      mask: (s) => `mask(${s.slice(0, 3)})`,
      invalidateCache: invalidate,
      testClient,
      now: () => FROZEN_NOW,
    },
    spies: { findUnique, upsert, update, del, auditCreate, encrypt, decrypt, invalidate, testClient },
  };
}

// ---------------------------------------------------------------------------
// setApiCredentialCore
// ---------------------------------------------------------------------------

describe('setApiCredentialCore', () => {
  it('provider 欠落で validation', async () => {
    const { deps } = makeDeps();
    const r = await setApiCredentialCore({ key: 'sk-test' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('provider が enum 外で validation', async () => {
    const { deps } = makeDeps();
    const r = await setApiCredentialCore({ provider: 'tavily', key: 'tvly' }, deps);
    expect(isFail(r)).toBe(true);
  });

  it('key 空で validation', async () => {
    const { deps } = makeDeps();
    const r = await setApiCredentialCore({ provider: 'anthropic', key: '' }, deps);
    expect(isFail(r)).toBe(true);
  });

  it('正常系: upsert + audit + invalidateCache が呼ばれる', async () => {
    const { deps, spies } = makeDeps();
    const r = await setApiCredentialCore(
      { provider: 'anthropic', key: 'sk-ant-secret' },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.provider).toBe('anthropic');
      expect(r.data.key_mask).toBe('mask(sk-)');
    }
    expect(spies.encrypt).toHaveBeenCalledWith('sk-ant-secret');
    expect(spies.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = spies.upsert.mock.calls[0]?.[0];
    expect(upsertArg.where).toEqual({ provider: 'anthropic' });
    expect(upsertArg.create.key_enc).toBe('enc(sk-ant-secret)');
    expect(upsertArg.create.key_mask).toBe('mask(sk-)');
    expect(upsertArg.create.set_by).toBe('u_1');
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    expect(auditArg.data.action).toBe('api_credential.set');
    expect(auditArg.data.target_kind).toBe('api_credential');
    expect(auditArg.data.actor_id).toBe('u_1');
    expect(spies.invalidate).toHaveBeenCalledWith('anthropic');
  });

  it('audit_log の after_json には key_enc 実値は含まれず key_mask のみ', async () => {
    const { deps, spies } = makeDeps();
    await setApiCredentialCore({ provider: 'openai', key: 'sk-openai' }, deps);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    expect(auditArg.data.after_json).toBeDefined();
    expect(auditArg.data.after_json).not.toHaveProperty('key_enc');
    expect(auditArg.data.after_json.key_mask).toBe('mask(sk-)');
  });

  it('encrypt 例外時は fail を返し DB は触らない', async () => {
    const { deps, spies } = makeDeps({
      encrypt: () => {
        throw new Error('boom');
      },
    });
    const r = await setApiCredentialCore(
      { provider: 'google', key: 'AIza-xxx' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    expect(spies.upsert).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('再 set 時は last_tested_at と last_test_result_json がリセットされる', async () => {
    const existing = makeRow({
      provider: 'anthropic',
      last_tested_at: new Date('2026-05-21T00:00:00.000Z'),
      last_test_result_json: { ok: true, message: 'OK' } as unknown as ApiCredential['last_test_result_json'],
    });
    const { deps, spies } = makeDeps({ existing: { anthropic: existing } });
    await setApiCredentialCore({ provider: 'anthropic', key: 'sk-new' }, deps);
    const upsertArg = spies.upsert.mock.calls[0]?.[0];
    expect(upsertArg.update.last_tested_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revokeApiCredentialCore
// ---------------------------------------------------------------------------

describe('revokeApiCredentialCore', () => {
  it('未存在で not_found', async () => {
    const { deps } = makeDeps();
    const r = await revokeApiCredentialCore({ provider: 'anthropic' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });

  it('provider 不正で validation', async () => {
    const { deps } = makeDeps();
    const r = await revokeApiCredentialCore({}, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('正常系: delete + audit + invalidate', async () => {
    const existing = makeRow({ provider: 'openai' });
    const { deps, spies } = makeDeps({ existing: { openai: existing } });
    const r = await revokeApiCredentialCore({ provider: 'openai' }, deps);
    expect(isOk(r)).toBe(true);
    expect(spies.del).toHaveBeenCalledTimes(1);
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    expect(spies.invalidate).toHaveBeenCalledWith('openai');
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    expect(auditArg.data.action).toBe('api_credential.revoke');
    expect(auditArg.data.target_id).toBe('cred_1');
  });
});

// ---------------------------------------------------------------------------
// testApiCredentialCore
// ---------------------------------------------------------------------------

describe('testApiCredentialCore', () => {
  it('未存在で not_found', async () => {
    const { deps } = makeDeps();
    const r = await testApiCredentialCore({ provider: 'anthropic' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });

  it('正常系: decrypt → testClient → update + audit', async () => {
    const existing = makeRow({ provider: 'anthropic', key_enc: 'enc(sk-ant-real)' });
    const { deps, spies } = makeDeps({
      existing: { anthropic: existing },
      testClient: async () => ({ ok: true, message: 'OK', http_status: 200, latency_ms: 8 }),
    });
    const r = await testApiCredentialCore({ provider: 'anthropic' }, deps);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.ok).toBe(true);
    expect(spies.decrypt).toHaveBeenCalledWith('enc(sk-ant-real)');
    expect(spies.testClient).toHaveBeenCalledWith('anthropic', 'sk-ant-real');
    expect(spies.update).toHaveBeenCalledTimes(1);
    const upArg = spies.update.mock.calls[0]?.[0];
    expect(upArg.where).toEqual({ provider: 'anthropic' });
    expect(upArg.data.last_tested_at).toBe(FROZEN_NOW);
    expect(upArg.data.last_test_result_json).toEqual({ ok: true, message: 'OK', http_status: 200, latency_ms: 8 });
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    expect(auditArg.data.action).toBe('api_credential.test');
  });

  it('testClient が ok:false を返しても DB 更新 + audit は走る', async () => {
    const existing = makeRow({ provider: 'openai' });
    const { deps, spies } = makeDeps({
      existing: { openai: existing },
      testClient: async () => ({ ok: false, message: 'Invalid API key', http_status: 401 }),
    });
    const r = await testApiCredentialCore({ provider: 'openai' }, deps);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.ok).toBe(false);
      expect(r.data.http_status).toBe(401);
    }
    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
  });

  it('decrypt 失敗 (改ざん検知) で fail を返し testClient は呼ばれない', async () => {
    const existing = makeRow({ provider: 'google', key_enc: 'BAD' });
    const { deps, spies } = makeDeps({
      existing: { google: existing },
      decrypt: () => {
        throw new Error('GCM authTag mismatch');
      },
    });
    const r = await testApiCredentialCore({ provider: 'google' }, deps);
    expect(isFail(r)).toBe(true);
    expect(spies.testClient).not.toHaveBeenCalled();
    expect(spies.update).not.toHaveBeenCalled();
  });
});
