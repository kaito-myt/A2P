/**
 * GET /api/sse/cost — CostMeter 用 SSE 配信 (T-07-06, docs/05 §1.4 / §4.2).
 *
 * - 認証必須 (`getSessionOrThrow`). 未認証は 401.
 * - サーバーサイド 5s ポーリングで `getCostMeterData` を再取得し、
 *   変化があれば SSE フレームとして配信する.
 * - 接続直後に初回データを送信するため、クライアントは即時に表示できる.
 * - ハートビート 30 秒 / クライアント切断で interval をクリア.
 * - 純粋ロジックは `lib/sse-cost-core.ts` (テスト容易性のため分離).
 */
import { prisma } from '@a2p/db';
import { AuthError } from '@a2p/contracts';
import { createLogger } from '@a2p/contracts/logger';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { createCostEventStream } from '@/lib/sse-cost-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (err instanceof AuthError) {
      return new Response('Unauthorized', { status: 401 });
    }
    throw err;
  }

  const log = createLogger('api.sse.cost');

  const stream = createCostEventStream({
    prisma,
    signal: request.signal,
    onError: (err, ctx) => {
      log.warn({ ctx, err: serializeErr(err) }, 'sse cost stream error');
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function serializeErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
