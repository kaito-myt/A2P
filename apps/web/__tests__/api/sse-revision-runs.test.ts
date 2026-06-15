/**
 * /api/sse/revision-runs/[id] SSE core unit test (T-06-10, docs/05 ss1.4).
 *
 * Mirrors sse-jobs.test.ts pattern. Validates:
 *   1. createRevisionRunsEventStream
 *      - pg connect -> LISTEN revision_runs_progress
 *      - `: connected\n\n` on start
 *      - heartbeat at interval
 *      - runId filter: only matching run's events pass
 *      - terminal status payload -> `event: done\ndata: ...\n\n` then close
 *      - connect/listen failure -> error frame
 *      - pre-aborted signal -> immediate cleanup
 *   2. REVISION_RUNS_NOTIFY_CHANNEL constant
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEARTBEAT_INTERVAL_MS,
  REVISION_RUNS_NOTIFY_CHANNEL,
  createRevisionRunsEventStream,
  type RevisionRunsSsePgClient,
} from '../../lib/sse-revision-runs-core';

// ---------------------------------------------------------------------------
// Fake pg.Client
// ---------------------------------------------------------------------------

interface FakePg {
  client: RevisionRunsSsePgClient;
  connectCalls: number;
  queries: string[];
  endCalls: number;
  emit: (payload: string) => void;
}

function makeFakePg(opts: { failConnect?: Error; failListen?: Error } = {}): FakePg {
  const state = {
    connectCalls: 0,
    queries: [] as string[],
    endCalls: 0,
    handlers: [] as Array<(msg: { channel?: string; payload?: string }) => void>,
  };
  const client: RevisionRunsSsePgClient = {
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
    get connectCalls() { return state.connectCalls; },
    get queries() { return state.queries; },
    get endCalls() { return state.endCalls; },
    emit: (payload: string) => {
      for (const h of state.handlers) {
        h({ channel: REVISION_RUNS_NOTIFY_CHANNEL, payload });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('sse-revision-runs-core constants', () => {
  it('REVISION_RUNS_NOTIFY_CHANNEL is revision_runs_progress', () => {
    expect(REVISION_RUNS_NOTIFY_CHANNEL).toBe('revision_runs_progress');
  });

  it('HEARTBEAT_INTERVAL_MS is 30s', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('createRevisionRunsEventStream — happy path', () => {
  it('connect -> LISTEN revision_runs_progress -> ": connected" frame', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(fake.connectCalls).toBe(1);
    expect(fake.queries).toEqual(['LISTEN revision_runs_progress']);
    expect(decoder.decode(first.value)).toBe(': connected\n\n');

    reader.releaseLock();
    ac.abort();
  });

  it('notification with matching runId flows as data frame', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    const payload = JSON.stringify({
      runId: 'run_1',
      bookId: 'book_A',
      commentId: 'c1',
      applied: 1,
      not_applicable: 0,
      total: 3,
    });
    fake.emit(payload);

    const next = await reader.read();
    expect(decoder.decode(next.value)).toBe(`data: ${payload}\n\n`);

    reader.releaseLock();
    ac.abort();
  });
});

// ---------------------------------------------------------------------------
// runId filter
// ---------------------------------------------------------------------------

describe('createRevisionRunsEventStream — runId filter', () => {
  it('skips notifications for other runIds', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    const otherRun = JSON.stringify({ runId: 'run_2', applied: 1, total: 2 });
    const matchRun = JSON.stringify({ runId: 'run_1', applied: 2, total: 3 });
    fake.emit(otherRun);
    fake.emit(matchRun);

    const next = await reader.read();
    expect(decoder.decode(next.value)).toBe(`data: ${matchRun}\n\n`);

    reader.releaseLock();
    ac.abort();
  });

  it('drops non-JSON payloads with onError notification', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const onError = vi.fn();
    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
      onError,
    });

    const reader = stream.getReader();
    await reader.read(); // ": connected"

    fake.emit('not json {{');

    // Should not enqueue anything. Send a valid one after to verify.
    const valid = JSON.stringify({ runId: 'run_1', applied: 1, total: 2 });
    fake.emit(valid);

    const decoder = new TextDecoder();
    const next = await reader.read();
    expect(decoder.decode(next.value)).toBe(`data: ${valid}\n\n`);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'notification');

    reader.releaseLock();
    ac.abort();
  });
});

// ---------------------------------------------------------------------------
// Terminal status -> event: done
// ---------------------------------------------------------------------------

describe('createRevisionRunsEventStream — terminal status', () => {
  it('status=done sends event: done frame and closes stream', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    const donePayload = JSON.stringify({
      runId: 'run_1',
      status: 'done',
      applied: 3,
      total: 3,
    });
    fake.emit(donePayload);

    const doneFrame = await reader.read();
    expect(decoder.decode(doneFrame.value)).toBe(`event: done\ndata: ${donePayload}\n\n`);

    // Stream should be closed
    const end = await reader.read();
    expect(end.done).toBe(true);

    expect(fake.endCalls).toBeGreaterThanOrEqual(1);

    reader.releaseLock();
  });

  it('status=partial also triggers event: done', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    const partialPayload = JSON.stringify({
      runId: 'run_1',
      status: 'partial',
      applied: 2,
      not_applicable: 1,
      total: 3,
    });
    fake.emit(partialPayload);

    const frame = await reader.read();
    expect(decoder.decode(frame.value)).toBe(`event: done\ndata: ${partialPayload}\n\n`);

    const end = await reader.read();
    expect(end.done).toBe(true);

    reader.releaseLock();
  });

  it('status=failed also triggers event: done', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    const failedPayload = JSON.stringify({
      runId: 'run_1',
      status: 'failed',
      applied: 0,
      total: 3,
    });
    fake.emit(failedPayload);

    const frame = await reader.read();
    expect(decoder.decode(frame.value)).toBe(`event: done\ndata: ${failedPayload}\n\n`);

    const end = await reader.read();
    expect(end.done).toBe(true);

    reader.releaseLock();
  });
});

// ---------------------------------------------------------------------------
// Heartbeat (fake timers)
// ---------------------------------------------------------------------------

describe('createRevisionRunsEventStream — heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends heartbeat at interval', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
      heartbeatMs: 1000,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    vi.advanceTimersByTime(1000);
    const hb = await reader.read();
    expect(decoder.decode(hb.value)).toBe(': heartbeat\n\n');

    reader.releaseLock();
    ac.abort();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('createRevisionRunsEventStream — error handling', () => {
  it('connect failure sends error frame and closes', async () => {
    const fake = makeFakePg({ failConnect: new Error('ECONNREFUSED') });
    const ac = new AbortController();
    const onError = vi.fn();

    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
      onError,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('event: error');
    expect(decoder.decode(first.value)).toContain('pg connection failed');

    const done = await reader.read();
    expect(done.done).toBe(true);

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'connect');
    expect(fake.endCalls).toBeGreaterThanOrEqual(1);

    reader.releaseLock();
  });

  it('LISTEN failure sends error frame and closes', async () => {
    const fake = makeFakePg({ failListen: new Error('relation does not exist') });
    const ac = new AbortController();
    const onError = vi.fn();

    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
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

  it('pre-aborted signal skips connect and cleans up', async () => {
    const fake = makeFakePg();
    const ac = new AbortController();
    ac.abort();

    const stream = createRevisionRunsEventStream({
      pgClient: fake.client,
      signal: ac.signal,
      runIdFilter: 'run_1',
    });

    const reader = stream.getReader();
    const r = await reader.read();
    expect(r.done).toBe(true);
    expect(fake.connectCalls).toBe(0);
    expect(fake.endCalls).toBeGreaterThanOrEqual(1);

    reader.releaseLock();
  });
});
