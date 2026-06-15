/**
 * docs/05 §13 #8: `getSessionOrThrow()` を `apps/web/lib/auth.ts` に置き、
 * SA / RH の最初で呼ぶ。本リポジトリでは責務分離のため `auth-helpers.ts` に配置。
 */
import { AuthError } from '@a2p/contracts';
import { messages } from './messages';

export interface AuthenticatedSession {
  user: {
    id: string;
    username: string;
  };
  /** Auth.js v5 が返す追加情報 (expires など) を保持する素通し領域。 */
  expires?: string;
}

export interface SessionLike {
  user?: {
    id?: unknown;
    username?: unknown;
  } | null;
  expires?: unknown;
}

/**
 * session-like オブジェクトを受け取り、`id` / `username` が揃っていれば返す。
 * 揃っていない場合は `AuthError` を throw。
 *
 * 真の `auth()` (next-auth) は SSR 経路 (next/headers) を踏むため、
 * このヘルパは純関数として **session オブジェクトを受け取る** 設計にして
 * テスト容易性を担保する。実利用箇所は次のラッパを使う。
 */
export function assertAuthenticatedSession(session: SessionLike | null | undefined): AuthenticatedSession {
  const user = session?.user;
  const id = user?.id;
  const username = user?.username;
  if (typeof id !== 'string' || id.length === 0 || typeof username !== 'string' || username.length === 0) {
    throw new AuthError('Unauthenticated', { userMessage: messages.auth.unauthorized });
  }
  return {
    user: { id, username },
    ...(typeof session?.expires === 'string' ? { expires: session.expires } : {}),
  };
}

/**
 * SA / RH の最初で呼ぶ薄いラッパ。`auth()` (next-auth) を呼んで
 * `assertAuthenticatedSession` に通す。
 *
 * 動的 import で `next-auth` 側を遅延ロードし、ユニットテストでは
 * `assertAuthenticatedSession` を直接テストできる構造にしている。
 */
export async function getSessionOrThrow(): Promise<AuthenticatedSession> {
  const { auth } = await import('../auth');
  const session = await auth();
  return assertAuthenticatedSession(session as SessionLike | null);
}
