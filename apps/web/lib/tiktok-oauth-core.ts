/**
 * TikTok OAuth (authorization_code) をアプリ内で完結させるためのコア。
 *
 * フロー:
 *   1. 運営者が Client Key / Client Secret を UI で保存 (`saveTikTokAppCredentialsCore`)。
 *      → `promotion_channel_settings(channel='tiktok').token_enc` に
 *        `{kind:'tiktok', clientKey, clientSecret, refreshToken:'', openId:''}` を暗号化保存。
 *      refreshToken が空なので「アプリ資格情報のみ・未接続」状態 (probe/publisher は not_connected)。
 *   2. 「TikTokと接続」→ `/api/promotion/tiktok/start` が authorize URL へリダイレクト。
 *   3. TikTok が `/api/promotion/tiktok/callback?code=...` へ返す → `exchangeTikTokCode` で
 *      access_token/refresh_token/open_id を取得し、フル資格情報を保存 → 接続完了。
 *
 * redirect_uri は TikTok Developer portal (Login Kit) に登録した URL と完全一致が必須。
 * UI に表示する callback URL とサーバの redirect_uri は同一オリジンから導出して揃える。
 */
export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

/** 既定スコープ。Sandbox は video.publish 不可のため upload まで。env で上書き可。 */
export function tiktokScopes(): string {
  return (process.env.TIKTOK_SCOPES ?? 'user.info.basic,video.upload').trim();
}

export interface TikTokStoredCreds {
  kind: 'tiktok';
  clientKey: string;
  clientSecret: string;
  refreshToken: string;
  openId: string;
}

/** token_enc の復号文字列を TikTok 資格情報として緩く解釈 (refreshToken 空も許容)。 */
export function parseStoredTikTok(raw: string | null): TikTokStoredCreds | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<TikTokStoredCreds>;
    if (o.kind === 'tiktok' && o.clientKey && o.clientSecret) {
      return {
        kind: 'tiktok',
        clientKey: o.clientKey,
        clientSecret: o.clientSecret,
        refreshToken: o.refreshToken ?? '',
        openId: o.openId ?? '',
      };
    }
  } catch {
    /* not json */
  }
  return null;
}

export interface TikTokOAuthDeps {
  channelSettingRepo: {
    findUnique: (a: { where: { channel: string }; select?: unknown }) => Promise<{ token_enc: string | null } | null>;
    upsert: (a: unknown) => Promise<unknown>;
  };
  encrypt: (plain: string) => string;
  decrypt: (enc: string) => string;
  mask: (s: string) => string;
}

/** 保存済みの TikTok 資格情報 (Client Key/Secret 含む) を取得。 */
export async function readTikTokCreds(deps: TikTokOAuthDeps): Promise<TikTokStoredCreds | null> {
  const row = await deps.channelSettingRepo.findUnique({ where: { channel: 'tiktok' }, select: { token_enc: true } });
  if (!row?.token_enc) return null;
  let dec: string;
  try {
    dec = deps.decrypt(row.token_enc);
  } catch {
    return null;
  }
  return parseStoredTikTok(dec);
}

/** Client Key / Client Secret を保存 (既存の refreshToken/openId は温存)。 */
export async function saveTikTokAppCredentialsCore(
  input: { clientKey: string; clientSecret: string },
  deps: TikTokOAuthDeps,
): Promise<void> {
  const clientKey = input.clientKey.trim();
  const clientSecret = input.clientSecret.trim();
  const existing = await readTikTokCreds(deps);
  const creds: TikTokStoredCreds = {
    kind: 'tiktok',
    clientKey,
    clientSecret,
    refreshToken: existing?.refreshToken ?? '',
    openId: existing?.openId ?? '',
  };
  await persistTikTok(creds, deps);
}

/** フル資格情報を暗号化して保存。 */
export async function persistTikTok(creds: TikTokStoredCreds, deps: TikTokOAuthDeps): Promise<void> {
  const enc = deps.encrypt(JSON.stringify(creds));
  const mask = deps.mask(creds.openId || creds.refreshToken || creds.clientKey);
  await deps.channelSettingRepo.upsert({
    where: { channel: 'tiktok' },
    create: { channel: 'tiktok', auto_enabled: false, token_enc: enc, token_mask: mask },
    update: { token_enc: enc, token_mask: mask },
  });
}

export interface TikTokTokenResponse {
  access_token?: string;
  refresh_token?: string;
  open_id?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * authorization_code を access/refresh token に交換する。成功時、フル資格情報を保存し返す。
 * fetch は DI 可能 (テスト)。
 */
export async function exchangeTikTokCode(
  input: { code: string; redirectUri: string },
  deps: TikTokOAuthDeps,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; creds: TikTokStoredCreds } | { ok: false; error: string }> {
  const app = await readTikTokCreds(deps);
  if (!app) return { ok: false, error: 'Client Key / Client Secret が未保存です。先に保存してください。' };

  const res = await fetchImpl(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: app.clientKey,
      client_secret: app.clientSecret,
      code: input.code,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  const j = (await res.json()) as TikTokTokenResponse;
  if (!j.access_token || !j.refresh_token) {
    return { ok: false, error: `${j.error ?? 'exchange_failed'}: ${j.error_description ?? ''}`.trim() };
  }
  const creds: TikTokStoredCreds = {
    kind: 'tiktok',
    clientKey: app.clientKey,
    clientSecret: app.clientSecret,
    refreshToken: j.refresh_token,
    openId: j.open_id ?? app.openId ?? '',
  };
  await persistTikTok(creds, deps);
  return { ok: true, creds };
}
