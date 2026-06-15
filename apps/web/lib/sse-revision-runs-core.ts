/**
 * SSE 進捗配信コア — 修正一括反映 (T-06-10, docs/05 ss1.4 / ss4.2).
 *
 * `sse-jobs-core.ts` と同パターン。Route Handler から I/O を分離した純粋層。
 *
 * 配信仕様:
 *   - `text/event-stream` 互換 (1 message = `data: <json>\n\n`)
 *   - heartbeat: 30 秒毎に `: heartbeat\n\n`
 *   - 接続直後: `: connected\n\n`
 *   - クライアント切断 (`signal.aborted`) で pg LISTEN 解除 / interval clear / close
 *   - pg notification は payload の `runId` でフィルタし、該当 run のみ配信
 *   - payload に `status: 'done' | 'partial' | 'failed'` が含まれる場合、
 *     `event: done\n` prefix 付きで送信し、その後 stream を close
 *
 * channel: `revision_runs_progress` (worker 側 `revision-book-apply.ts` で発火)
 */

export const REVISION_RUNS_NOTIFY_CHANNEL = 'revision_runs_progress';

export const HEARTBEAT_INTERVAL_MS = 30_000;

const TERMINAL_STATUSES = new Set(['done', 'partial', 'failed']);

export interface RevisionRunsSsePgClient {
  connect: () => Promise<unknown>;
  query: (sql: string) => Promise<unknown>;
  end: () => Promise<void>;
  on: (event: 'notification', handler: (msg: { channel?: string; payload?: string }) => void) => unknown;
  off?: (event: 'notification', handler: (msg: { channel?: string; payload?: string }) => void) => unknown;
}

export interface CreateRevisionRunsEventStreamOptions {
  pgClient: RevisionRunsSsePgClient;
  signal: AbortSignal;
  runIdFilter: string;
  heartbeatMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onError?: (err: unknown, ctx: 'connect' | 'listen' | 'notification' | 'cleanup') => void;
}

export function createRevisionRunsEventStream(
  opts: CreateRevisionRunsEventStreamOptions,
): ReadableStream<Uint8Array> {
  const {
    pgClient,
    signal,
    runIdFilter,
    heartbeatMs = HEARTBEAT_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    onError,
  } = opts;

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  let notificationHandler:
    | ((msg: { channel?: string; payload?: string }) => void)
    | null = null;
  let abortHandler: (() => void) | null = null;

  const safeEnqueue = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: string,
  ): void => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      // already closed or backpressure
    }
  };

  const cleanup = async (
    controller: ReadableStreamDefaultController<Uint8Array> | null,
  ): Promise<void> => {
    if (closed) return;
    closed = true;
    if (heartbeatHandle != null) {
      clearIntervalFn(heartbeatHandle);
      heartbeatHandle = null;
    }
    if (abortHandler != null) {
      try {
        signal.removeEventListener('abort', abortHandler);
      } catch {
        // noop
      }
      abortHandler = null;
    }
    if (notificationHandler != null && pgClient.off) {
      try {
        pgClient.off('notification', notificationHandler);
      } catch {
        // noop
      }
    }
    notificationHandler = null;
    try {
      await pgClient.end();
    } catch (err) {
      onError?.(err, 'cleanup');
    }
    if (controller != null) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (signal.aborted) {
        await cleanup(controller);
        return;
      }

      try {
        await pgClient.connect();
      } catch (err) {
        onError?.(err, 'connect');
        safeEnqueue(
          controller,
          `event: error\ndata: ${JSON.stringify({ message: 'pg connection failed' })}\n\n`,
        );
        await cleanup(controller);
        return;
      }

      try {
        await pgClient.query(`LISTEN ${REVISION_RUNS_NOTIFY_CHANNEL}`);
      } catch (err) {
        onError?.(err, 'listen');
        safeEnqueue(
          controller,
          `event: error\ndata: ${JSON.stringify({ message: 'listen failed' })}\n\n`,
        );
        await cleanup(controller);
        return;
      }

      safeEnqueue(controller, ': connected\n\n');

      heartbeatHandle = setIntervalFn(() => {
        safeEnqueue(controller, ': heartbeat\n\n');
      }, heartbeatMs);

      notificationHandler = (msg) => {
        const payload = typeof msg?.payload === 'string' ? msg.payload : '';
        if (payload.length === 0) return;

        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(payload) as Record<string, unknown>;
        } catch (err) {
          onError?.(err, 'notification');
          return;
        }

        if (typeof parsed.runId !== 'string' || parsed.runId !== runIdFilter) {
          return;
        }

        const status = typeof parsed.status === 'string' ? parsed.status : '';
        if (TERMINAL_STATUSES.has(status)) {
          safeEnqueue(controller, `event: done\ndata: ${payload}\n\n`);
          void cleanup(controller);
          return;
        }

        safeEnqueue(controller, `data: ${payload}\n\n`);
      };
      pgClient.on('notification', notificationHandler);

      abortHandler = () => {
        void cleanup(controller);
      };
      signal.addEventListener('abort', abortHandler);
    },
    async cancel() {
      await cleanup(null);
    },
  });
}
