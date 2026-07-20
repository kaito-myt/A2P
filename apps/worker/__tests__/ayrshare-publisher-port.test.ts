/**
 * F-058 — Ayrshare PublisherPort の単体テスト (fetch を DI)。
 */
import { describe, expect, it, vi } from 'vitest';

import { createAyrsharePublisherPort } from '../src/tasks/promotion-post/ayrshare-publisher-port.js';
import type { PublishInput } from '../src/tasks/promotion-post/publisher-port.js';

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    channel: overrides.channel ?? 'instagram',
    title: null,
    body: overrides.body ?? '新刊のお知らせです',
    config: { token: null, handle: '@me', extra: {} },
    ...(overrides.mediaUrls ? { mediaUrls: overrides.mediaUrls } : {}),
  };
}

function fetchReturning(status: number, body: string) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }));
}

describe('createAyrsharePublisherPort', () => {
  it('IG: post + platforms + mediaUrls を送り、postUrl を返す', async () => {
    const fetchImpl = fetchReturning(
      200,
      JSON.stringify({ status: 'success', postIds: [{ platform: 'instagram', postUrl: 'https://instagram.com/p/abc' }] }),
    );
    const port = createAyrsharePublisherPort({ fetchImpl, apiKey: 'k' });
    const res = await port.publish(input({ mediaUrls: ['https://img/x.png'] }));
    expect(res).toEqual({ ok: true, externalUrl: 'https://instagram.com/p/abc' });
    const call = fetchImpl.mock.calls[0]! as unknown as [string, { body: string; headers: { authorization: string } }];
    expect(call[0]).toBe('https://api.ayrshare.com/api/post');
    const sent = JSON.parse(call[1].body) as { post: string; platforms: string[]; mediaUrls: string[] };
    expect(sent.platforms).toEqual(['instagram']);
    expect(sent.mediaUrls).toEqual(['https://img/x.png']);
    expect(call[1].headers.authorization).toBe('Bearer k');
  });

  it('APIキー未設定なら not_connected', async () => {
    const port = createAyrsharePublisherPort({ fetchImpl: fetchReturning(200, '{}'), apiKey: '' });
    const res = await port.publish(input({ mediaUrls: ['https://img/x.png'] }));
    expect(res).toMatchObject({ ok: false, reason: 'not_connected' });
  });

  it('IG/TikTok はメディア必須 — 無ければ invalid', async () => {
    const port = createAyrsharePublisherPort({ fetchImpl: fetchReturning(200, '{}'), apiKey: 'k' });
    const res = await port.publish(input({ channel: 'tiktok', mediaUrls: [] }));
    expect(res).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('401 は auth 失敗', async () => {
    const port = createAyrsharePublisherPort({ fetchImpl: fetchReturning(401, 'unauthorized'), apiKey: 'bad' });
    const res = await port.publish(input({ mediaUrls: ['https://img/x.png'] }));
    expect(res).toMatchObject({ ok: false, reason: 'auth' });
  });

  it('errors 配列があれば失敗として扱う', async () => {
    const fetchImpl = fetchReturning(
      200,
      JSON.stringify({ status: 'error', errors: [{ platform: 'instagram', message: 'account not linked' }] }),
    );
    const port = createAyrsharePublisherPort({ fetchImpl, apiKey: 'k' });
    const res = await port.publish(input({ mediaUrls: ['https://img/x.png'] }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('auth'); // "not linked" は認証系
  });

  it('未対応チャンネルは not_connected', async () => {
    const port = createAyrsharePublisherPort({ fetchImpl: fetchReturning(200, '{}'), apiKey: 'k' });
    const res = await port.publish(input({ channel: 'blog', mediaUrls: ['https://img/x.png'] }));
    expect(res).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});
