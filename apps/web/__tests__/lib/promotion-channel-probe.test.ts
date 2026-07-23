/**
 * 販促チャンネル接続テスト (非破壊プローブ) の単体テスト。
 */
import { describe, expect, it, vi } from 'vitest';

import { probeChannelAuth } from '../../lib/promotion-channel-probe';

function fetchReturning(status: number, body: string) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }));
}

describe('probeChannelAuth', () => {
  it('blog は所有チャンネルなので外部を叩かず OK', async () => {
    const fetchImpl = vi.fn();
    const res = await probeChannelAuth({ channel: 'blog', token: null, webhookUrl: null }, { fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.method).toBe('owned');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('x: token 未設定なら外部を叩かず not_connected', async () => {
    const fetchImpl = vi.fn();
    const res = await probeChannelAuth({ channel: 'x', token: null, webhookUrl: null }, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.method).toBe('none');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const X_OAUTH1 = JSON.stringify({
    kind: 'oauth1',
    apiKey: 'k',
    apiSecret: 's',
    accessToken: 'at',
    accessTokenSecret: 'ats',
  });

  it('x: /2/users/me が 200 なら @handle を返し、OAuth1 署名で GET する', async () => {
    const fetchImpl = fetchReturning(200, JSON.stringify({ data: { username: 'festal_kdp', id: '1' } }));
    const res = await probeChannelAuth({ channel: 'x', token: X_OAUTH1, webhookUrl: null }, { fetchImpl, now: () => 0 });
    expect(res.ok).toBe(true);
    expect(res.method).toBe('x_api');
    expect(res.identity).toBe('@festal_kdp');
    // read-only エンドポイントを OAuth1 署名で GET している (投稿はしない)。
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, { method: string; headers: { authorization: string } }];
    expect(url).toBe('https://api.twitter.com/2/users/me');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization.startsWith('OAuth ')).toBe(true);
  });

  it('x: 401 は認証NG', async () => {
    const fetchImpl = fetchReturning(401, 'Unauthorized');
    const res = await probeChannelAuth({ channel: 'x', token: X_OAUTH1, webhookUrl: null }, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.method).toBe('x_api');
    expect(res.http_status).toBe(401);
  });

  it('x: 403 は署名有効(認証OK)・Freeプラン扱い', async () => {
    const fetchImpl = fetchReturning(403, 'not in your access level');
    const res = await probeChannelAuth({ channel: 'x', token: X_OAUTH1, webhookUrl: null }, { fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.method).toBe('x_api');
    expect(res.http_status).toBe(403);
  });

  it('x: 資格情報が壊れている(4値でない)と bad format', async () => {
    const fetchImpl = vi.fn();
    const res = await probeChannelAuth({ channel: 'x', token: '{"kind":"oauth1","apiKey":"k"}', webhookUrl: null }, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('webhook があれば test:true を POST し 2xx で OK', async () => {
    const fetchImpl = fetchReturning(200, 'ok');
    const res = await probeChannelAuth(
      { channel: 'note', token: null, webhookUrl: 'https://hook.test/relay' },
      { fetchImpl },
    );
    expect(res.ok).toBe(true);
    expect(res.method).toBe('webhook');
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, { method: string; body: string }];
    expect(url).toBe('https://hook.test/relay');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ test: true, channel: 'note' });
  });

  it('webhook も token も無い note は not_connected', async () => {
    const fetchImpl = vi.fn();
    const res = await probeChannelAuth({ channel: 'note', token: null, webhookUrl: null }, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.method).toBe('none');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ネットワーク例外は throw せず判別結果で返す', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await probeChannelAuth({ channel: 'x', token: 'tok', webhookUrl: null }, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('ECONNREFUSED');
  });
});

describe('probeChannelAuth — TikTok (直叩きAPI)', () => {
  const TIKTOK_CREDS = JSON.stringify({
    kind: 'tiktok',
    clientKey: 'sbaw_k',
    clientSecret: 'sec',
    refreshToken: 'rt',
    openId: 'oid',
  });

  it('保存済み OAuth 資格情報があれば非破壊で接続OK（外部を叩かない）', async () => {
    const fetchImpl = vi.fn();
    const res = await probeChannelAuth(
      { channel: 'tiktok', token: TIKTOK_CREDS, webhookUrl: null },
      { fetchImpl },
    );
    expect(res.ok).toBe(true);
    expect(res.method).toBe('tiktok');
    // refresh はローテーションで token を消費するため、テストでは一切叩かない。
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('資格情報未設定なら not_connected', async () => {
    const fetchImpl = vi.fn();
    const res = await probeChannelAuth(
      { channel: 'tiktok', token: null, webhookUrl: null },
      { fetchImpl },
    );
    expect(res.ok).toBe(false);
    expect(res.method).toBe('none');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('資格情報の形式が不正（4値でない）なら not_connected', async () => {
    const fetchImpl = vi.fn();
    const res = await probeChannelAuth(
      { channel: 'tiktok', token: JSON.stringify({ kind: 'tiktok', clientKey: 'k' }), webhookUrl: null },
      { fetchImpl },
    );
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('probeChannelAuth — Instagram (Make Webhook)', () => {
  it('Webhook 未設定なら要設定を案内（none）', async () => {
    const fetchImpl = vi.fn();
    const res = await probeChannelAuth(
      { channel: 'instagram', token: null, webhookUrl: null },
      { fetchImpl },
    );
    expect(res.ok).toBe(false);
    expect(res.method).toBe('none');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Webhook があれば test POST で到達確認', async () => {
    const fetchImpl = fetchReturning(200, 'ok');
    const res = await probeChannelAuth(
      { channel: 'instagram', token: null, webhookUrl: 'https://hook.make/ig' },
      { fetchImpl },
    );
    expect(res.ok).toBe(true);
    expect(res.method).toBe('webhook');
  });
});
