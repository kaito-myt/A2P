/**
 * Auth.js v5 共通設定 (middleware + Node auth で共有)
 *
 * Auth.js v5 では Credentials Provider と Prisma が Edge Runtime で動かないため、
 * - middleware.ts は **この auth.config.ts のみ** を import する（Edge 互換）
 * - apps/web/auth.ts は config + providers を追加して Node ランタイムで動く NextAuth を export する
 *
 * 詳細: https://authjs.dev/guides/edge-compatibility
 */
import type { NextAuthConfig } from 'next-auth';

export const authConfig: NextAuthConfig = {
  // リバースプロキシ (Railway 等) 配下で Host ヘッダを信頼する。
  // 未設定だと Auth.js v5 が UntrustedHost エラーを投げ、/api/auth/session 解決が
  // 失敗して /login が 500 になる。AUTH_TRUST_HOST env でも可だがコードで明示する。
  trustHost: true,
  // セッション期限 30 日 [F-043 受け入れ基準]
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days (seconds)
  },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    /**
     * middleware から呼ばれる認可コールバック。
     * - `/login` 以外を未認証で叩いたら false → middleware が signIn ページへ redirect
     * - `/api/auth/*` と公開リソースは matcher 側で除外
     */
    authorized({ auth, request }) {
      const isLoggedIn = Boolean(auth?.user);
      const { pathname } = request.nextUrl;

      // F-052b: 所有ブログ (/blog, /blog/*) は販促用の公開ページ — 未認証で閲覧可。
      if (pathname === '/blog' || pathname.startsWith('/blog/')) {
        return true;
      }

      // 書籍カタログ (/books) は SNS プロフィールリンクの導線先 — 未認証で閲覧可。
      if (pathname === '/books' || pathname.startsWith('/books/')) {
        return true;
      }

      // 法務ページ (/legal/*) は公開必須 — プライバシーポリシー/利用規約は
      // TikTok 等の外部審査で URL 提出に使うため、未認証で閲覧可。
      if (pathname === '/legal' || pathname.startsWith('/legal/')) {
        return true;
      }

      const isLoginPage = pathname === '/login';
      if (isLoginPage) {
        // 既にログイン済みでログイン画面に来たらダッシュボードへ
        if (isLoggedIn) {
          const dashboard = new URL('/', request.nextUrl);
          return Response.redirect(dashboard);
        }
        return true;
      }
      return isLoggedIn;
    },
    /** JWT に user.id / user.username を埋め込む。 */
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        // user.username はカスタムフィールド (auth.ts authorize で付与)
        const candidate = (user as { username?: unknown }).username;
        if (typeof candidate === 'string') {
          token.username = candidate;
        }
      }
      return token;
    },
    /** session.user.id / username を露出する。 */
    session({ session, token }) {
      if (session.user) {
        if (typeof token.id === 'string') session.user.id = token.id;
        if (typeof token.username === 'string') session.user.username = token.username;
      }
      return session;
    },
  },
  providers: [], // 実 provider は apps/web/auth.ts で追加
};
