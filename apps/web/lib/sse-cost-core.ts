/**
 * CostMeter SSE 配信コア (T-07-06, docs/05 §1.4 / §4.2).
 *
 * Route Handler から I/O (auth / prisma) を分離した純粋層。
 * テストは本ファイルを直接叩く形にして、fake getCostMeterData + fake timers で
 * stream の挙動を検証する。
 *
 * 配信仕様:
 *   - `text/event-stream` 互換 (1 メッセージ = `data: <json>\n\n`)
 *   - 接続直後: 初回データを即時 enqueue (`: connected\n\n` コメント + `data:` フレーム)
 *   - ポーリング間隔 (既定 5s) ごとにデータを再取得し、前回と変化があれば enqueue
 *   - ハートビート: 既定 30s ごとに SSE コメント (`: heartbeat\n\n`) を送信
 *   - クライアント切断 (`signal.aborted`) で interval/timeout をクリアして controller.close
 *
 * 設計選択:
 *   コスト情報用の pg_notify チャネルは未実装のため、SSE レイヤーで
 *   サーバーサイド 5s ポーリングを採用。これにより CostMeter は 5 秒以内に
 *   更新される (T-07-06 受け入れ基準)。
 *   将来 `cost_update` チャネルを worker 側で追加したら LISTEN 方式に切替可能。
 */

import type { CostMeterData, CostMeterPrisma } from './cost-meter-core';
import { getCostMeterData } from './cost-meter-core';

/** SSE ポーリング間隔 (ミリ秒). 5 秒以内更新の受け入れ基準を満たす値. */
export const COST_SSE_POLL_MS = 5_000;

/** ハートビート間隔 (ミリ秒). */
export const COST_SSE_HEARTBEAT_MS = 30_000;

export interface CreateCostEventStreamOptions {
  /** getCostMeterData に渡す Prisma 互換オブジェクト. */
  prisma: CostMeterPrisma;
  /** 中断シグナル. Route Handler は `request.signal` を渡す. */
  signal: AbortSignal;
  /** ポーリング間隔 (ms). テストでは小さくする. 既定 5000. */
  pollMs?: number;
  /** ハートビート間隔 (ms). テストでは小さくする. 既定 30000. */
  heartbeatMs?: number;
  /** setInterval 差替え (テスト用 fake timers). */
  setIntervalFn?: typeof setInterval;
  /** clearInterval 差替え. */
  clearIntervalFn?: typeof clearInterval;
  /** getCostMeterData 差替え (テスト容易性). 既定は lib/cost-meter-core の実装. */
  getCostMeterDataFn?: (prisma: CostMeterPrisma, now?: Date) => Promise<CostMeterData>;
  /** 現在時刻を返す関数 (テスト固定用). */
  now?: () => Date;
  /** エラーフック. */
  onError?: (err: unknown, ctx: 'fetch' | 'cleanup') => void;
}

/**
 * SSE 用 ReadableStream<Uint8Array> を生成する.
 *
 * 1. start で初回データを取得して即時 enqueue
 * 2. pollMs ごとにデータを再取得し、JSON 変化があれば enqueue
 * 3. heartbeatMs ごとに `: heartbeat\n\n` コメントを enqueue
 * 4. signal.abort で全 interval をクリアして controller.close
 * 5. データ取得失敗は onError を呼んで握りつぶす (SSE は best-effort)
 */
export function createCostEventStream(
  opts: CreateCostEventStreamOptions,
): ReadableStream<Uint8Array> {
  const {
    prisma,
    signal,
    pollMs = COST_SSE_POLL_MS,
    heartbeatMs = COST_SSE_HEARTBEAT_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    getCostMeterDataFn = getCostMeterData,
    now,
    onError,
  } = opts;

  const encoder = new TextEncoder();
  let closed = false;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  let abortHandler: (() => void) | null = null;
  let lastJson = '';

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

  const cleanup = (
    controller: ReadableStreamDefaultController<Uint8Array> | null,
  ): void => {
    if (closed) return;
    closed = true;
    if (pollHandle != null) {
      clearIntervalFn(pollHandle);
      pollHandle = null;
    }
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
    if (controller != null) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
  };

  const fetchAndEmit = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    if (closed) return;
    let data: CostMeterData;
    try {
      data = await getCostMeterDataFn(prisma, now?.());
    } catch (err) {
      onError?.(err, 'fetch');
      return;
    }
    if (closed) return;
    const json = JSON.stringify(data);
    if (json === lastJson) return;
    lastJson = json;
    safeEnqueue(controller, `data: ${json}\n\n`);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (signal.aborted) {
        cleanup(controller);
        return;
      }

      // 接続直後に初回データを送信
      safeEnqueue(controller, ': connected\n\n');
      await fetchAndEmit(controller);

      // ポーリング
      pollHandle = setIntervalFn(() => {
        void fetchAndEmit(controller);
      }, pollMs);

      // ハートビート
      heartbeatHandle = setIntervalFn(() => {
        safeEnqueue(controller, ': heartbeat\n\n');
      }, heartbeatMs);

      abortHandler = () => {
        cleanup(controller);
      };
      signal.addEventListener('abort', abortHandler);
    },
    cancel() {
      cleanup(null);
    },
  });
}
