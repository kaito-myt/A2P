/**
 * TikTok アプリ内 OAuth コアの単体テスト。暗号化/DB は DI で差し替え。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  exchangeTikTokCode,
  parseStoredTikTok,
  readTikTokCreds,
  saveTikTokAppCredentialsCore,
  type TikTokOAuthDeps,
} from '../../lib/tiktok-oauth-core';

// 素通しの「暗号化」(テスト用): JSON 文字列をそのまま保持する。
function makeDeps(initialEnc: string | null = null): {
  deps: TikTokOAuthDeps;
  store: { token_enc: string | null; token_mask: string | null };
  upsert: ReturnType<typeof vi.fn>;
} {
  const store: { token_enc: string | null; token_mask: string | null } = { token_enc: initialEnc, token_mask: null };
  const upsert = vi.fn(async (a: { update: { token_enc: string; token_mask: string } }) => {
    store.token_enc = a.update.token_enc;
    store.token_mask = a.update.token_mask;
  });
  const deps: TikTokOAuthDeps = {
    channelSettingRepo: {
      findUnique: async () => (store.token_enc ? { token_enc: store.token_enc } : null),
      upsert: upsert as never,
    },
    encrypt: (p) => `enc:${p}`,
    decrypt: (e) => e.replace(/^enc:/, ''),
    mask: (s) => `${s.slice(0, 2)}…`,
  };
  return { deps, store, upsert };
}

const appCreds = 'enc:' + JSON.stringify({ kind: 'tiktok', clientKey: 'ck1', clientSecret: 'cs1', refreshToken: '', openId: '' });

describe('parseStoredTikTok', () => {
  it('clientKey/secret があれば refreshToken 空でも解釈する', () => {
    const c = parseStoredTikTok(JSON.stringify({ kind: 'tiktok', clientKey: 'k', clientSecret: 's' }));
    expect(c?.clientKey).toBe('k');
    expect(c?.refreshToken).toBe('');
  });
  it('kind 不一致や不正 JSON は null', () => {
    expect(parseStoredTikTok(JSON.stringify({ kind: 'x' }))).toBeNull();
    expect(parseStoredTikTok('nope')).toBeNull();
    expect(parseStoredTikTok(null)).toBeNull();
  });
});

describe('saveTikTokAppCredentialsCore', () => {
  it('Client Key/Secret を保存し、既存の refreshToken を温存する', async () => {
    const initial = 'enc:' + JSON.stringify({ kind: 'tiktok', clientKey: 'old', clientSecret: 'old', refreshToken: 'rtKEEP', openId: 'oid' });
    const { deps, store } = makeDeps(initial);
    await saveTikTokAppCredentialsCore({ clientKey: 'newck', clientSecret: 'newcs' }, deps);
    const saved = parseStoredTikTok((store.token_enc ?? '').replace(/^enc:/, ''));
    expect(saved?.clientKey).toBe('newck');
    expect(saved?.clientSecret).toBe('newcs');
    expect(saved?.refreshToken).toBe('rtKEEP'); // 温存
  });
});

describe('readTikTokCreds', () => {
  it('未設定なら null', async () => {
    const { deps } = makeDeps(null);
    expect(await readTikTokCreds(deps)).toBeNull();
  });
});

describe('exchangeTikTokCode', () => {
  it('code を交換してフル資格情報を保存する', async () => {
    const { deps, store } = makeDeps(appCreds);
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ access_token: 'at', refresh_token: 'rtNEW', open_id: 'oidNEW', expires_in: 86400 }),
    })) as unknown as typeof fetch;
    const res = await exchangeTikTokCode({ code: 'CODE', redirectUri: 'https://app/cb' }, deps, fetchImpl);
    expect(res.ok).toBe(true);
    // redirect_uri と grant_type=authorization_code を送っている
    const body = (fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0]![1].body;
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('redirect_uri=https%3A%2F%2Fapp%2Fcb');
    // 保存された creds に refreshToken/openId が入る
    const saved = parseStoredTikTok((store.token_enc ?? '').replace(/^enc:/, ''));
    expect(saved?.refreshToken).toBe('rtNEW');
    expect(saved?.openId).toBe('oidNEW');
  });

  it('access_token が返らなければ error', async () => {
    const { deps } = makeDeps(appCreds);
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ error: 'invalid_grant', error_description: 'bad code' }),
    })) as unknown as typeof fetch;
    const res = await exchangeTikTokCode({ code: 'X', redirectUri: 'https://app/cb' }, deps, fetchImpl);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('invalid_grant');
  });

  it('アプリ資格情報未保存なら error', async () => {
    const { deps } = makeDeps(null);
    const res = await exchangeTikTokCode({ code: 'X', redirectUri: 'https://app/cb' }, deps, vi.fn() as never);
    expect(res.ok).toBe(false);
  });
});
