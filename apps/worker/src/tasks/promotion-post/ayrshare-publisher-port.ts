/**
 * F-058 — Ayrshare 経由の PublisherPort 実装 (IG / TikTok 等)。
 *
 * X 以外の SNS (Instagram / TikTok) は公式 API の要件が重い/動画必須のため、
 * 1 つの API キーで多 SNS へ投稿できる Ayrshare (https://www.ayrshare.com) を中継に使う。
 *   POST https://api.ayrshare.com/api/post
 *   Authorization: Bearer <AYRSHARE_API_KEY>
 *   body: { post, platforms: ["instagram"|"tiktok"|...], mediaUrls?: [公開URL] }
 *
 * - Instagram / TikTok はメディア(画像/動画)必須。publish タスクが生成済み販促画像の
 *   署名付き URL を input.mediaUrls に入れて渡す。無ければ invalid で弾く。
 * - 失敗は例外にせず PublishResult の判別ユニオンで返す。
 */
import { createLogger } from '@a2p/contracts/logger';

import type { PublishInput, PublishResult, PublisherPort } from './publisher-port.js';

const log = createLogger('worker.promotion.ayrshare-publisher');

const AYRSHARE_POST_URL = 'https://api.ayrshare.com/api/post';

/** 販促チャンネル → Ayrshare プラットフォーム識別子。 */
const CHANNEL_TO_AYRSHARE: Record<string, string> = {
  instagram: 'instagram',
  tiktok: 'tiktok',
  // 参考: X はネイティブ OAuth1 経路を使うため通常ここは通らない。
  x: 'twitter',
};

/** メディア必須のプラットフォーム。 */
const MEDIA_REQUIRED = new Set(['instagram', 'tiktok']);

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface AyrsharePublisherDeps {
  /** テスト差し替え用 fetch。既定は global fetch。 */
  fetchImpl?: FetchLike;
  /** Ayrshare API キー。既定は env AYRSHARE_API_KEY。 */
  apiKey?: string;
}

export function createAyrsharePublisherPort(deps: AyrsharePublisherDeps = {}): PublisherPort {
  const doFetch: FetchLike = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const apiKey = deps.apiKey ?? process.env.AYRSHARE_API_KEY ?? '';

  return {
    async publish(input: PublishInput): Promise<PublishResult> {
      if (!apiKey) {
        return { ok: false, reason: 'not_connected', message: 'AYRSHARE_API_KEY not configured' };
      }
      const platform = CHANNEL_TO_AYRSHARE[input.channel];
      if (!platform) {
        return { ok: false, reason: 'not_connected', message: `channel ${input.channel} is not supported by Ayrshare` };
      }
      const body = input.body.trim();
      if (body.length === 0) {
        return { ok: false, reason: 'invalid', message: 'empty post body' };
      }
      const mediaUrls = (input.mediaUrls ?? []).filter((u) => typeof u === 'string' && u.length > 0);
      if (MEDIA_REQUIRED.has(platform) && mediaUrls.length === 0) {
        return {
          ok: false,
          reason: 'invalid',
          message: `${platform} requires media (image/video) — no mediaUrls provided`,
        };
      }

      const payload: Record<string, unknown> = { post: body, platforms: [platform] };
      if (mediaUrls.length > 0) payload.mediaUrls = mediaUrls;

      try {
        const res = await doFetch(AYRSHARE_POST_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        });
        const raw = await res.text();
        if (!res.ok) {
          return {
            ok: false,
            reason: res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : 'unknown',
            message: `Ayrshare responded ${res.status}: ${raw.slice(0, 300)}`,
          };
        }
        return interpretAyrshareBody(raw, platform);
      } catch (err) {
        log.warn({ err, channel: input.channel }, 'ayrshare publish failed');
        return { ok: false, reason: 'unknown', message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
      }
    },
  };
}

/**
 * Ayrshare のレスポンス body を解釈する。
 * 成功: `{ status:'success', postIds:[{ platform, postUrl, id, status }], ... }`
 * 部分失敗: `{ status:'error'|'success', errors:[{ platform, message }], postIds:[...] }`
 */
function interpretAyrshareBody(raw: string, platform: string): PublishResult {
  let json: {
    status?: string;
    errors?: Array<{ platform?: string; message?: string; action?: string }>;
    postIds?: Array<{ platform?: string; postUrl?: string; id?: string; status?: string }>;
  };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    return { ok: true, externalUrl: null }; // 2xx だが JSON でない → 成功扱い(URL 不明)
  }

  const errors = Array.isArray(json.errors) ? json.errors : [];
  const platformError = errors.find((e) => !e.platform || e.platform === platform) ?? errors[0];
  if (platformError) {
    const msg = platformError.message ?? 'ayrshare returned an error';
    const isAuth = /permission|token|auth|not linked|no.*account/i.test(msg);
    return { ok: false, reason: isAuth ? 'auth' : 'unknown', message: msg.slice(0, 300) };
  }

  const posts = Array.isArray(json.postIds) ? json.postIds : [];
  const match = posts.find((p) => p.platform === platform) ?? posts[0];
  const url = typeof match?.postUrl === 'string' && match.postUrl.length > 0 ? match.postUrl : null;

  if (json.status && json.status !== 'success' && posts.length === 0) {
    return { ok: false, reason: 'unknown', message: `ayrshare status=${json.status}` };
  }
  return { ok: true, externalUrl: url };
}

export { CHANNEL_TO_AYRSHARE };
