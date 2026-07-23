/**
 * 販促チャンネルの「接続テスト」— 非破壊で外部サービスの認証が通るかだけを確認する。
 *
 * 実投稿(promotion.post.publish)と同じ資格情報/認証方式を使うが、書き込みは一切
 * 行わない read-only プローブ:
 *   - x:        `GET https://api.twitter.com/2/users/me` を OAuth1 署名で叩く (投稿と同じ資格情報)。
 *               200 なら認証OK・@handle を返す。401/403 なら token 無効。
 *   - tiktok:   Content Posting API 直叩き方式。保存済み OAuth 資格情報(kind:'tiktok')の
 *               有無・形式を確認する。refresh はローテーションで token を消費するため、
 *               テストでは実行しない(非破壊)。投稿時に自動でアクセストークンを更新する。
 *   - instagram:Make の Webhook 経由。webhook_url があれば test POST、無ければ要設定。
 *   - webhook:  webhook_url があれば `{ test: true }` を POST し、2xx なら到達OK。
 *               (運営者の中継が test フラグを実処理しない前提で、投稿はしない旨も送る)
 *   - blog:     所有チャンネル。外部認証不要なので常にOK。
 *   - その他:   webhook_url も token も無ければ not_connected。
 *
 * すべて失敗は throw せず判別結果で返す。fetch は DI 可能 (テスト・msw)。
 */
import { buildXAuthHeader, parseXCredentials } from '@a2p/crypto';

import { messages } from '@/lib/messages';

export interface ChannelProbeInput {
  channel: string;
  /** 復号済みアクセストークン (未設定なら null)。 */
  token: string | null;
  /** チャンネル設定の webhook_url (未設定なら null)。 */
  webhookUrl: string | null;
}

export type ChannelProbeResult = {
  ok: boolean;
  /** 認証手段の識別: x_api | tiktok | webhook | owned | none */
  method: 'x_api' | 'tiktok' | 'webhook' | 'owned' | 'none';
  message: string;
  http_status?: number;
  latency_ms?: number;
  /** 認証できた場合の識別子 (X の @handle 等)。 */
  identity?: string | null;
};

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ChannelProbeDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
}

const X_USERS_ME_URL = 'https://api.twitter.com/2/users/me';
const OWNED_CHANNELS = new Set(['blog']);

const pm = messages.promotionChannels.probe;

export async function probeChannelAuth(
  input: ChannelProbeInput,
  deps: ChannelProbeDeps = {},
): Promise<ChannelProbeResult> {
  const doFetch: FetchLike = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = deps.now ?? (() => Date.now());

  // 所有チャンネル (ブログ) は第三者接続不要。
  if (OWNED_CHANNELS.has(input.channel)) {
    return { ok: true, method: 'owned', message: pm.ownedOk };
  }

  // TikTok は Content Posting API を直接叩く。保存済み OAuth 資格情報の有無/形式を確認する
  // (refresh はローテーションで token を消費するため、非破壊テストでは実行しない)。
  if (input.channel === 'tiktok') {
    return probeTikTokCreds(input.token);
  }

  // webhook 経由を確認 (Instagram=Make / note の現実的な接続手段)。
  if (input.webhookUrl && input.webhookUrl.trim().length > 0) {
    return probeWebhook(doFetch, now, input);
  }

  // X は公式 API を直接叩く (投稿と同じ OAuth1 署名)。
  if (input.channel === 'x') {
    if (!input.token) {
      return { ok: false, method: 'none', message: pm.xNoToken };
    }
    return probeXApi(doFetch, now, input.token);
  }

  // Instagram は Make の Webhook が必須。未設定なら要設定を案内する。
  if (input.channel === 'instagram') {
    return { ok: false, method: 'none', message: pm.igNeedsWebhook };
  }

  // それ以外は接続手段なし。
  return { ok: false, method: 'none', message: pm.noneConfigured };
}

/** TikTok 資格情報(暗号化 JSON を復号したもの)を非破壊で検証する。 */
function probeTikTokCreds(token: string | null): ChannelProbeResult {
  if (!token) return { ok: false, method: 'none', message: pm.tiktokNotConnected };
  try {
    const o = JSON.parse(token) as {
      kind?: string;
      clientKey?: string;
      clientSecret?: string;
      refreshToken?: string;
    };
    if (o.kind === 'tiktok' && o.clientKey && o.clientSecret && o.refreshToken) {
      return { ok: true, method: 'tiktok', message: pm.tiktokConnected };
    }
  } catch {
    /* not json */
  }
  return { ok: false, method: 'none', message: pm.tiktokNotConnected };
}

async function probeXApi(
  doFetch: FetchLike,
  now: () => number,
  token: string,
): Promise<ChannelProbeResult> {
  const creds = parseXCredentials(token);
  if (!creds) {
    return { ok: false, method: 'x_api', message: pm.xBadFormat };
  }
  const started = now();
  try {
    const authHeader = buildXAuthHeader('GET', X_USERS_ME_URL, creds);
    const res = await doFetch(X_USERS_ME_URL, {
      method: 'GET',
      headers: { authorization: authHeader },
    });
    const latency = now() - started;
    const raw = await res.text();
    if (res.ok) {
      let handle: string | null = null;
      try {
        const j = JSON.parse(raw) as { data?: { username?: unknown } };
        handle = typeof j.data?.username === 'string' ? `@${j.data.username}` : null;
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        method: 'x_api',
        message: handle ? pm.xOk(handle) : pm.xOkNoHandle,
        http_status: res.status,
        latency_ms: latency,
        identity: handle,
      };
    }
    // 401 = 署名/キーが不正 (認証失敗)。
    if (res.status === 401) {
      return { ok: false, method: 'x_api', message: pm.xAuthFailed, http_status: 401, latency_ms: latency };
    }
    // 403 = 署名は受理された (＝資格情報は有効) が、この読取エンドポイントが
    // 現在のアクセスレベル(Free等)に含まれない。投稿(write)は可能なので「認証OK」と扱う。
    if (res.status === 403) {
      return { ok: true, method: 'x_api', message: pm.xOkFreeTier, http_status: 403, latency_ms: latency };
    }
    if (res.status === 429) {
      return { ok: false, method: 'x_api', message: pm.xRateLimited, http_status: 429, latency_ms: latency };
    }
    return {
      ok: false,
      method: 'x_api',
      message: `HTTP ${res.status}: ${raw.slice(0, 200)}`,
      http_status: res.status,
      latency_ms: latency,
    };
  } catch (err) {
    return { ok: false, method: 'x_api', message: errMessage(err), latency_ms: now() - started };
  }
}

async function probeWebhook(
  doFetch: FetchLike,
  now: () => number,
  input: ChannelProbeInput,
): Promise<ChannelProbeResult> {
  const started = now();
  try {
    const res = await doFetch(input.webhookUrl as string, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      // test:true — 中継側が判定して実投稿しないための合図。body は投稿しない。
      body: JSON.stringify({ test: true, channel: input.channel, note: 'connection test — do not post' }),
    });
    const latency = now() - started;
    const raw = await res.text();
    if (res.ok) {
      return { ok: true, method: 'webhook', message: pm.webhookOk, http_status: res.status, latency_ms: latency };
    }
    return {
      ok: false,
      method: 'webhook',
      message: res.status === 401 || res.status === 403 ? pm.webhookAuthFailed : `HTTP ${res.status}: ${raw.slice(0, 200)}`,
      http_status: res.status,
      latency_ms: latency,
    };
  } catch (err) {
    return { ok: false, method: 'webhook', message: errMessage(err), latency_ms: now() - started };
  }
}

function errMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return pm.networkError;
}
