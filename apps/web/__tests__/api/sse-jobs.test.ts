/**
 * /api/sse/jobs SSE Route + sse-jobs-core のユニットテスト (T-03-11, docs/05 §1.4 / §4.2.1).
 *
 * 検証:
 *   1. createJobsEventStream
 *      - pg.Client.connect → LISTEN jobs が呼ばれる
 *      - 接続直後に `: connected\n\n` SSE コメントが流れる
 *      - heartbeat interval が呼ばれる
 *      - notification を受け取ると `data: <payload>\n\n` で流れる
 *      - request.signal.abort で interval clear / pg.end / controller.close
 *      - connect 失敗時は error フレーム送信後 close
 *      - bookIdFilter 動作 (フィルタなし全通過 / 一致のみ通過 / parse 失敗は素通し)
 *   2. JOB_NOTIFY_CHANNEL / HEARTBEAT_INTERVAL_MS の不変条件 (docs/05 ADR-001)
 *
 * Route Handler 本体 (route.ts) は pg.Client 生成と auth() を含むため統合層.
 * 純粋ロジックは core で網羅し、ここでは fake pg client を差し込んで検証する.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEARTBEAT_INTERVAL_MS,
  JOB_NOTIFY_CHANNEL,
  createJobsEventStream,
  type JobsSsePgClient,
} from '../../lib/sse-jobs-core';

// ---------------------------------------------------------------------------
// テスト用 fake pg.Client
// ---------------------------------------------------------------------------

interface FakePg {
  client: JobsSsePgClient;
  connectCalls: number;
  queries: string[];
  endCalls: number;
  emit: (payload: string) => void;
  failConnect?: Error;
  failListen?: Error;
}

function makeFakePg(opts: { failConnect?: Error; failListen?: Error } = {}): FakePg {
  const state = {
    connectCalls: 0,
    queries: [] as string[],
    endCalls: 0,
    handlers: [] as Array<(msg: { channel?: string; payload?: string }) => void>,
  };
  const client: JobsSsePgClient = {
    connect: async () => {
      state.connectCalls += 1;
      if (opts.failConnect) throw opts.failConnect;
    },
    query: async (sql: string) => {
      state.queries.push(sql);
      if (opts.failListen && sql.startsWith('LISTEN')) throw opts.failListen;
      return {};
    },
    end: async () => {
      state.endCalls += 1;
    },
    on: (_event, handler) => {
      state.handlers.push(handler);
    },
    off: (_event, handler) => {
      state.handlers = state.handlers.filter((h) => h !== handler);
    },
  };
  return {
    client,
    get connectCalls() {
      return state.connectCalls;
    },
    get queries() {
      return state.queries;
    },
    get endCalls() {
      return state.endCalls;
    },
    emit: (payload: string) => {
      for (const h of state.handlers) {
        h({ channel: JOB_NOTIFY_CHANNEL, payload });
      }
    },
  };
}

/** ReadableStream<Uint8Array> から N 個の chunk を取り出して文字列結合する. */
async function readChunks(
  stream: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs = 1000,
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
// テスト本体
// ---------------------------------------------------------------------------

describe('sse-jobs-core constants', () => {
  it('JOB_NOTIFY_CHANNEL は docs/05 §1.4 / ADR-001 と整合 (jobs)', () => {
    expect(JOB_NOTIFY_CHANNEL).toBe('jobs');
  });

  it('HEARTBEAT_INTERVAL_MS は 30 秒 (docs/05 §1.4)', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });
});

describe('createJobsEventStream — happy path', () => {
  it('connect → LISTEN jobs → ": connected" frame を最初に送る', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
    });

    const [first] = await readChunks(stream, 1);
    expect(fake.connectCalls).toBe(1);
    expect(fake.queries).toEqual(['LISTEN jobs']);
    expect(first).toBe(': connected\n\n');

    ac.abort();
  });

  it('notification を受信したら "data: <payload>\\n\\n" 形式で流れる', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // 接続コメントを消費
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(': connected\n\n');

    // notify を発火
    const payload = JSON.stringify({
      jobId: 'job_1',
      status: 'done',
      kind: 'pipeline.book.kickoff',
      updated_at: '2026-05-23T00:00:00.000Z',
    });
    fake.emit(payload);

    const next = await reader.read();
    expect(decoder.decode(next.value)).toBe(`data: ${payload}\n\n`);

    reader.releaseLock();
    ac.abort();
  });

  it('空 payload や undefined は無視する', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected\n\n"

    // 空 payload は enqueue されない
    fake.emit('');

    // 直後に正常 payload を流す → これだけ届く
    const valid = JSON.stringify({ jobId: 'j', status: 'running', kind: 'pipeline.book.kickoff' });
    fake.emit(valid);

    const next = await reader.read();
    expect(decoder.decode(next.value)).toBe(`data: ${valid}\n\n`);

    reader.releaseLock();
    ac.abort();
  });
});

// ---------------------------------------------------------------------------
// bookId フィルタ (docs/05 §4.2 line 1008)
// ---------------------------------------------------------------------------

describe('createJobsEventStream — bookIdFilter', () => {
  it('フィルタ未指定 (undefined) なら全 notification を素通しする', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      // bookIdFilter: 指定なし
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    const a = JSON.stringify({ jobId: 'j1', status: 'done', kind: 'k', bookId: 'A' });
    const b = JSON.stringify({ jobId: 'j2', status: 'done', kind: 'k', bookId: 'B' });
    fake.emit(a);
    fake.emit(b);

    const r1 = await reader.read();
    expect(decoder.decode(r1.value)).toBe(`data: ${a}\n\n`);
    const r2 = await reader.read();
    expect(decoder.decode(r2.value)).toBe(`data: ${b}\n\n`);

    reader.releaseLock();
    ac.abort();
  });

  it('フィルタ指定あり: payload.bookId === filter のみ通過し、それ以外は skip', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      bookIdFilter: 'book_A',
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    const okPayload = JSON.stringify({
      jobId: 'j1',
      status: 'done',
      kind: 'pipeline.book.kickoff',
      bookId: 'book_A',
    });
    const skipPayload = JSON.stringify({
      jobId: 'j2',
      status: 'done',
      kind: 'pipeline.book.kickoff',
      bookId: 'book_B',
    });

    // 1. 他 book → skip されるべき (次の read は okPayload になる).
    // 2. 該当 book → 通過.
    fake.emit(skipPayload);
    fake.emit(okPayload);

    const next = await reader.read();
    expect(decoder.decode(next.value)).toBe(`data: ${okPayload}\n\n`);

    reader.releaseLock();
    ac.abort();
  });

  it('フィルタ指定あり + payload JSON parse 不能 → 素通し (fail-safe) で warn ログを onError に通知', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const onError = vi.fn();
    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      bookIdFilter: 'book_A',
      onError,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    const broken = 'not a json {{{';
    fake.emit(broken);

    const next = await reader.read();
    // 素通し: SSE には raw payload がそのまま流れる
    expect(decoder.decode(next.value)).toBe(`data: ${broken}\n\n`);
    // onError は notification context で 1 回呼ばれる
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'notification');

    reader.releaseLock();
    ac.abort();
  });
});

describe('createJobsEventStream — heartbeat (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('heartbeatMs ごとに ": heartbeat\\n\\n" が流れる', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      heartbeatMs: 1000,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // 接続コメントを消費 (microtask は通常 promise で進む)
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(': connected\n\n');

    // 1 秒進める → heartbeat 1 件
    vi.advanceTimersByTime(1000);
    const hb1 = await reader.read();
    expect(decoder.decode(hb1.value)).toBe(': heartbeat\n\n');

    // さらに 1 秒進めると 2 つ目
    vi.advanceTimersByTime(1000);
    const hb2 = await reader.read();
    expect(decoder.decode(hb2.value)).toBe(': heartbeat\n\n');

    reader.releaseLock();
    ac.abort();
  });

  it('abort 後は heartbeat も notification も流れず、pg.end が呼ばれる', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      heartbeatMs: 1000,
    });

    const reader = stream.getReader();
    await reader.read(); // ": connected"

    ac.abort();

    // cleanup は async. microtask を一巡させる.
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.endCalls).toBeGreaterThanOrEqual(1);

    // abort 後の read は done になる
    const r = await reader.read();
    expect(r.done).toBe(true);

    reader.releaseLock();
  });
});

describe('createJobsEventStream — error handling', () => {
  it('connect 失敗時は error フレームを送って close する', async () => {
    const fake = makeFakePg({ failConnect: new Error('ECONNREFUSED') });
    const ac = new AbortController();
    const onError = vi.fn();

    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      onError,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('event: error');
    expect(decoder.decode(first.value)).toContain('pg connection failed');

    // 後続 read は done
    const done = await reader.read();
    expect(done.done).toBe(true);

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'connect');
    expect(fake.endCalls).toBeGreaterThanOrEqual(1);

    reader.releaseLock();
  });

  it('LISTEN 失敗時も error フレームを送って close する', async () => {
    const fake = makeFakePg({ failListen: new Error('relation does not exist') });
    const ac = new AbortController();
    const onError = vi.fn();

    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      onError,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('event: error');
    expect(decoder.decode(first.value)).toContain('listen failed');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'listen');

    reader.releaseLock();
  });

  it('start 時点で既に aborted なら接続せず cleanup する', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    ac.abort();

    const stream = createJobsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
    });

    const reader = stream.getReader();
    const r = await reader.read();
    expect(r.done).toBe(true);

    // 既に aborted なら connect は呼ばれない
    expect(fake.connectCalls).toBe(0);
    // ただし pg.end は cleanup で呼ぶ (冪等な end 呼出を期待)
    expect(fake.endCalls).toBeGreaterThanOrEqual(1);

    reader.releaseLock();
  });
});
