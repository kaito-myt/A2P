/**
 * URL サニタイザ (T-01-09 review fix)
 *
 * `?callbackUrl=` 経由のオープンリダイレクト対策。攻撃面:
 *   /login?callbackUrl=https://evil.com → ログイン直後に外部へ送り出される
 *
 * 許可ルール (どれにも当てはまらなければ fallback="/" を返す):
 *   1. `/` で始まり `//` で始まらない相対パス → そのまま許可
 *   2. `URL` で parse でき、origin が許可済み origin と一致 → pathname+search+hash を返す
 *   3. それ以外 → fallback
 *
 * ブラウザでは origin に `window.location.origin` を渡す。SSR では request URL の origin
 * もしくは `process.env.NEXTAUTH_URL` / `NEXT_PUBLIC_APP_URL` から導出する想定。
 */

export interface SafeCallbackUrlOptions {
  /** 同一オリジン比較用の許可 origin。省略時は相対パスのみ許可。 */
  allowedOrigin?: string;
  /** サニタイズ失敗時の戻り値。既定 "/"。 */
  fallback?: string;
}

export function safeCallbackUrl(raw: unknown, options: SafeCallbackUrlOptions = {}): string {
  const fallback = options.fallback ?? '/';
  if (typeof raw !== 'string' || raw.length === 0) return fallback;

  // (1) 相対パス: `/` で始まり `//` または `/\` で始まらない
  //  - `//evil.com` は protocol-relative URL なのでブロック
  //  - `/\evil.com` も一部ブラウザで protocol-relative 扱いになりうるためブロック
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) {
    return raw;
  }

  // (2) 絶対 URL: 許可 origin が指定されていて、origin が一致する場合のみ
  if (options.allowedOrigin) {
    try {
      const parsed = new URL(raw);
      if (parsed.origin === options.allowedOrigin) {
        return `${parsed.pathname}${parsed.search}${parsed.hash}` || fallback;
      }
    } catch {
      /* fallthrough */
    }
  }

  return fallback;
}
