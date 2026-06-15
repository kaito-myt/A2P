/**
 * GET /api/health — Railway Healthcheck Path (README §5)
 *
 * - DB に `SELECT 1` を投げ、成功なら 200 / 失敗なら 503
 * - 認証不要 (middleware.ts の matcher で `/api/health` を除外)
 * - Prisma を使うため Node ランタイム必須
 *
 * 純粋ロジックは lib/health-core.ts、本ファイルは route binding のみ。
 */
import { NextResponse } from 'next/server';
import { prisma } from '@a2p/db';
import { checkHealth } from '@/lib/health-core';

export const runtime = 'nodejs';
// WHY: ヘルスチェックは常に DB の現在状態を返す必要があるため、
// Next.js の route キャッシュを完全に無効化する。
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<NextResponse> {
  const result = await checkHealth(prisma);
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
