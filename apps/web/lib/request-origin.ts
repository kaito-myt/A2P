/**
 * リクエストの公開オリジン (scheme://host) を導出する。
 *
 * OAuth の redirect_uri を組み立てる用途。Railway など reverse proxy 配下では
 * `x-forwarded-proto` / `x-forwarded-host` に本来の公開ホストが載る。明示の
 * `NEXT_PUBLIC_APP_URL` / `NEXTAUTH_URL` があればそれを最優先 (正規ドメイン固定用)。
 *
 * OAuth プロバイダに登録する callback URL と完全一致させる必要があるため、UI 側の
 * 表示 (window.location.origin) とサーバ側の redirect_uri がズレないよう、可能な限り
 * リクエスト由来のオリジンを使う。
 */
export function getRequestOrigin(request: Request): string {
  const explicit = (process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const h = request.headers;
  const proto = (h.get('x-forwarded-proto') ?? '').split(',')[0]?.trim() || 'https';
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0]?.trim();
  if (host) return `${proto}://${host}`;

  // 最終フォールバック: リクエスト URL 自体のオリジン。
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}

/** TikTok OAuth の callback パス (登録用に固定)。 */
export const TIKTOK_CALLBACK_PATH = '/api/promotion/tiktok/callback';
