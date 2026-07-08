/**
 * F-052 — PublisherPort の実 HTTP 実装 (隔離)。
 *
 * 2 つの投稿経路をサポートする:
 *   1. **Webhook 経由 (汎用)**: チャンネル設定に `webhook_url` があれば、そこへ
 *      `{ channel, title, body, handle }` を POST する。note/ブログのように公式 API が
 *      無い/複雑なチャンネルは、運営者が用意した中継 (自前 API / Zapier / Make 等) に
 *      流すのが最も現実的。レスポンス JSON に `url` があれば公開 URL として採用。
 *   2. **X API v2 (SNS)**: `webhook_url` が無く channel='sns' でトークンがある場合、
 *      `POST https://api.twitter.com/2/tweets` に Bearer 認証で投稿する。
 *
 * どちらも失敗は例外にせず PublishResult の判別ユニオンで返す (dispatcher が記録)。
 */
import { createLogger } from '@a2p/contracts/logger';

import type {
  PublishInput,
  PublishResult,
  PublisherPort,
} from './publisher-port.js';

const log = createLogger('worker.promotion.http-publisher');

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface HttpPublisherDeps {
  /** テスト差し替え用の fetch。既定は global fetch。 */
  fetchImpl?: FetchLike;
}

const X_API_TWEETS_URL = 'https://api.twitter.com/2/tweets';
const X_MAX_LEN = 280;

export function createHttpPublisherPort(deps: HttpPublisherDeps = {}): PublisherPort {
  const doFetch: FetchLike = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  return {
    async publish(input: PublishInput): Promise<PublishResult> {
      const webhookUrl = readString(input.config.extra['webhook_url']);

      // 1. Webhook 経由 (汎用)
      if (webhookUrl) {
        return publishViaWebhook(doFetch, webhookUrl, input);
      }

      // 2. X API v2 (X 専用)。Instagram/TikTok は公式 API の要件が重いため Webhook 経由を推奨。
      if (input.channel === 'x') {
        if (!input.config.token) {
          return { ok: false, reason: 'not_connected', message: 'X token not configured' };
        }
        return publishViaXApi(doFetch, input);
      }

      // それ以外は接続手段なし
      return {
        ok: false,
        reason: 'not_connected',
        message: `channel ${input.channel} needs a webhook_url or token to publish`,
      };
    },
  };
}

async function publishViaWebhook(
  doFetch: FetchLike,
  url: string,
  input: PublishInput,
): Promise<PublishResult> {
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.config.token ? { authorization: `Bearer ${input.config.token}` } : {}),
      },
      body: JSON.stringify({
        channel: input.channel,
        title: input.title,
        body: input.body,
        handle: input.config.handle,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        reason: res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : 'unknown',
        message: `webhook responded ${res.status}: ${text.slice(0, 300)}`,
      };
    }
    return { ok: true, externalUrl: extractUrl(text) };
  } catch (err) {
    log.warn({ err, channel: input.channel }, 'webhook publish failed');
    return { ok: false, reason: 'unknown', message: errMessage(err) };
  }
}

async function publishViaXApi(doFetch: FetchLike, input: PublishInput): Promise<PublishResult> {
  const text = input.body.trim();
  if (text.length === 0) {
    return { ok: false, reason: 'invalid', message: 'empty tweet body' };
  }
  if (text.length > X_MAX_LEN) {
    return { ok: false, reason: 'invalid', message: `tweet exceeds ${X_MAX_LEN} chars` };
  }
  try {
    const res = await doFetch(X_API_TWEETS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.config.token}`,
      },
      body: JSON.stringify({ text }),
    });
    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        reason: res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : 'unknown',
        message: `X API responded ${res.status}: ${raw.slice(0, 300)}`,
      };
    }
    const id = extractTweetId(raw);
    const handle = input.config.handle?.replace(/^@/, '');
    const externalUrl = id && handle ? `https://x.com/${handle}/status/${id}` : id ? `https://x.com/i/status/${id}` : null;
    return { ok: true, externalUrl };
  } catch (err) {
    log.warn({ err }, 'X API publish failed');
    return { ok: false, reason: 'unknown', message: errMessage(err) };
  }
}

function readString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function extractUrl(text: string): string | null {
  try {
    const j = JSON.parse(text) as { url?: unknown; external_url?: unknown };
    return readString(j.url) ?? readString(j.external_url);
  } catch {
    return null;
  }
}

function extractTweetId(text: string): string | null {
  try {
    const j = JSON.parse(text) as { data?: { id?: unknown } };
    return readString(j.data?.id);
  } catch {
    return null;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
