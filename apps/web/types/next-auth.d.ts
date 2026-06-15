/**
 * Auth.js v5 (next-auth) の Session / JWT 型を拡張する。
 * docs/05 §13 #8: session.user に id / username を必ず含める。
 */
import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      username: string;
    } & DefaultSession['user'];
  }

  interface User {
    id?: string;
    username?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    username?: string;
  }
}
