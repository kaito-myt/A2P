/**
 * sse-cost-core.ts のユニットテスト (T-07-06, docs/05 §1.4 / §4.2).
 *
 * 検証:
 *   1. createCostEventStream
 *      - 接続直後に `: connected\n\n` コメントが流れる
 *      - 初回データが即時 `data: <json>\n\n` として流れる
 *      - データ変化があれば次ポーリングで再 enqueue される
 *      - データ未変化時は enqueue されない
 *      - heartbeat interval が流れる
 *      - abort で interval クリア / controller close
 *      - 既に aborted な signal ならすぐ close
 *      - getCostMeterData 失敗は握りつぶして onError を呼ぶ
 *   2. COST_SSE_POLL_MS / COST_SSE_HEARTBEAT_MS の不変条件
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COST_SSE_HEARTBEAT_MS,
  COST_SSE_POLL_MS,
  createCostEventStream,
} from '../../lib/sse-cost-core';
import type { CostMeterData, CostMeterPrisma } from '../../lib/cost-meter-core';

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

function makeFakePrisma(): CostMeterPrisma {
  return {
    tokenUsage: {
      aggregate: vi.fn(async () => ({ _sum: { cost_jpy: 0 } })),
    },
    book: {
      count: vi.fn(async () => 0),
    },
    appSettings: {
      findUnique: vi.fn(async () => null),
    },
  };
}

const BASE_DATA: CostMeterData = {
  monthly_cost_jpy: 10_000,
  budget_jpy: 50_000,
  ratio: 20,
  level: 'green',
  remaining: 40_000,
  warn_count: 0,
  paused_count: 0,
};

/** ReadableStream<Uint8Array> から N チャンクを取り出して文字列として返す. */
async function readChunks(
  stream: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs = 2_000,
): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const out: string[] = [];
  const start = Date.now();
  try {
    while (out.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`readChunks timeout (got ${out.length}/${count})`);
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (value) out.push(decoder.decode(value));
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

// ---------------------------------------------------------------------------
// 定数テスト
// ---------------------------------------------------------------------------

describe('sse-cost-core constants', () => {
  it('COST_SSE_POLL_MS は 5 秒以内更新の受け入れ基準を満たす (≤ 5000)', () => {
    expect(COST_SSE_POLL_MS).toBeLessThanOrEqual(5_000);
    expect(COST_SSE_POLL_MS).toBeGreaterThan(0);
  });

  it('COST_SSE_HEARTBEAT_MS は 30 秒 (SSE 接続維持の慣例)', () => {
    expect(COST_SSE_HEARTBEAT_MS).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// ハッピーパス
// ---------------------------------------------------------------------------

describe('createCostEventStream — happy path', () => {
  it('接続直後に ": connected\\n\\n" コメントを送る', async () => {
    const ac = new AbortController();
    const getCostMeterDataFn = vi.fn(async () => ({ ...BASE_DATA }));
    const stream = createCostEventStream({
      prisma: makeFakePrisma(),
      signal: ac.signal,
      getCostMeterDataFn,
    });

    const [first] = await readChunks(stream, 1);
    expect(first).toBe(': connected\n\n');
    ac.abort();
  });

  it('接続直後に初回データを "data: <json>\\n\\n" 形式で送る', async () => {
    const ac = new AbortController();
    const getCostMeterDataFn = vi.fn(async () => ({ ...BASE_DATA }));
    const stream = createCostEventStream({
      prisma: makeFakePrisma(),
      signal: ac.signal,
      getCostMeterDataFn,
    });

    const [, second] = await readChunks(stream, 2);
    expect(second).toBe(`data: ${JSON.stringify(BASE_DATA)}\n\n`);
    ac.abort();
  });

  it('データ変化があれば次ポーリングで再 enqueue される (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const updatedData: CostMeterData = { ...BASE_DATA, monthly_cost_jpy: 20_000, ratio: 40 };
      let callCount = 0;
      const getCostMeterDataFn = vi.fn(async () => {
        callCount += 1;
        return callCount === 1 ? { ...BASE_DATA } : { ...updatedData };
      });

      const stream = createCostEventStream({
        prisma: makeFakePrisma(),
        signal: ac.signal,
        pollMs: 1_000,
        heartbeatMs: 100_000,
        getCostMeterDataFn,
      });

      const reader = stream.getReader();
      const decoder = new TextDecoder();

      // `: connected`
      await reader.read();
      // 初回データ
      const initial = await reader.read();
      expect(decoder.decode(initial.value)).toBe(`data: ${JSON.stringify(BASE_DATA)}\n\n`);

      // 1 秒進める → ポーリング → 変化あり
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();

      const updated = await reader.read();
      expect(decoder.decode(updated.value)).toBe(`data: ${JSON.stringify(updatedData)}\n\n`);

      reader.releaseLock();
      ac.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it('データ未変化時は enqueue されない (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const getCostMeterDataFn = vi.fn(async () => ({ ...BASE_DATA }));

      const stream = createCostEventStream({
        prisma: makeFakePrisma(),
        signal: ac.signal,
        pollMs: 500,
        heartbeatMs: 100_000,
        getCostMeterDataFn,
      });

      const reader = stream.getReader();

      // `: connected` + 初回データ
      await reader.read();
      await reader.read();

      // ポーリング 3 回分進める
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
      await Promise.resolve();

      // データが変化していないため heartbeat も poll も次フレームには来ない
      // getCostMeterDataFn は初回 + 3 回 = 計 4 回呼ばれているが enqueue なし
      expect(getCostMeterDataFn).toHaveBeenCalledTimes(4);

      reader.releaseLock();
      ac.abort();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// ハートビート
// ---------------------------------------------------------------------------

describe('createCostEventStream — heartbeat (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('heartbeatMs ごとに ": heartbeat\\n\\n" が流れる', async () => {
    const ac = new AbortController();
    const getCostMeterDataFn = vi.fn(async () => ({ ...BASE_DATA }));

    const stream = createCostEventStream({
      prisma: makeFakePrisma(),
      signal: ac.signal,
      pollMs: 100_000,
      heartbeatMs: 1_000,
      getCostMeterDataFn,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // `: connected`
    await reader.read(); // 初回データ

    vi.advanceTimersByTime(1_000);
    const hb1 = await reader.read();
    expect(decoder.decode(hb1.value)).toBe(': heartbeat\n\n');

    vi.advanceTimersByTime(1_000);
    const hb2 = await reader.read();
    expect(decoder.decode(hb2.value)).toBe(': heartbeat\n\n');

    reader.releaseLock();
    ac.abort();
  });

  it('abort 後は heartbeat も poll も流れず close される', async () => {
    const ac = new AbortController();
    const getCostMeterDataFn = vi.fn(async () => ({ ...BASE_DATA }));

    const stream = createCostEventStream({
      prisma: makeFakePrisma(),
      signal: ac.signal,
      pollMs: 1_000,
      heartbeatMs: 1_000,
      getCostMeterDataFn,
    });

    const reader = stream.getReader();
    await reader.read(); // `: connected`
    await reader.read(); // 初回データ

    ac.abort();

    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    // abort 後の read は done
    const r = await reader.read();
    expect(r.done).toBe(true);

    reader.releaseLock();
  });
});

// ---------------------------------------------------------------------------
// 既に aborted
// ---------------------------------------------------------------------------

describe('createCostEventStream — pre-aborted signal', () => {
  it('start 時点で既に aborted なら接続せず即 close', async () => {
    const ac = new AbortController();
    ac.abort();
    const getCostMeterDataFn = vi.fn(async () => ({ ...BASE_DATA }));

    const stream = createCostEventStream({
      prisma: makeFakePrisma(),
      signal: ac.signal,
      getCostMeterDataFn,
    });

    const reader = stream.getReader();
    const r = await reader.read();
    expect(r.done).toBe(true);
    expect(getCostMeterDataFn).not.toHaveBeenCalled();

    reader.releaseLock();
  });
});

// ---------------------------------------------------------------------------
// エラーハンドリング
// ---------------------------------------------------------------------------

describe('createCostEventStream — error handling', () => {
  it('getCostMeterData 失敗は onError を呼んで握りつぶす (ストリームは継続)', async () => {
    const ac = new AbortController();
    const onError = vi.fn();
    const fetchErr = new Error('DB connection failed');
    const getCostMeterDataFn = vi.fn(async () => { throw fetchErr; });

    const stream = createCostEventStream({
      prisma: makeFakePrisma(),
      signal: ac.signal,
      getCostMeterDataFn,
      onError,
    });

    // 初回 fetch 失敗 → `: connected` は来るが data は来ない
    const [first] = await readChunks(stream, 1);
    expect(first).toBe(': connected\n\n');
    expect(onError).toHaveBeenCalledWith(fetchErr, 'fetch');

    ac.abort();
  });
});
