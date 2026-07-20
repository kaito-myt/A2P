/**
 * F-052 — HTTP PublisherPort (X OAuth1 + webhook) の単体テスト。
 */
import { describe, expect, it, vi } from 'vitest';

import { serializeXOAuth1 } from '@a2p/crypto';

import { createHttpPublisherPort } from '../src/tasks/promotion-post/http-publisher-port.js';

function fetchReturning(status: number, body: string) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }));
}

const X_CREDS = serializeXOAuth1({
  apiKey: 'k', apiSecret: 's', accessToken: 'at', accessTokenSecret: 'ats',
});

describe('createHttpPublisherPort — X API (OAuth1)', () => {
  it('OAuth1 資格情報で /2/tweets へ OAuth 署名付き POST し、成功で URL を返す', async () => {
    const fetchImpl = fetchReturning(201, JSON.stringify({ data: { id: '1750000000000000000' } }));
    const port = createHttpPublisherPort({ fetchImpl });
    const res = await port.publish({
      channel: 'x',
      title: null,
      body: '新刊出ました！',
      config: { token: X_CREDS, handle: '@festal_kdp', extra: {} },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.externalUrl).toBe('https://x.com/festal_kdp/status/1750000000000000000');
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, { headers: { authorization: string } }];
    expect(url).toBe('https://api.twitter.com/2/tweets');
    // Bearer ではなく OAuth1 署名ヘッダで投稿している。
    expect(init.headers.authorization.startsWith('OAuth ')).toBe(true);
    expect(init.headers.authorization).toContain('oauth_signature=');
  });

  it('トークン未設定は not_connected (外部を叩かない)', async () => {
    const fetchImpl = vi.fn();
    const port = createHttpPublisherPort({ fetchImpl });
    const res = await port.publish({
      channel: 'x', title: null, body: 'x', config: { token: null, handle: null, extra: {} },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_connected');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('401 は auth 失敗', async () => {
    const fetchImpl = fetchReturning(401, 'Unauthorized');
    const port = createHttpPublisherPort({ fetchImpl });
    const res = await port.publish({
      channel: 'x', title: null, body: 'x', config: { token: X_CREDS, handle: null, extra: {} },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('auth');
  });

  it('レガシー Bearer 文字列も投稿できる (後方互換)', async () => {
    const fetchImpl = fetchReturning(201, JSON.stringify({ data: { id: '9' } }));
    const port = createHttpPublisherPort({ fetchImpl });
    const res = await port.publish({
      channel: 'x', title: null, body: 'x', config: { token: 'legacy-bearer', handle: null, extra: {} },
    });
    expect(res.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, { headers: { authorization: string } }];
    expect(init.headers.authorization).toBe('Bearer legacy-bearer');
  });
});

describe('createHttpPublisherPort — webhook 経由', () => {
  it('webhook_url があれば POST し、url を外部URLとして返す', async () => {
    const fetchImpl = fetchReturning(200, JSON.stringify({ url: 'https://note.com/x/n/abc' }));
    const port = createHttpPublisherPort({ fetchImpl });
    const res = await port.publish({
      channel: 'note',
      title: '副業の始め方',
      body: '本文',
      config: { token: null, handle: '@me', extra: { webhook_url: 'https://hook.test/relay' } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.externalUrl).toBe('https://note.com/x/n/abc');
    const [url] = fetchImpl.mock.calls[0]! as unknown as [string];
    expect(url).toBe('https://hook.test/relay');
  });

  it('F-058: mediaUrls を webhook ペイロードに載せる (Make中継でIG画像投稿)', async () => {
    const fetchImpl = fetchReturning(200, JSON.stringify({ url: 'https://instagram.com/p/x' }));
    const port = createHttpPublisherPort({ fetchImpl });
    await port.publish({
      channel: 'instagram',
      title: null,
      body: 'キャプション',
      config: { token: null, handle: '@me', extra: { webhook_url: 'https://hook.test/ig' } },
      mediaUrls: ['https://r2/signed/promo.png'],
    });
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, { body: string }];
    const sent = JSON.parse(init.body) as { channel: string; mediaUrls: string[] };
    expect(sent.channel).toBe('instagram');
    expect(sent.mediaUrls).toEqual(['https://r2/signed/promo.png']);
  });
});
