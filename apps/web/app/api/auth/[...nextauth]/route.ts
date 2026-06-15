/**
 * Auth.js v5 catch-all route handler (docs/05 §4.2: `/api/auth/[...nextauth]`)
 * https://authjs.dev/getting-started/installation#configure
 *
 * Credentials + Prisma を使う関係で **Node ランタイム必須**。
 */
import { handlers } from '@/auth';

export const runtime = 'nodejs';

export const { GET, POST } = handlers;
