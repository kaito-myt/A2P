/**
 * F-063 — TikTok 投稿 PublisherPort（TikTok Content Posting API 直叩き）。
 *
 * 保存済み資格情報（clientKey/clientSecret/refreshToken/openId の暗号化 JSON）で:
 *   1. refresh_token で access_token を更新（TikTok は refresh_token をローテーションするため、
 *      新しい refresh_token を暗号化して保存し直す）
 *   2. 動画(mp4)のバイトを署名URLから取得
 *   3. `/v2/post/publish/inbox/video/init/`（FILE_UPLOAD）で upload_url を得る
 *   4. upload_url に動画バイトを PUT（単一チャンク）
 * → 動画はユーザーの TikTok「下書き(インボックス)」に入る。scope=video.upload の範囲。
 *   （公開は TikTok アプリ側で手動、または審査通過後に video.publish で直接公開へ拡張可能）
 */
import { createLogger, type Logger } from '@a2p/contracts/logger';

import type { PublishInput, PublishResult, PublisherPort } from './publisher-port.js';

const OAUTH_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const INBOX_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const DIRECT_POST_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const CREATOR_INFO_URL = 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/';
/** 公開投稿(Direct Post)で最も広い公開範囲。creator_info の options に含まれる場合のみ使用。 */
const PUBLIC_PRIVACY = 'PUBLIC_TO_EVERYONE';
/** TikTok のタイトル(キャプション)上限。 */
const TITLE_MAX = 2200;

interface TikTokCreds {
  kind: 'tiktok';
  clientKey: string;
  clientSecret: string;
  refreshToken: string;
  openId?: string;
}

export function parseTikTokCredentials(token: string | null): TikTokCreds | null {
  if (!token) return null;
  try {
    const o = JSON.parse(token) as Partial<TikTokCreds>;
    if (o.kind === 'tiktok' && o.clientKey && o.clientSecret && o.refreshToken) {
      return { kind: 'tiktok', clientKey: o.clientKey, clientSecret: o.clientSecret, refreshToken: o.refreshToken, openId: o.openId };
    }
  } catch {
    /* not json */
  }
  return null;
}

type FetchLike = typeof fetch;

export interface TikTokPublisherDeps {
  fetchImpl?: FetchLike;
  logger?: Logger;
  /** ローテーションされた refresh_token を保存する（既定: tiktok チャンネル設定を再暗号化して更新）。 */
  persistCreds?: (creds: TikTokCreds) => Promise<void>;
  /**
   * 公開投稿(Direct Post)を試みるか。既定は env `TIKTOK_DIRECT_POST==='1'`。
   * 有効でも、creator_info が PUBLIC_TO_EVERYONE を許可する（＝アプリ審査通過済み）場合のみ公開投稿し、
   * 未審査(SELF_ONLY のみ)なら安全側の下書き(inbox)にフォールバックする。
   */
  directPost?: boolean;
}

async function defaultPersistCreds(creds: TikTokCreds): Promise<void> {
  const [{ prisma }, { encryptApiKey, maskApiKey }] = await Promise.all([
    import('@a2p/db'),
    import('@a2p/crypto'),
  ]);
  const enc = encryptApiKey(JSON.stringify(creds));
  await (prisma as unknown as {
    promotionChannelSetting: { update: (a: unknown) => Promise<unknown> };
  }).promotionChannelSetting.update({
    where: { channel: 'tiktok' },
    data: { token_enc: enc, token_mask: maskApiKey(creds.openId || creds.refreshToken) },
  });
}

export function createTikTokPublisherPort(deps: TikTokPublisherDeps = {}): PublisherPort {
  const doFetch = deps.fetchImpl ?? fetch;
  const log = deps.logger ?? createLogger('worker.promotion.tiktok-publisher');
  const persist = deps.persistCreds ?? defaultPersistCreds;

  return {
    async publish(input: PublishInput): Promise<PublishResult> {
      const creds = parseTikTokCredentials(input.config.token);
      if (!creds) return { ok: false, reason: 'not_connected', message: 'TikTok credentials not configured' };

      const videoUrl = input.mediaUrls?.[0];
      if (!videoUrl) return { ok: false, reason: 'invalid', message: 'TikTok post has no video media' };

      try {
        // 1. refresh access token
        const refreshRes = await doFetch(OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_key: creds.clientKey,
            client_secret: creds.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: creds.refreshToken,
          }).toString(),
        });
        const rj = (await refreshRes.json()) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
        if (!rj.access_token) {
          return { ok: false, reason: 'auth', message: `TikTok token refresh failed: ${rj.error ?? ''} ${rj.error_description ?? ''}`.trim() };
        }
        const accessToken = rj.access_token;
        // refresh_token はローテーションされるので保存し直す。
        if (rj.refresh_token && rj.refresh_token !== creds.refreshToken) {
          try {
            await persist({ ...creds, refreshToken: rj.refresh_token });
          } catch (e) {
            log.warn({ err: e }, 'failed to persist rotated tiktok refresh_token');
          }
        }

        // 2. 動画バイト取得
        const vres = await doFetch(videoUrl);
        if (!vres.ok) return { ok: false, reason: 'unknown', message: `video fetch failed: ${vres.status}` };
        const videoBytes = Buffer.from(await vres.arrayBuffer());
        const size = videoBytes.byteLength;
        if (size === 0) return { ok: false, reason: 'invalid', message: 'video is empty' };

        // 3. 投稿方式の決定。公開投稿(Direct Post)は video.publish スコープ＋アプリ審査が前提。
        //    directPost が有効でも、creator_info が PUBLIC_TO_EVERYONE を許可する場合のみ公開投稿し、
        //    未審査(SELF_ONLY のみ)なら安全側の下書き(inbox)へフォールバックする。
        const wantDirect = deps.directPost ?? process.env.TIKTOK_DIRECT_POST === '1';
        let usePublic = false;
        if (wantDirect) {
          try {
            const ciRes = await doFetch(CREATOR_INFO_URL, {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            });
            const ci = (await ciRes.json()) as { data?: { privacy_level_options?: string[] } };
            usePublic = Array.isArray(ci.data?.privacy_level_options) && ci.data!.privacy_level_options!.includes(PUBLIC_PRIVACY);
            if (!usePublic) {
              log.info({ options: ci.data?.privacy_level_options }, 'tiktok direct post requested but PUBLIC not allowed (unaudited) — falling back to inbox draft');
            }
          } catch (e) {
            log.warn({ err: e }, 'tiktok creator_info query failed — falling back to inbox draft');
          }
        }

        // init（公開=Direct Post / それ以外=inbox 下書き）
        const initUrl = usePublic ? DIRECT_POST_INIT_URL : INBOX_INIT_URL;
        const initBody: Record<string, unknown> = {
          source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 },
        };
        if (usePublic) {
          const title = (input.title || input.body || '').slice(0, TITLE_MAX);
          initBody.post_info = { title, privacy_level: PUBLIC_PRIVACY };
        }
        const initRes = await doFetch(initUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(initBody),
        });
        const ij = (await initRes.json()) as { data?: { publish_id?: string; upload_url?: string }; error?: { code?: string; message?: string } };
        const uploadUrl = ij.data?.upload_url;
        const publishId = ij.data?.publish_id;
        if (!uploadUrl) {
          const code = ij.error?.code ?? '';
          const msg = ij.error?.message ?? JSON.stringify(ij).slice(0, 200);
          const reason = /token|auth|scope|permission/i.test(`${code} ${msg}`) ? 'auth' : 'unknown';
          return { ok: false, reason, message: `TikTok init failed (${usePublic ? 'direct' : 'inbox'}): ${code} ${msg}`.trim() };
        }

        // 4. 動画バイトを PUT（単一チャンク）
        const putRes = await doFetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': String(size),
            'Content-Range': `bytes 0-${size - 1}/${size}`,
          },
          body: videoBytes as unknown as BodyInit,
        });
        if (!putRes.ok && putRes.status !== 201) {
          const t = await putRes.text().catch(() => '');
          return { ok: false, reason: 'unknown', message: `TikTok upload failed: ${putRes.status} ${t.slice(0, 160)}` };
        }

        log.info({ publishId, size, mode: usePublic ? 'direct_public' : 'inbox_draft' }, 'tiktok video uploaded');
        // 公開投稿(direct)は TikTok 側で非同期に公開される。下書き(inbox)は受信箱に届く。
        // いずれも確定 URL は同期取得できないため externalUrl は null（status/fetch で追跡可能）。
        return { ok: true, externalUrl: null };
      } catch (err) {
        log.warn({ err }, 'tiktok publish failed');
        return { ok: false, reason: 'unknown', message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
      }
    },
  };
}
