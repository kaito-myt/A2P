/**
 * SSE 進捗配信のコア (T-03-11, docs/05 §1.4 / §4.2.1 / ADR-001).
 *
 * Route Handler から I/O (auth / pg.Client 生成) を分離するための純粋層。
 * テストは本ファイルを直接叩く形にして、fake pg client + fake timers で
 * stream の挙動を検証する。
 *
 * 配信仕様:
 *   - `text/event-stream` 互換 (1 メッセージ = `data: <json>\n\n`)
 *   - ハートビート: 既定 30 秒毎に SSE コメント (`: heartbeat\n\n`) を送信
 *   - 接続直後: `: connected\n\n` コメントを 1 回送信
 *   - クライアント切断 (`signal.aborted`) で pg LISTEN 解除 / interval clear /
 *     controller.close を実行
 *   - pg からの notification は payload (string) をそのまま SSE フレームに乗せる
 *     (worker 側で `pg_notify('jobs', JSON.stringify(payload))` 済)
 *
 * bookId フィルタ (docs/05 §4.2 line 1008, GET /api/sse/jobs?bookId=...):
 *   - `bookIdFilter` 未指定 → 全 notification を素通し (個別書籍ページ以外)
 *   - 指定あり → payload を JSON.parse して `payload.bookId === filter` のみ流す
 *   - JSON.parse 失敗 → **素通し** (将来 schema 変更 / 部分送信に対し fail-safe).
 *     warn ログだけ吐いて握りつぶす。
 *
 * 構造化:
 *   - `JobsSsePgClient` は pg.Client の最小サブセット I/F
 *   - `createJobsEventStream({ ... })` が ReadableStream<Uint8Array> を返す
 *   - 30 秒 heartbeat / 60 秒 default 等は呼び出し側 (route.ts) で固定して渡す
 */

/** docs/05 §1.4 / §5.2 / §7 / ADR-001 で確定した LISTEN チャンネル名 (notify 側も同じ). */
export const JOB_NOTIFY_CHANNEL = 'jobs';

/** docs/05 §1.4 ハートビート間隔 (ミリ秒). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * pg.Client の最小サブセット I/F.
 * 実体は `new Client({ connectionString })` (T-03-11 §1) をそのまま渡す。
 * 型は pg.Client (= `Promise<Client>` 等を返す) と互換になるよう **戻り値は
 * `Promise<unknown>` まで広げて** あり、テスト用 fake (戻り値 `Promise<void>`)
 * とも構造的部分型で互換。テストでは下のフィールドだけが使われる。
 */
export interface JobsSsePgClient {
  connect: () => Promise<unknown>;
  query: (sql: string) => Promise<unknown>;
  end: () => Promise<void>;
  on: (event: 'notification', handler: (msg: { channel?: string; payload?: string }) => void) => unknown;
  off?: (event: 'notification', handler: (msg: { channel?: string; payload?: string }) => void) => unknown;
}

export interface CreateJobsEventStreamOptions {
  /** pg.Client 互換オブジェクト. Route Handler が request 毎に new する想定. */
  pgClient: JobsSsePgClient;
  /** 中断シグナル. Route Handler は `request.signal` を渡す. */
  signal: AbortSignal;
  /** ハートビート間隔 (ms). 既定 30000. テストでは小さくする. */
  heartbeatMs?: number;
  /** setInterval の差替え用 (テスト用 fake timers). 既定 globalThis.setInterval. */
  setIntervalFn?: typeof setInterval;
  /** clearInterval の差替え用. 既定 globalThis.clearInterval. */
  clearIntervalFn?: typeof clearInterval;
  /**
   * 書籍 ID フィルタ (docs/05 §4.2 GET /api/sse/jobs?bookId=...).
   * 指定時は payload.bookId === bookIdFilter のみを SSE に流す.
   * payload が JSON parse 不能なときは素通し (fail-safe).
   */
  bookIdFilter?: string;
  /** 構造化ログ吐き出し用フック. Route Handler は createLogger 経由を渡す. */
  onError?: (err: unknown, ctx: 'connect' | 'listen' | 'notification' | 'cleanup') => void;
}

/**
 * SSE 用 ReadableStream を生成する.
 *
 * 1. start で pg.Client.connect → LISTEN jobs
 * 2. 接続直後に `: connected\n\n` コメントを enqueue
 * 3. heartbeat 用 interval を起動
 * 4. notification ハンドラを登録, payload を `data: <payload>\n\n` で enqueue
 *    bookIdFilter 指定時は payload.bookId と比較して合致のみ enqueue
 * 5. signal.abort で cleanup (clearInterval / pg.end / controller.close)
 * 6. connect 失敗時は SSE で error フレーム送信後 controller.close
 *
 * controller.enqueue は close 後に呼ぶと throw するため、すべて try/catch で包む
 * (broken pipe / 早期 abort の状況でログを汚さない).
 */
export function createJobsEventStream(
  opts: CreateJobsEventStreamOptions,
): ReadableStream<Uint8Array> {
  const {
    pgClient,
    signal,
    heartbeatMs = HEARTBEAT_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    bookIdFilter,
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
      // 既に close 済 or backpressure 異常. ここでは握りつぶす.
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
        // 既に close 済の場合は無視.
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
        await pgClient.query(`LISTEN ${JOB_NOTIFY_CHANNEL}`);
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

        // bookId フィルタ: 指定時のみ payload を JSON 解釈して比較.
        // parse 失敗時は **素通し** (fail-safe; ログだけ残す).
        if (bookIdFilter != null && bookIdFilter.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch (err) {
            onError?.(err, 'notification');
            // 素通し継続: payload を enqueue.
            safeEnqueue(controller, `data: ${payload}\n\n`);
            return;
          }
          const bookId =
            typeof parsed === 'object' &&
            parsed !== null &&
            'bookId' in (parsed as Record<string, unknown>)
              ? (parsed as Record<string, unknown>).bookId
              : undefined;
          if (typeof bookId === 'string' && bookId !== bookIdFilter) {
            // フィルタ不一致 → skip.
            return;
          }
          // bookId 欠落 or 一致 → 流す (フィルタ指定ありかつ bookId 不明は最終的に
          //   UI 側で無視されうるが、SSE 層では filter 厳格化しないことで部分通知に強い形にする).
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
