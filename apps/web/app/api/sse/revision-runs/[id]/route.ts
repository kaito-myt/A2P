/**
 * GET /api/sse/revision-runs/[id] — 修正一括反映 進捗 SSE 配信 (T-06-10, docs/05 ss1.4).
 *
 * - 認証必須 (`getSessionOrThrow`). 未認証は 401.
 * - PostgreSQL `LISTEN revision_runs_progress` を購読し、worker 側の
 *   `pg_notify('revision_runs_progress', ...)` をフィルタして配信.
 * - payload の `runId` が path param `[id]` と一致するイベントのみ送信.
 * - run 完了時は `event: done` を送信して SSE を close.
 * - heartbeat 30 秒 / クライアント切断で pg 接続解放.
 */
import { Client as PgClient } from 'pg';

import { AuthError } from '@a2p/contracts';
import { createLogger } from '@a2p/contracts/logger';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { createRevisionRunsEventStream } from '@/lib/sse-revision-runs-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (err instanceof AuthError) {
      return new Response('Unauthorized', { status: 401 });
    }
    throw err;
  }

  const { id: runId } = await params;
  const log = createLogger('api.sse.revision-runs');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.length === 0) {
    log.error({}, 'DATABASE_URL not set — cannot open SSE stream');
    return new Response('Service Unavailable', { status: 503 });
  }

  const pgClient = new PgClient({ connectionString });

  const stream = createRevisionRunsEventStream({
    pgClient,
    signal: request.signal,
    runIdFilter: runId,
    onError: (err, ctx) => {
      log.warn({ ctx, err: serializeErr(err) }, 'sse revision-runs stream error');
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
