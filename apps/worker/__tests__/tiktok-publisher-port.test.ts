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

  it('directPost 有効＋creator_info が PUBLIC 許可→公開投稿(Direct Post)エンドポイントを使う', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: { method?: string; body?: string }) => {
      if (url.includes('/oauth/token/')) return jsonRes({ access_token: 'at1', refresh_token: 'rt_old', expires_in: 86400 });
      if (url.includes('video.mp4')) return mk({ bytes: new Uint8Array([1, 2, 3, 4]).buffer });
      if (url.includes('/creator_info/query/')) return jsonRes({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] } });
      if (url.includes('/publish/video/init/')) return jsonRes({ data: { publish_id: 'pub2', upload_url: 'https://upload.tiktok/pub' } });
      if (url.includes('upload.tiktok')) return mk({ status: 201 });
      throw new Error('unexpected url ' + url);
    });
    const port = createTikTokPublisherPort({ fetchImpl: fetchImpl as never, persistCreds: vi.fn(), directPost: true });
    const res = await port.publish(baseInput());
    expect(res.ok).toBe(true);
    // 公開投稿の init(=/publish/video/init/) を叩き、inbox は使わない
    const usedDirect = fetchImpl.mock.calls.some((c) => String(c[0]).includes('/publish/video/init/'));
    const usedInbox = fetchImpl.mock.calls.some((c) => String(c[0]).includes('/inbox/video/init/'));
    expect(usedDirect).toBe(true);
    expect(usedInbox).toBe(false);
    // post_info に PUBLIC_TO_EVERYONE を渡している
    const directCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/publish/video/init/'))!;
    const body = JSON.parse((directCall[1] as { body: string }).body);
    expect(body.post_info.privacy_level).toBe('PUBLIC_TO_EVERYONE');
  });

  it('config_json.tiktok の公開範囲・コメント許可を post_info に反映する', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: { method?: string; body?: string }) => {
      if (url.includes('/oauth/token/')) return jsonRes({ access_token: 'at1', refresh_token: 'rt_old', expires_in: 86400 });
      if (url.includes('video.mp4')) return mk({ bytes: new Uint8Array([1, 2, 3, 4]).buffer });
      if (url.includes('/creator_info/query/')) return jsonRes({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] } });
      if (url.includes('/publish/video/init/')) return jsonRes({ data: { publish_id: 'pub4', upload_url: 'https://upload.tiktok/pub' } });
      if (url.includes('upload.tiktok')) return mk({ status: 201 });
      throw new Error('unexpected url ' + url);
    });
    const port = createTikTokPublisherPort({ fetchImpl: fetchImpl as never, persistCreds: vi.fn(), directPost: true });
    const res = await port.publish(
      baseInput({
        config: { token: creds, handle: '@x', extra: { tiktok: { privacy_level: 'FOLLOWER_OF_CREATOR', allow_comment: false, allow_duet: true } } },
      }),
    );
    expect(res.ok).toBe(true);
    const directCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/publish/video/init/'))!;
    const body = JSON.parse((directCall[1] as { body: string }).body);
    expect(body.post_info.privacy_level).toBe('FOLLOWER_OF_CREATOR');
    expect(body.post_info.disable_comment).toBe(true); // allow_comment=false
    expect(body.post_info.disable_duet).toBe(false); // allow_duet=true
  });

  it('directPost 有効でも未審査(PUBLIC不可)→安全側の下書き(inbox)にフォールバック', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/oauth/token/')) return jsonRes({ access_token: 'at1', refresh_token: 'rt_old', expires_in: 86400 });
      if (url.includes('video.mp4')) return mk({ bytes: new Uint8Array([1, 2, 3, 4]).buffer });
      if (url.includes('/creator_info/query/')) return jsonRes({ data: { privacy_level_options: ['SELF_ONLY'] } });
      if (url.includes('/inbox/video/init/')) return jsonRes({ data: { publish_id: 'pub3', upload_url: 'https://upload.tiktok/inbox' } });
      if (url.includes('upload.tiktok')) return mk({ status: 201 });
      throw new Error('unexpected url ' + url);
    });
    const port = createTikTokPublisherPort({ fetchImpl: fetchImpl as never, persistCreds: vi.fn(), directPost: true });
    const res = await port.publish(baseInput());
    expect(res.ok).toBe(true);
    const usedInbox = fetchImpl.mock.calls.some((c) => String(c[0]).includes('/inbox/video/init/'));
    const usedDirect = fetchImpl.mock.calls.some((c) => String(c[0]).includes('/publish/video/init/'));
    expect(usedInbox).toBe(true);
    expect(usedDirect).toBe(false);
  });

  it('refresh失敗→auth', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ error: 'invalid_grant', error_description: 'expired' }));
    const port = createTikTokPublisherPort({ fetchImpl: fetchImpl as never });
    const res = await port.publish(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('auth');
  });
});
