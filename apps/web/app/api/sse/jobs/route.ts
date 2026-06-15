/**
 * GET /api/sse/jobs — ジョブ進捗 SSE 配信 (T-03-11, docs/05 §1.4 / §4.2.1 / ADR-001).
 *
 * - 認証必須 (`getSessionOrThrow`). 未認証は 401 Unauthorized.
 * - PostgreSQL の LISTEN/NOTIFY を購読し、worker 側の `pg_notify('jobs', ...)`
 *   をそのまま `text/event-stream` で配信する.
 * - ハートビート 30 秒 / クライアント切断 (`request.signal.aborted`) で pg 接続解放.
 * - 純粋ロジックは `lib/sse-jobs-core.ts` (テスト容易性のため分離).
 * - クエリ `?bookId=...` でフィルタ可能 (docs/05 §4.2 line 1008).
 *
 * 注意:
 *   - pg.Client は **request 毎に new する** (グローバル pool だと
 *     クライアント断と LISTEN チャネルの整合が崩れるリスク).
 *   - `serverExternalPackages: ['pg', 'pg-native']` で webpack バンドル回避済.
 *   - Node ランタイム必須 (Edge では `pg` 不可).
 */
import { Client as PgClient } from 'pg';

import { AuthError } from '@a2p/contracts';
import { createLogger } from '@a2p/contracts/logger';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { createJobsEventStream } from '@/lib/sse-jobs-core';

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

  const log = createLogger('api.sse.jobs');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.length === 0) {
    log.error({}, 'DATABASE_URL not set — cannot open SSE stream');
    return new Response('Service Unavailable', { status: 503 });
  }

  // ?bookId=... を取得. 空文字 / null は「フィルタ無し」扱い.
  const url = new URL(request.url);
  const bookIdParam = url.searchParams.get('bookId');
  const bookIdFilter =
    bookIdParam != null && bookIdParam.length > 0 ? bookIdParam : undefined;

  const pgClient = new PgClient({ connectionString });

  const stream = createJobsEventStream({
    pgClient,
    signal: request.signal,
    bookIdFilter,
    onError: (err, ctx) => {
      log.warn({ ctx, err: serializeErr(err) }, 'sse stream error');
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx 等のリバースプロキシでのバッファリング無効化 (docs/05 §1.4).
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
