import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `@a2p/db` (Prisma) を引かないようモック化 — テストでは deps 経由で repo を差し替える。
vi.mock('@a2p/db', () => ({
  prisma: {
    tokenUsage: { create: vi.fn() },
    book: { update: vi.fn() },
    modelCatalog: { findFirst: vi.fn() },
  },
}));

import type {
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
} from '@a2p/contracts/agents';

import {
  withTokenLogging,
  computeCostJpy,
  type LoggingContext,
} from '../src/lib/with-token-logging.js';

// ---------------------------------------------------------------------------
// computeCostJpy — 単価スナップショットからの実コスト計算 (¥0 バグ回帰防止)
// ---------------------------------------------------------------------------

describe('computeCostJpy', () => {
  const snap = {
    input_price_per_mtok_usd: 5,
    output_price_per_mtok_usd: 25,
    image_price_per_image_usd: null,
    fx_rate_usd_jpy: 160,
  };

  it('input/output トークンから USD→JPY を計算する', () => {
    // (1_000_000/1e6*5 + 1_000_000/1e6*25) USD = 30 USD × 160 = 4800 JPY
    const cost = computeCostJpy(snap, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(4800, 5);
  });

  it('cached input は入力単価の約 1/10 で加算', () => {
    const cost = computeCostJpy(snap, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 });
    // 1_000_000/1e6 * 5 * 0.1 = 0.5 USD × 160 = 80 JPY
    expect(cost).toBeCloseTo(80, 5);
  });

  it('画像単価がある場合は image_count で課金', () => {
    const cost = computeCostJpy(
      { image_price_per_image_usd: 0.04, fx_rate_usd_jpy: 160 },
      { imageCount: 3 },
    );
    expect(cost).toBeCloseTo(0.04 * 3 * 160, 5);
  });

  it('スナップショット欠損 / fx 不正なら 0', () => {
    expect(computeCostJpy(null, { inputTokens: 100 })).toBe(0);
    expect(computeCostJpy({}, { inputTokens: 100 })).toBe(0);
    expect(computeCostJpy({ fx_rate_usd_jpy: 0, input_price_per_mtok_usd: 5 }, { inputTokens: 1e6 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseResult(
  overrides: Partial<LLMCompleteResult<string>> = {},
): LLMCompleteResult<string> {
  return {
    text: 'hi',
    usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 },
    costJpy: 0.5,
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    ...overrides,
  };
}

function makeFakeClient(
  result: LLMCompleteResult<string> | (() => Promise<LLMCompleteResult<string>>),
): LLMClient {
  return {
    async complete<T = string>(
      _args: LLMCompleteArgs,
    ): Promise<LLMCompleteResult<T>> {
      const r = typeof result === 'function' ? await result() : result;
      return r as LLMCompleteResult<T>;
    },
    async *stream(): AsyncIterable<{ delta: string }> {
      yield { delta: '' };
    },
  };
}

function makeArgs(): LLMCompleteArgs {
  return {
    role: 'writer',
    genre: 'practical',
    messages: [{ role: 'user', content: 'hi' }],
  };
}

interface InMemoryPrisma {
  tokenUsage: { create: ReturnType<typeof vi.fn>; rows: unknown[] };
  book: {
    update: ReturnType<typeof vi.fn>;
    state: Map<string, number>;
  };
  modelCatalog?: { findFirst: ReturnType<typeof vi.fn> };
}

function makeInMemoryPrisma(opts: { books?: Record<string, number> } = {}): InMemoryPrisma {
  const rows: unknown[] = [];
  const tokenUsage = {
    rows,
    create: vi.fn(async ({ data }: { data: unknown }) => {
      rows.push(data);
      return data;
    }),
  };
  const state = new Map<string, number>(Object.entries(opts.books ?? {}));
  const book = {
    state,
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { cost_jpy_total: { increment: number } };
      }) => {
        const current = state.get(where.id) ?? 0;
        const next = current + data.cost_jpy_total.increment;
        state.set(where.id, next);
        return { cost_jpy_total: next };
      },
    ),
  };
  return { tokenUsage, book };
}

function ctx(overrides: Partial<LoggingContext> = {}): LoggingContext {
  return { role: 'writer', ...overrides };
}

const silentLogger = { warn: vi.fn() };

beforeEach(() => {
  silentLogger.warn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

describe('withTokenLogging — 1 complete = 1 token_usage INSERT', () => {
  it('完了後に token_usage が 1 行 INSERT され、ctx と result の値が混ざる', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'book-1': 0 } });
    const client = makeFakeClient(makeBaseResult({ costJpy: 1.25 }));
    const wrapped = withTokenLogging(
      client,
      ctx({ bookId: 'book-1', jobId: 'job-1', role: 'editor' }),
      {
        prisma,
        logger: silentLogger,
        fetchPriceSnapshot: async () => ({ stub: true }),
      },
    );

    const result = await wrapped.complete(makeArgs());

    expect(result.text).toBe('hi');
    expect(prisma.tokenUsage.create).toHaveBeenCalledTimes(1);
    const inserted = prisma.tokenUsage.create.mock.calls[0]![0]!.data;
    expect(inserted).toMatchObject({
      book_id: 'book-1',
      job_id: 'job-1',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      role: 'editor',
      input_tokens: 10,
      output_tokens: 20,
      cached_input_tokens: 0,
      image_count: 0,
      cost_jpy: 1.25,
      unit_price_snapshot: { stub: true },
    });
  });

  it('themeSessionId のみ指定でも記録される (bookId 無し → updateBookCost スキップ)', async () => {
    const prisma = makeInMemoryPrisma();
    const client = makeFakeClient(makeBaseResult({ costJpy: 0.1 }));
    const wrapped = withTokenLogging(
      client,
      ctx({ themeSessionId: 'ts-1', role: 'marketer' }),
      { prisma, logger: silentLogger, fetchPriceSnapshot: async () => ({}) },
    );

    await wrapped.complete(makeArgs());

    expect(prisma.tokenUsage.create).toHaveBeenCalledTimes(1);
    const inserted = prisma.tokenUsage.create.mock.calls[0]![0]!.data;
    expect(inserted.theme_session_id).toBe('ts-1');
    expect(inserted.book_id).toBeNull();
    expect(prisma.book.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. atomic updateBookCost
// ---------------------------------------------------------------------------

describe('withTokenLogging — Book.cost_jpy_total atomic increment', () => {
  it('1 回 complete で Book.cost_jpy_total に costJpy 加算', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'book-1': 10 } });
    const client = makeFakeClient(makeBaseResult({ costJpy: 2.5 }));
    const wrapped = withTokenLogging(client, ctx({ bookId: 'book-1' }), {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({}),
    });

    await wrapped.complete(makeArgs());

    expect(prisma.book.update).toHaveBeenCalledTimes(1);
    const call = prisma.book.update.mock.calls[0]![0]!;
    expect(call.where).toEqual({ id: 'book-1' });
    expect(call.data).toEqual({ cost_jpy_total: { increment: 2.5 } });
    expect(prisma.book.state.get('book-1')).toBeCloseTo(12.5);
  });

  it('並列 5 complete で 5 行 INSERT + cost_jpy_total が正確に sum される', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'book-X': 0 } });
    const client = makeFakeClient(async () =>
      makeBaseResult({ costJpy: 0.7 }),
    );
    const wrapped = withTokenLogging(client, ctx({ bookId: 'book-X' }), {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({}),
    });

    await Promise.all(
      Array.from({ length: 5 }, () => wrapped.complete(makeArgs())),
    );

    expect(prisma.tokenUsage.create).toHaveBeenCalledTimes(5);
    expect(prisma.book.update).toHaveBeenCalledTimes(5);
    // 0.7 * 5 = 3.5 — floating point の累積誤差を許容
    expect(prisma.book.state.get('book-X')).toBeCloseTo(3.5);
  });
});

// ---------------------------------------------------------------------------
// 3. complete エラー時は token_usage を残さず rethrow
// ---------------------------------------------------------------------------

describe('withTokenLogging — complete エラー時の挙動', () => {
  it('複数 await を経た rejection でも token_usage は INSERT されず例外がそのまま伝播', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'b': 0 } });
    const boom = new Error('LLM 5xx');
    const client: LLMClient = {
      async complete() {
        throw boom;
      },
      async *stream() {
        yield { delta: '' };
      },
    };
    const wrapped = withTokenLogging(client, ctx({ bookId: 'b' }), {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({}),
    });

    await expect(wrapped.complete(makeArgs())).rejects.toBe(boom);
    expect(prisma.tokenUsage.create).not.toHaveBeenCalled();
    expect(prisma.book.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. INSERT 失敗時は warn ログで握りつぶし、呼出元に正常結果返却
// ---------------------------------------------------------------------------

describe('withTokenLogging — INSERT 失敗時の運用継続', () => {
  it('tokenUsage.create が throw しても complete の結果はそのまま返る', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'b': 0 } });
    prisma.tokenUsage.create.mockImplementationOnce(async () => {
      throw new Error('DB down');
    });
    const client = makeFakeClient(makeBaseResult({ costJpy: 0.5 }));
    const wrapped = withTokenLogging(client, ctx({ bookId: 'b' }), {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({}),
    });

    const r = await wrapped.complete(makeArgs());
    expect(r.text).toBe('hi');
    expect(silentLogger.warn).toHaveBeenCalled();
    const warnPayload = silentLogger.warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(warnPayload).toMatchObject({ role: 'writer', bookId: 'b' });
    // INSERT 失敗時も Book 加算は試みる (どちらも独立な観点で「ベストエフォート」)
    expect(prisma.book.update).toHaveBeenCalledTimes(1);
  });

  it('book.update が throw しても complete の結果はそのまま返る', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'b': 0 } });
    prisma.book.update.mockImplementationOnce(async () => {
      throw new Error('book not found');
    });
    const client = makeFakeClient(makeBaseResult({ costJpy: 0.5 }));
    const wrapped = withTokenLogging(client, ctx({ bookId: 'b' }), {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({}),
    });

    const r = await wrapped.complete(makeArgs());
    expect(r.text).toBe('hi');
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. bookId 無し → updateBookCost スキップ
// ---------------------------------------------------------------------------

describe('withTokenLogging — system タスク (bookId 無し)', () => {
  it('bookId が無ければ updateBookCost は呼ばれない', async () => {
    const prisma = makeInMemoryPrisma();
    const client = makeFakeClient(makeBaseResult({ costJpy: 0.5 }));
    const wrapped = withTokenLogging(client, ctx({}), {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({}),
    });

    await wrapped.complete(makeArgs());

    expect(prisma.tokenUsage.create).toHaveBeenCalledTimes(1);
    expect(prisma.book.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Proxy passes through non-complete props
// ---------------------------------------------------------------------------

describe('withTokenLogging — Proxy 透過性', () => {
  it('complete 以外のプロパティはそのまま参照できる', () => {
    const client = makeFakeClient(makeBaseResult());
    // 任意プロパティを付与してアクセス可能か検証
    (client as unknown as { foo: string }).foo = 'bar';
    const wrapped = withTokenLogging(
      client,
      ctx({}),
      { prisma: makeInMemoryPrisma(), logger: silentLogger, fetchPriceSnapshot: async () => ({}) },
    );
    expect((wrapped as unknown as { foo: string }).foo).toBe('bar');
  });
});
