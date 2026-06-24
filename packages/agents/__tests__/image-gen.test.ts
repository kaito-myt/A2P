import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError, ProviderError } from '@a2p/contracts/errors';

// p-retry の backoff をテスト時間 0 に
vi.mock('p-retry', async () => {
  const actual = await vi.importActual<typeof import('p-retry')>('p-retry');
  return {
    ...actual,
    default: (
      fn: (attempt: number) => Promise<unknown>,
      opts: { retries?: number } = {},
    ) => actual.default(fn, { ...opts, minTimeout: 0, maxTimeout: 0, factor: 1 }),
  };
});

// `@a2p/db` は本テストでは参照しないが、tools 側が getApiKey 経由で
// import するため事前にモック化しておく (実 DB に触れさせない)。
vi.mock('@a2p/db', () => ({
  prisma: {
    apiCredential: { findUnique: vi.fn(async () => null) },
    tokenUsage: { create: vi.fn() },
    book: { update: vi.fn() },
    modelCatalog: { findFirst: vi.fn() },
  },
}));
vi.mock('@a2p/crypto', () => ({
  decryptApiKey: vi.fn((enc: string) => `dec(${enc})`),
}));

import {
  generateImage,
  type GenerateImageArgs,
  type GenerateImageResult,
  type ImageGenDeps,
  type OpenAIImagesClient,
} from '../src/tools/image-gen.js';
import { withImageLogging } from '../src/lib/with-image-logging.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** base64 で 'PNG' に展開される dummy バイト列。 */
function dummyB64(label: string): string {
  return Buffer.from(`png-${label}`, 'utf-8').toString('base64');
}

function makeStubOpenAI(opts: {
  responseQueue?: Array<{ data: Array<{ b64_json: string }> }>;
  errors?: Array<unknown>;
  capture?: Array<Record<string, unknown>>;
} = {}): { client: OpenAIImagesClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = opts.capture ?? [];
  const queue = [...(opts.responseQueue ?? [])];
  const errs = [...(opts.errors ?? [])];

  const client: OpenAIImagesClient = {
    images: {
      generate: vi.fn(async (args: Record<string, unknown>) => {
        calls.push(args);
        if (errs.length > 0) {
          const e = errs.shift();
          if (e !== undefined) throw e;
        }
        const next = queue.shift();
        if (!next) throw new Error('test: no more responses queued');
        return next;
      }),
    },
  };
  return { client, calls };
}

function deps(stub: OpenAIImagesClient, apiKey = 'sk-test'): ImageGenDeps {
  return {
    getApiKey: async () => apiKey,
    openaiFactory: () => stub,
  };
}

const baseArgs = (overrides: Partial<GenerateImageArgs> = {}): GenerateImageArgs => ({
  prompt: 'a beautiful sunset over mountains',
  width: 1024,
  height: 1024,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// generateImage — input validation
// ===========================================================================

describe('generateImage — 入力検証', () => {
  it('prompt が空文字なら ConfigError', async () => {
    await expect(
      generateImage({ prompt: '', width: 1024, height: 1024 }, deps(makeStubOpenAI().client)),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('count が 0 以下なら ConfigError', async () => {
    await expect(
      generateImage(baseArgs({ count: 0 }), deps(makeStubOpenAI().client)),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('width が 0 以下なら ConfigError', async () => {
    await expect(
      generateImage({ prompt: 'x', width: 0, height: 1024 }, deps(makeStubOpenAI().client)),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

// ===========================================================================
// generateImage — happy path
// ===========================================================================

describe('generateImage — 正常系', () => {
  it('1 枚生成 (count 既定) — images.length === 1, usage.imageCount === 1', async () => {
    const { client, calls } = makeStubOpenAI({
      responseQueue: [{ data: [{ b64_json: dummyB64('a') }] }],
    });
    const result = await generateImage(baseArgs(), deps(client));
    expect(result.images).toHaveLength(1);
    expect(result.usage.imageCount).toBe(1);
    expect(result.costJpy).toBe(0);
    expect(result.images[0]!.toString('utf-8')).toBe('png-a');

    // size 文字列 / model / n パラメタが正しく渡る
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: 'gpt-image-1',
      prompt: 'a beautiful sunset over mountains',
      size: '1024x1024',
      n: 1,
    });
  });

  it('count=3 で 3 枚生成', async () => {
    const { client, calls } = makeStubOpenAI({
      responseQueue: [
        {
          data: [
            { b64_json: dummyB64('1') },
            { b64_json: dummyB64('2') },
            { b64_json: dummyB64('3') },
          ],
        },
      ],
    });
    const result = await generateImage(baseArgs({ count: 3 }), deps(client));
    expect(result.images).toHaveLength(3);
    expect(result.usage.imageCount).toBe(3);
    expect(calls[0]!.n).toBe(3);
  });

  it('quality=high を渡せる', async () => {
    const { client, calls } = makeStubOpenAI({
      responseQueue: [{ data: [{ b64_json: dummyB64('q') }] }],
    });
    await generateImage(baseArgs({ quality: 'high' }), deps(client));
    expect(calls[0]!.quality).toBe('high');
  });
});

// ===========================================================================
// generateImage — retry behavior
// ===========================================================================

describe('generateImage — リトライポリシ', () => {
  it('429 (rate_limit) は最大 3 回試行で成功すれば返す', async () => {
    const { client } = makeStubOpenAI({
      errors: [
        Object.assign(new Error('rate limited'), { status: 429 }),
        Object.assign(new Error('rate limited'), { status: 429 }),
      ],
      responseQueue: [{ data: [{ b64_json: dummyB64('ok') }] }],
    });
    const result = await generateImage(baseArgs(), deps(client));
    expect(result.images).toHaveLength(1);
    expect(client.images.generate).toHaveBeenCalledTimes(3);
  });

  it('400 (client_error) は即時 ProviderError、リトライしない', async () => {
    const { client } = makeStubOpenAI({
      errors: [Object.assign(new Error('bad request'), { status: 400 })],
    });
    let caught: unknown;
    try {
      await generateImage(baseArgs(), deps(client));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(false);
    expect(client.images.generate).toHaveBeenCalledTimes(1);
  });

  it('500 系は 1 回だけリトライ → 2 回で諦めて ProviderError', async () => {
    const err = Object.assign(new Error('upstream blew up'), { status: 503 });
    const { client } = makeStubOpenAI({
      errors: [err, err, err],
    });
    let caught: unknown;
    try {
      await generateImage(baseArgs(), deps(client));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(client.images.generate).toHaveBeenCalledTimes(2);
  });

  it('b64_json が空なら ProviderError', async () => {
    const { client } = makeStubOpenAI({
      responseQueue: [{ data: [{ b64_json: '' }] }],
    });
    let caught: unknown;
    try {
      await generateImage(baseArgs(), deps(client));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
  });
});

// ===========================================================================
// withImageLogging — happy path
// ===========================================================================

interface InMemoryPrisma {
  tokenUsage: { create: ReturnType<typeof vi.fn>; rows: unknown[] };
  book: { update: ReturnType<typeof vi.fn>; state: Map<string, number> };
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

const silentLogger = { warn: vi.fn() };

beforeEach(() => {
  silentLogger.warn.mockReset();
});

describe('withImageLogging — 1 generateImage = 1 token_usage INSERT', () => {
  it('1 枚生成で token_usage 1 行 INSERT (image_count=1, role=thumbnail_image)', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'book-1': 0 } });
    const baseFn = vi.fn(
      async (): Promise<GenerateImageResult> => ({
        images: [Buffer.from('img1')],
        costJpy: 0,
        usage: { imageCount: 1 },
      }),
    );
    const wrapped = withImageLogging(
      baseFn,
      { bookId: 'book-1', jobId: 'job-1' },
      {
        prisma,
        logger: silentLogger,
        fetchPriceSnapshot: async () => ({
          snapshot: { image_price_per_image_usd: 0.04, fx_rate_usd_jpy: 150 },
          costJpy: 6.0,
        }),
      },
    );

    const result = await wrapped(baseArgs());

    expect(result.images).toHaveLength(1);
    expect(result.costJpy).toBeCloseTo(6.0);
    expect(prisma.tokenUsage.create).toHaveBeenCalledTimes(1);
    const inserted = prisma.tokenUsage.create.mock.calls[0]![0]!.data;
    expect(inserted).toMatchObject({
      book_id: 'book-1',
      job_id: 'job-1',
      provider: 'openai',
      model: 'gpt-image-1',
      role: 'thumbnail_image',
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      image_count: 1,
      cost_jpy: 6.0,
    });
    expect(inserted.unit_price_snapshot).toEqual({
      image_price_per_image_usd: 0.04,
      fx_rate_usd_jpy: 150,
    });
  });

  it('count=3 で token_usage 1 行 INSERT (image_count=3)', async () => {
    const prisma = makeInMemoryPrisma();
    const baseFn = vi.fn(
      async (): Promise<GenerateImageResult> => ({
        images: [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')],
        costJpy: 0,
        usage: { imageCount: 3 },
      }),
    );
    const wrapped = withImageLogging(
      baseFn,
      { themeSessionId: 'ts-1' },
      {
        prisma,
        logger: silentLogger,
        fetchPriceSnapshot: async (_p, _m, imageCount) => ({
          snapshot: { image_price_per_image_usd: 0.04, fx_rate_usd_jpy: 150 },
          costJpy: 0.04 * 150 * imageCount,
        }),
      },
    );

    await wrapped(baseArgs({ count: 3 }));

    expect(prisma.tokenUsage.create).toHaveBeenCalledTimes(1);
    const inserted = prisma.tokenUsage.create.mock.calls[0]![0]!.data;
    expect(inserted.image_count).toBe(3);
    expect(inserted.cost_jpy).toBeCloseTo(18.0);
    expect(inserted.theme_session_id).toBe('ts-1');
    expect(inserted.book_id).toBeNull();
    expect(prisma.book.update).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// withImageLogging — Book.cost_jpy_total atomic increment
// ===========================================================================

describe('withImageLogging — Book.cost_jpy_total 加算', () => {
  it('bookId 指定時に cost_jpy_total が加算される', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'b': 10 } });
    const baseFn = async (): Promise<GenerateImageResult> => ({
      images: [Buffer.from('x')],
      costJpy: 0,
      usage: { imageCount: 1 },
    });
    const wrapped = withImageLogging(baseFn, { bookId: 'b' }, {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({
        snapshot: {},
        costJpy: 2.5,
      }),
    });

    await wrapped(baseArgs());

    expect(prisma.book.update).toHaveBeenCalledTimes(1);
    expect(prisma.book.state.get('b')).toBeCloseTo(12.5);
  });

  it('bookId 無し → updateBookCost スキップ', async () => {
    const prisma = makeInMemoryPrisma();
    const baseFn = async (): Promise<GenerateImageResult> => ({
      images: [Buffer.from('x')],
      costJpy: 0,
      usage: { imageCount: 1 },
    });
    const wrapped = withImageLogging(baseFn, {}, {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({ snapshot: {}, costJpy: 1.0 }),
    });

    await wrapped(baseArgs());

    expect(prisma.tokenUsage.create).toHaveBeenCalledTimes(1);
    expect(prisma.book.update).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// withImageLogging — error handling
// ===========================================================================

describe('withImageLogging — generateImage エラー時', () => {
  it('生成エラーは rethrow され token_usage は INSERT されない', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'b': 0 } });
    const boom = new Error('OpenAI 5xx');
    const baseFn = async (): Promise<GenerateImageResult> => {
      throw boom;
    };
    const wrapped = withImageLogging(baseFn, { bookId: 'b' }, {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({ snapshot: {}, costJpy: 1.0 }),
    });

    await expect(wrapped(baseArgs())).rejects.toBe(boom);
    expect(prisma.tokenUsage.create).not.toHaveBeenCalled();
    expect(prisma.book.update).not.toHaveBeenCalled();
  });
});

describe('withImageLogging — INSERT 失敗時の運用継続', () => {
  it('tokenUsage.create が throw しても 結果は返り、warn ログが出る', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'b': 0 } });
    prisma.tokenUsage.create.mockImplementationOnce(async () => {
      throw new Error('DB down');
    });
    const baseFn = async (): Promise<GenerateImageResult> => ({
      images: [Buffer.from('x')],
      costJpy: 0,
      usage: { imageCount: 1 },
    });
    const wrapped = withImageLogging(baseFn, { bookId: 'b' }, {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({ snapshot: {}, costJpy: 0.5 }),
    });

    const r = await wrapped(baseArgs());
    expect(r.images).toHaveLength(1);
    expect(silentLogger.warn).toHaveBeenCalled();
    const payload = silentLogger.warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({ role: 'thumbnail_image', bookId: 'b' });
    // INSERT 失敗時も Book 加算は試みる (どちらも独立な観点で「ベストエフォート」)
    expect(prisma.book.update).toHaveBeenCalledTimes(1);
  });

  it('book.update が throw しても 結果はそのまま返る', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'b': 0 } });
    prisma.book.update.mockImplementationOnce(async () => {
      throw new Error('book not found');
    });
    const baseFn = async (): Promise<GenerateImageResult> => ({
      images: [Buffer.from('x')],
      costJpy: 0,
      usage: { imageCount: 1 },
    });
    const wrapped = withImageLogging(baseFn, { bookId: 'b' }, {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({ snapshot: {}, costJpy: 0.5 }),
    });

    const r = await wrapped(baseArgs());
    expect(r.images).toHaveLength(1);
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});

describe('withImageLogging — snapshot 未取得時 (costJpy null)', () => {
  it('costJpy=0 で INSERT (snapshot={})', async () => {
    const prisma = makeInMemoryPrisma({ books: { 'b': 0 } });
    const baseFn = async (): Promise<GenerateImageResult> => ({
      images: [Buffer.from('x')],
      costJpy: 0,
      usage: { imageCount: 1 },
    });
    const wrapped = withImageLogging(baseFn, { bookId: 'b' }, {
      prisma,
      logger: silentLogger,
      fetchPriceSnapshot: async () => ({ snapshot: {}, costJpy: null }),
    });

    await wrapped(baseArgs());

    const inserted = prisma.tokenUsage.create.mock.calls[0]![0]!.data;
    expect(inserted.cost_jpy).toBe(0);
    expect(inserted.unit_price_snapshot).toEqual({});
    expect(prisma.book.state.get('b')).toBe(0);
  });
});
