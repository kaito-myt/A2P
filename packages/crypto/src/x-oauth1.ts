import { createHmac, randomBytes } from 'node:crypto';

/**
 * X (Twitter) API v2 用の OAuth 1.0a User-Context 署名ヘルパ。
 *
 * 単一運営者のツールなので、失効しない **OAuth 1.0a のアクセストークン**
 * (API Key/Secret + Access Token/Secret の4値) で自分のアカウントに投稿する。
 * (OAuth 2.0 のユーザートークンは2時間で失効し refresh が要るため採用しない。)
 *
 * `POST /2/tweets` は JSON ボディだが、OAuth 1.0a では **application/x-www-form-urlencoded
 * 以外のボディは署名ベース文字列に含めない**。よって署名対象は oauth_* パラメータ
 * (＋クエリ文字列があればそれ) のみ。X はこの方式を受理する。
 */

export interface XOAuth1Credentials {
  /** kind 判別子: JSON で保存された資格情報が OAuth1 か Bearer かを見分ける。 */
  kind: 'oauth1';
  apiKey: string; // consumer key
  apiSecret: string; // consumer secret
  accessToken: string;
  accessTokenSecret: string;
}

/** レガシー/簡易: 単一 Bearer トークン (OAuth2 ユーザートークン等)。 */
export interface XBearerCredentials {
  kind: 'bearer';
  token: string;
}

export type XCredentials = XOAuth1Credentials | XBearerCredentials;

/** RFC 3986 準拠のパーセントエンコード (OAuth 1.0a 要件)。 */
export function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export interface OAuth1SignOptions {
  /** テスト用: nonce 固定。 */
  nonce?: string;
  /** テスト用: timestamp(秒) 固定。 */
  timestamp?: number;
  /** フォームボディ/クエリのパラメータ (JSON ボディの場合は渡さない)。 */
  extraParams?: Record<string, string>;
}

/**
 * OAuth 1.0a の署名ベース文字列を組み立てる (テスト検証しやすいよう分離)。
 * `allParams` は oauth_* パラメータ＋フォーム/クエリパラメータ (JSON ボディは含めない)。
 */
export function buildOAuth1BaseString(
  method: string,
  url: string,
  allParams: Record<string, string>,
): string {
  const paramString = Object.keys(allParams)
    .map((k) => [percentEncode(k), percentEncode(allParams[k]!)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join('&');
}

/**
 * 署名ベース文字列と HMAC-SHA1 署名を計算する (ヘッダ生成とテストで共用)。
 */
export function computeOAuth1Signature(
  method: string,
  url: string,
  creds: XOAuth1Credentials,
  opts: OAuth1SignOptions = {},
): { baseString: string; signature: string; oauthParams: Record<string, string> } {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const allParams: Record<string, string> = { ...oauthParams, ...(opts.extraParams ?? {}) };
  const baseString = buildOAuth1BaseString(method, url, allParams);
  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');
  return { baseString, signature, oauthParams };
}

/**
 * OAuth 1.0a の `Authorization: OAuth ...` ヘッダ値を生成する。
 */
export function buildXOAuth1Header(
  method: string,
  url: string,
  creds: XOAuth1Credentials,
  opts: OAuth1SignOptions = {},
): string {
  const { signature, oauthParams } = computeOAuth1Signature(method, url, creds, opts);
  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k]!)}"`)
      .join(', ')
  );
}

/**
 * 保存されたトークン文字列 (復号後) を X 資格情報として解釈する。
 *   - JSON `{ kind:'oauth1', apiKey, apiSecret, accessToken, accessTokenSecret }` → OAuth1
 *   - それ以外の非空文字列 → Bearer (レガシー)
 *   - 空/無効 → null
 */
export function parseXCredentials(raw: string | null | undefined): XCredentials | null {
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        j.kind === 'oauth1' &&
        typeof j.apiKey === 'string' &&
        typeof j.apiSecret === 'string' &&
        typeof j.accessToken === 'string' &&
        typeof j.accessTokenSecret === 'string' &&
        j.apiKey && j.apiSecret && j.accessToken && j.accessTokenSecret
      ) {
        return {
          kind: 'oauth1',
          apiKey: j.apiKey,
          apiSecret: j.apiSecret,
          accessToken: j.accessToken,
          accessTokenSecret: j.accessTokenSecret,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
  return { kind: 'bearer', token: trimmed };
}

/** UI が受け取った4値を保存用の JSON 文字列にまとめる。 */
export function serializeXOAuth1(input: {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}): string {
  const cred: XOAuth1Credentials = {
    kind: 'oauth1',
    apiKey: input.apiKey.trim(),
    apiSecret: input.apiSecret.trim(),
    accessToken: input.accessToken.trim(),
    accessTokenSecret: input.accessTokenSecret.trim(),
  };
  return JSON.stringify(cred);
}

/**
 * X リクエスト用の Authorization ヘッダを資格情報種別に応じて生成する。
 * OAuth1 → 署名ヘッダ、Bearer → `Bearer <token>`。
 */
export function buildXAuthHeader(
  method: string,
  url: string,
  creds: XCredentials,
  opts?: OAuth1SignOptions,
): string {
  if (creds.kind === 'bearer') return `Bearer ${creds.token}`;
  return buildXOAuth1Header(method, url, creds, opts);
}
