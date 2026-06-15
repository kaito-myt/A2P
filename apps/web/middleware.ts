/**
 * Auth.js v5 middleware (Edge ランタイム互換)
 *
 * - `/login` 以外を未ログインで叩いたら `/login` へ redirect
 *   (auth.config.ts の `callbacks.authorized` で実装)
 * - matcher で `/api/auth/*` / `/api/health` / 静的アセットを除外
 *
 * 重要: ここで auth.ts (Credentials Provider + Prisma + bcrypt) を import すると
 * Edge ランタイムに乗らない。auth.config.ts のみを使うこと。
 * https://authjs.dev/guides/edge-compatibility
 */
import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

const { auth } = NextAuth(authConfig);

export default auth;

export const config = {
  // /api/auth/* / /api/health / Next 内部 / 静的アセット (拡張子付きファイル全般) は除外。
  // /api/health は Railway の Healthcheck Path として無認証アクセスが必要 (README §5)。
  // `.*\\..*` で `public/` 配下の画像 (logo.png 等) や favicon を一括除外する
  // (Next.js auth middleware 公式推奨パターン)。これがないと未ログイン状態で
  // /logo.png が /login に 307 され、Image Optimizer (/_next/image) が PNG 取得に失敗する。
  matcher: ['/((?!api/auth|api/health|_next/static|_next/image|.*\\..*).*)'],
};
