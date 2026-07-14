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

  it('x: /2/users/me が 200 なら @handle を返して OK', async () => {
    const fetchImpl = fetchReturning(200, JSON.stringify({ data: { username: 'festal_kdp', id: '1' } }));
    const res = await probeChannelAuth({ channel: 'x', token: 'tok', webhookUrl: null }, { fetchImpl, now: () => 0 });
    expect(res.ok).toBe(true);
    expect(res.method).toBe('x_api');
    expect(res.identity).toBe('@festal_kdp');
    // read-only エンドポイントを Bearer で GET している (投稿はしない)。
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.twitter.com/2/users/me',
      expect.objectContaining({ method: 'GET', headers: { authorization: 'Bearer tok' } }),
    );
  });

  it('x: 401 は認証NG', async () => {
    const fetchImpl = fetchReturning(401, 'Unauthorized');
    const res = await probeChannelAuth({ channel: 'x', token: 'bad', webhookUrl: null }, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.method).toBe('x_api');
    expect(res.http_status).toBe(401);
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
