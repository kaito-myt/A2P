/**
 * F-063 — TikTok PublisherPort（refresh→inbox init→upload）の単体テスト。fetch を DI。
 */
import { describe, expect, it, vi } from 'vitest';

import { createTikTokPublisherPort, parseTikTokCredentials } from '../src/tasks/promotion-post/tiktok-publisher-port.js';
import type { PublishInput } from '../src/tasks/promotion-post/publisher-port.js';

const creds = JSON.stringify({ kind: 'tiktok', clientKey: 'sbaw_k', clientSecret: 'sec', refreshToken: 'rt_old', openId: 'oid1' });

function baseInput(over: Partial<PublishInput> = {}): PublishInput {
  return {
    channel: 'tiktok',
    title: null,
    body: 'キャプション #tag',
    config: { token: creds, handle: '@goodbooks_intro', extra: {} },
    mediaUrls: ['https://r2.example/video.mp4?sig=x'],
    ...over,
  };
}

type FakeRes = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};
const mk = (o: { ok?: boolean; status?: number; body?: unknown; bytes?: ArrayBuffer }): FakeRes => ({
  ok: o.ok ?? true,
  status: o.status ?? 200,
  json: async (): Promise<unknown> => o.body ?? {},
  text: async (): Promise<string> => JSON.stringify(o.body ?? {}),
  arrayBuffer: async (): Promise<ArrayBuffer> => o.bytes ?? new ArrayBuffer(0),
});
const jsonRes = (body: unknown, ok = true, status = 200): FakeRes => mk({ body, ok, status });

describe('parseTikTokCredentials', () => {
  it('正しいJSONを解釈、不正はnull', () => {
    expect(parseTikTokCredentials(creds)?.clientKey).toBe('sbaw_k');
    expect(parseTikTokCredentials('nope')).toBeNull();
    expect(parseTikTokCredentials(null)).toBeNull();
  });
});

describe('createTikTokPublisherPort', () => {
  it('refresh→動画取得→inbox init→PUT が成功し ok を返す。ローテ後のrefresh_tokenを保存', async () => {
    const persist = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.includes('/oauth/token/')) return jsonRes({ access_token: 'at1', refresh_token: 'rt_new', expires_in: 86400 });
      if (url.includes('video.mp4')) return mk({ bytes: new Uint8Array([1, 2, 3, 4]).buffer });
      if (url.includes('/inbox/video/init/')) return jsonRes({ data: { publish_id: 'pub1', upload_url: 'https://upload.tiktok/xyz' } });
      if (url.includes('upload.tiktok')) return mk({ status: 201 });
      throw new Error('unexpected url ' + url);
    });
    const port = createTikTokPublisherPort({ fetchImpl: fetchImpl as never, persistCreds: persist });
    const res = await port.publish(baseInput());
    expect(res.ok).toBe(true);
    // ローテされた refresh_token を保存
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'rt_new' }));
    // init は FILE_UPLOAD + Bearer
    const initCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/inbox/video/init/'))!;
    expect((initCall[1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer at1');
  });

  it('creds無し→not_connected', async () => {
    const port = createTikTokPublisherPort({ fetchImpl: vi.fn() as never });
    const res = await port.publish(baseInput({ config: { token: null, handle: null, extra: {} } }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_connected');
  });

  it('動画URL無し→invalid', async () => {
    const port = createTikTokPublisherPort({ fetchImpl: vi.fn() as never });
    const res = await port.publish(baseInput({ mediaUrls: [] }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid');
  });

  it('refresh失敗→auth', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ error: 'invalid_grant', error_description: 'expired' }));
    const port = createTikTokPublisherPort({ fetchImpl: fetchImpl as never });
    const res = await port.publish(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('auth');
  });
});
