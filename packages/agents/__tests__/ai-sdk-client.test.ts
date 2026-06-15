import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ProviderError } from '@a2p/contracts/errors';

// --- AI SDK モック ----------------------------------------------------------
//
// `generateText` / `generateObject` を mock し、provider factories
// (`createAnthropic` 等) は「与えた apiKey をキャプチャしつつ
// `(model) => modelTag` を返す関数」に差し替える。これにより:
//
//   - ai-sdk-client.ts の dispatch (provider 別 factory 選択)
//   - responseSchema 有無による generateText / generateObject 分岐
//   - 429/5xx/4xx に対する p-retry 挙動
//
// を実装非依存で検証できる。

const generateTextMock = vi.fn();
const generateObjectMock = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

const anthropicCalls: Array<{ apiKey: string; model: string }> = [];
const openaiCalls: Array<{ apiKey: string; model: string }> = [];
const googleCalls: Array<{ apiKey: string; model: string }> = [];

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: ({ apiKey }: { apiKey: string }) =>
    (model: string) => {
      anthropicCalls.push({ apiKey, model });
      return { __provider: 'anthropic', model };
    },
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: ({ apiKey }: { apiKey: string }) =>
    (model: string) => {
      openaiCalls.push({ apiKey, model });
      return { __provider: 'openai', model };
    },
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: ({ apiKey }: { apiKey: string }) =>
    (model: string) => {
      googleCalls.push({ apiKey, model });
      return { __provider: 'google', model };
    },
}));

// p-retry の backoff を握りつぶしてテスト時間を 0 に
vi.mock('p-retry', async () => {
  const actual = await vi.importActual<typeof import('p-retry')>('p-retry');
  return {
    ...actual,
    default: (
      fn: (attempt: number) => Promise<unknown>,
      opts: { retries?: number } = {},
    ) =>
      actual.default(fn, { ...opts, minTimeout: 0, maxTimeout: 0, factor: 1 }),
  };
});

// import 順: 上記 vi.mock より後に対象を読み込む
const { AISdkClient } = await import('../src/lib/ai-sdk-client.js');
import type { LLMCompleteArgs } from '../src/lib/llm-client.js';

const baseArgs = (overrides: Partial<LLMCompleteArgs> = {}): LLMCompleteArgs => ({
  role: 'writer',
  genre: 'practical',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
  ],
  ...overrides,
});

beforeEach(() => {
  generateTextMock.mockReset();
  generateObjectMock.mockReset();
  anthropicCalls.length = 0;
  openaiCalls.length = 0;
  googleCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AISdkClient constructor', () => {
  it('apiKey が空文字なら ConfigError', () => {
    expect(() => new AISdkClient({ provider: 'anthropic', model: 'm', apiKey: '' })).toThrow(
      /apiKey is required/,
    );
  });

  it('model が空文字なら ConfigError', () => {
    expect(() => new AISdkClient({ provider: 'anthropic', model: '', apiKey: 'k' })).toThrow(
      /model is required/,
    );
  });
});

describe('AISdkClient.complete — provider dispatch', () => {
  it('provider=anthropic → createAnthropic 経路で generateText', async () => {
    generateTextMock.mockResolvedValue({
      text: 'hi',
      usage: { inputTokens: 11, outputTokens: 22 },
    });
    const client = new AISdkClient({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk-ant-test',
    });
    const result = await client.complete(baseArgs());
    expect(anthropicCalls).toEqual([{ apiKey: 'sk-ant-test', model: 'claude-opus-4-7' }]);
    expect(openaiCalls).toEqual([]);
    expect(googleCalls).toEqual([]);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: 'hi',
      usage: { inputTokens: 11, outputTokens: 22 },
      costJpy: 0,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
  });

  it('provider=openai → createOpenAI 経路', async () => {
    generateTextMock.mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3 },
    });
    const client = new AISdkClient({
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-openai',
    });
    const result = await client.complete(baseArgs({ role: 'editor' }));
    expect(openaiCalls).toEqual([{ apiKey: 'sk-openai', model: 'gpt-5' }]);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-5');
    expect(result.usage.cachedInputTokens).toBe(3);
  });

  it('provider=google → createGoogleGenerativeAI 経路', async () => {
    generateTextMock.mockResolvedValue({
      text: 'g',
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    const client = new AISdkClient({
      provider: 'google',
      model: 'gemini-2.5-pro',
      apiKey: 'gkey',
    });
    const result = await client.complete(baseArgs({ role: 'judge' }));
    expect(googleCalls).toEqual([{ apiKey: 'gkey', model: 'gemini-2.5-pro' }]);
    expect(result.provider).toBe('google');
  });
});

describe('AISdkClient.complete — structured output', () => {
  it('responseSchema 指定時は generateObject が呼ばれ、object が text に詰まる', async () => {
    const schema = z.object({ ok: z.boolean(), n: z.number() });
    const expected = { ok: true, n: 42 };
    generateObjectMock.mockResolvedValue({
      object: expected,
      usage: { inputTokens: 7, outputTokens: 9 },
    });
    const client = new AISdkClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'k',
    });
    const result = await client.complete<typeof expected>(
      baseArgs({ responseSchema: schema }),
    );
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
    const callArg = generateObjectMock.mock.calls[0]![0] as { schema: unknown };
    expect(callArg.schema).toBe(schema);
    expect(result.text).toEqual(expected);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 9 });
    expect(result.costJpy).toBe(0);
  });
});

describe('AISdkClient.complete — system message handling', () => {
  it('system role の content は AI SDK の system パラメタに分離される', async () => {
    generateTextMock.mockResolvedValue({
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const client = new AISdkClient({ provider: 'openai', model: 'm', apiKey: 'k' });
    await client.complete({
      role: 'writer',
      genre: null,
      messages: [
        { role: 'system', content: 'S1' },
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A1' },
        { role: 'system', content: 'S2' },
      ],
    });
    const callArg = generateTextMock.mock.calls[0]![0] as {
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(callArg.system).toBe('S1\n\nS2');
    expect(callArg.messages).toEqual([
      { role: 'user', content: 'U1' },
      { role: 'assistant', content: 'A1' },
    ]);
  });
});

describe('AISdkClient.complete — tools pass-through', () => {
  it('args.tools は AI SDK の tools パラメタにマップされる', async () => {
    generateTextMock.mockResolvedValue({
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const client = new AISdkClient({ provider: 'openai', model: 'm', apiKey: 'k' });
    await client.complete(
      baseArgs({
        tools: [{ name: 'web_search', description: 'search the web' }],
      }),
    );
    const callArg = generateTextMock.mock.calls[0]![0] as {
      tools?: Record<string, { description?: string }>;
    };
    expect(callArg.tools).toBeDefined();
    expect(callArg.tools!.web_search!.description).toBe('search the web');
  });
});

describe('AISdkClient.complete — retry policy', () => {
  it('429 (rate_limit) は最大 3 回試行で成功すれば返す', async () => {
    generateTextMock
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
      .mockResolvedValueOnce({
        text: 'finally',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    const client = new AISdkClient({ provider: 'anthropic', model: 'm', apiKey: 'k' });
    const result = await client.complete(baseArgs());
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(result.text).toBe('finally');
  });

  it('429 が 3 回連続なら ProviderError(retryable=false)', async () => {
    const err = Object.assign(new Error('still 429'), { status: 429 });
    generateTextMock.mockRejectedValue(err);
    const client = new AISdkClient({ provider: 'anthropic', model: 'm', apiKey: 'k' });
    let caught: unknown;
    try {
      await client.complete(baseArgs());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(false);
    expect((caught as ProviderError).cause).toBeDefined();
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });

  it('400 (client_error) は即時 ProviderError、リトライしない', async () => {
    generateTextMock.mockRejectedValue(
      Object.assign(new Error('bad request'), { status: 400 }),
    );
    const client = new AISdkClient({ provider: 'openai', model: 'm', apiKey: 'k' });
    let caught: unknown;
    try {
      await client.complete(baseArgs());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(false);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('500 (server_error) は 1 回だけリトライ → 2 回で諦めて ProviderError', async () => {
    generateTextMock.mockRejectedValue(
      Object.assign(new Error('upstream blew up'), { status: 503 }),
    );
    const client = new AISdkClient({ provider: 'google', model: 'm', apiKey: 'k' });
    let caught: unknown;
    try {
      await client.complete(baseArgs());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('500 → 成功 のパターンは 2 回目で成功して返す', async () => {
    generateTextMock
      .mockRejectedValueOnce(Object.assign(new Error('500'), { status: 500 }))
      .mockResolvedValueOnce({
        text: 'recovered',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    const client = new AISdkClient({ provider: 'google', model: 'm', apiKey: 'k' });
    const result = await client.complete(baseArgs());
    expect(result.text).toBe('recovered');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('ProviderError の details に status/kind が含まれる', async () => {
    generateTextMock.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403 }),
    );
    const client = new AISdkClient({ provider: 'openai', model: 'm', apiKey: 'k' });
    let caught: ProviderError | undefined;
    try {
      await client.complete(baseArgs());
    } catch (e) {
      caught = e as ProviderError;
    }
    expect(caught?.details).toMatchObject({ status: 403, kind: 'client_error' });
  });
});

describe('AISdkClient.stream — 未実装', () => {
  it('stream() は ConfigError を throw する', async () => {
    const client = new AISdkClient({ provider: 'anthropic', model: 'm', apiKey: 'k' });
    const iter = client.stream(baseArgs());
    await expect((async () => {
      for await (const _ of iter) void _;
    })()).rejects.toThrow(/not implemented/);
  });
});

describe('AISdkClient.complete — Prompt Caching', () => {
  it('provider=anthropic + enablePromptCaching=true のとき generateText に system メッセージが messages 配列内で cacheControl 付きで渡される', async () => {
    generateTextMock.mockResolvedValue({
      text: 'cached',
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 8 },
    });
    const client = new AISdkClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant',
    });
    await client.complete(
      baseArgs({ enablePromptCaching: true }),
    );
    const callArg = generateTextMock.mock.calls[0]![0] as {
      system?: string;
      messages: Array<{ role: string; content: string; providerOptions?: unknown }>;
    };
    // system 文字列パラメタが渡されていないこと
    expect(callArg.system).toBeUndefined();
    // messages 配列に system role のエントリが含まれること
    const sysMsg = callArg.messages.find((m) => m.role === 'system');
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.content).toBe('sys');
    // cacheControl が anthropic providerOptions として付与されていること
    expect((sysMsg as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('provider=anthropic + enablePromptCaching=true のとき generateObject も messages 配列に cacheControl 付き system を渡す', async () => {
    const schema = { parse: (v: unknown) => v };
    generateObjectMock.mockResolvedValue({
      object: { ok: true },
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 7 },
    });
    const { z } = await import('zod');
    const zSchema = z.object({ ok: z.boolean() });
    const client = new AISdkClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant',
    });
    await client.complete(baseArgs({ enablePromptCaching: true, responseSchema: zSchema }));
    const callArg = generateObjectMock.mock.calls[0]![0] as {
      system?: string;
      messages: Array<{ role: string; content: string; providerOptions?: unknown }>;
    };
    expect(callArg.system).toBeUndefined();
    const sysMsg = callArg.messages.find((m) => m.role === 'system');
    expect(sysMsg).toBeDefined();
    expect((sysMsg as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('provider=openai + enablePromptCaching=true でも cacheControl は付与されない（system 文字列パラメタが使われる）', async () => {
    generateTextMock.mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    const client = new AISdkClient({
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-openai',
    });
    await client.complete(baseArgs({ enablePromptCaching: true }));
    const callArg = generateTextMock.mock.calls[0]![0] as {
      system?: string;
      messages: Array<{ role: string }>;
    };
    // openai では system 文字列が渡される（messages 内に system role はない）
    expect(callArg.system).toBe('sys');
    expect(callArg.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('provider=google + enablePromptCaching=true でも cacheControl は付与されない', async () => {
    generateTextMock.mockResolvedValue({
      text: 'g',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    const client = new AISdkClient({
      provider: 'google',
      model: 'gemini-2.5-pro',
      apiKey: 'gkey',
    });
    await client.complete(baseArgs({ enablePromptCaching: true }));
    const callArg = generateTextMock.mock.calls[0]![0] as {
      system?: string;
      messages: Array<{ role: string }>;
    };
    expect(callArg.system).toBe('sys');
    expect(callArg.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('enablePromptCaching 未指定では従来通り system 文字列パラメタが使われる', async () => {
    generateTextMock.mockResolvedValue({
      text: 'hi',
      usage: { inputTokens: 11, outputTokens: 22 },
    });
    const client = new AISdkClient({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk-ant',
    });
    await client.complete(baseArgs());
    const callArg = generateTextMock.mock.calls[0]![0] as {
      system?: string;
      messages: Array<{ role: string }>;
    };
    expect(callArg.system).toBe('sys');
    expect(callArg.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('cachedInputTokens が usage に含まれる場合は LLMCompleteResult に通過する', async () => {
    generateTextMock.mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 8 },
    });
    const client = new AISdkClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant',
    });
    const result = await client.complete(baseArgs({ enablePromptCaching: true }));
    expect(result.usage.cachedInputTokens).toBe(8);
  });
});
