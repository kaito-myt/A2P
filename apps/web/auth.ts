/**
 * Auth.js v5 — Credentials Provider + Prisma 連携 (Node ランタイム)
 *
 * Edge ランタイムからは `auth.config.ts` を直接 import する。本ファイルは
 * `bcryptjs` / Prisma / 環境変数アクセスを含むため Node 専用。
 *
 * Auth.js v5 公式パターン: https://authjs.dev/getting-started/installation
 */
import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { prisma } from '@a2p/db';
import { authConfig } from './auth.config';
import { authorizeWithPrisma } from './lib/auth-service';

/**
 * 認証失敗種別を UI に伝えるためのカスタムエラー。
 * Auth.js v5 では authorize() で throw した CredentialsSignin の `code` が
 * `?error=<code>` で signIn ページに渡る。
 */
class A2PCredentialsError extends CredentialsSignin {
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        username: { label: 'username', type: 'text' },
        password: { label: 'password', type: 'password' },
      },
      async authorize(rawCredentials) {
        const result = await authorizeWithPrisma(
          {
            username: rawCredentials?.username,
            password: rawCredentials?.password,
          },
          prisma,
        );

        switch (result.kind) {
          case 'ok':
            return { id: result.user.id, username: result.user.username };
          case 'invalid_credentials':
            throw new A2PCredentialsError(`invalid_credentials:${result.remaining}`);
          case 'locked':
            throw new A2PCredentialsError(`locked:${result.unlockAt.toISOString()}`);
          case 'missing_fields':
            throw new A2PCredentialsError('missing_fields');
          default: {
            // VerifyCredentialsResult に kind が追加されたら型エラーで気づける
            const _exhaustive: never = result;
            throw _exhaustive;
          }
        }
      },
    }),
  ],
});
