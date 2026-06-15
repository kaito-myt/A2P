import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ConfigError, ProviderError } from '@a2p/contracts/errors';

// --- Anthropic SDK モック ----------------------------------------------------
//
// `@anthropic-ai/sdk` の default export は class Anthropic。
// テストでは `new Anthropic({ apiKey })` の挙動を再現しつつ、
// `messages.create()` を `vi.fn()` で握りつぶす。

const messagesCreateMock = vi.fn();
const anthropicConstructorCalls: Array<{ apiKey: string }> = [];

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public readonly messages: { create: typeof messagesCreateMock };
    constructor(opts: { apiKey: string }) {
      anthropicConstructorCalls.push({ apiKey: opts.apiKey });
      this.messages = { create: messagesCreateMock };
    }
  }
  return { default: FakeAnthropic };
});

// p-retry の backoff を 0 にしてテスト時間を潰す
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

// import 順: vi.mock より後に SUT を読む
const { AgentSdkClient, assertAnthropicProvider } = await import(
  '../src/lib/agent-sdk-client.js'
);
import type { LLMCompleteArgs } from '../src/lib/llm-client.js';

const baseArgs = (overrides: Partial<LLMCompleteArgs> = {}): LLMCompleteArgs => ({
  role: 'marketer',
  genre: 'practical',
  messages: [
    { role: 'system', content: 'you are a marketer' },
    { role: 'user', content: 'find me trending self-help topics' },
  ],
  ...overrides,
});

/** Anthropic Messages API の success response を組み立てるヘルパ。 */
function successResponse(opts: {
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreate?: number;
  extraContent?: Array<Record<string, unknown>>;
} = {}) {
  return {
    id: 'msg_test',
    type: 'message' as const,
    role: 'assistant' as const,
    model: 'claude-opus-4-7',
    stop_reason: 'end_turn' as const,
    stop_sequence: null,
    content: [
      ...(opts.extraContent ?? []),
      { type: 'text' as const, text: opts.text ?? 'hello' },
    ],
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 50,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation_input_tokens: opts.cacheCreate ?? 0,
    },
  };
}

/** Status 付きの Anthropic API エラーっぽい値を作る。 */
function apiError(status: number, message = 'boom'): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  messagesCreateMock.mockReset();
  anthropicConstructorCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentSdkClient constructor', () => {
  it('apiKey が空文字なら ConfigError', () => {
    expect(() => new AgentSdkClient({ model: 'claude-opus-4-7', apiKey: '' })).toThrow(
      /apiKey is required/,
    );
  });

  it('model が空文字なら ConfigError', () => {
    expect(() => new AgentSdkClient({ model: '', apiKey: 'sk-ant' })).toThrow(
      /model is required/,
    );
  });

  it('provider getter は anthropic 固定、model は constructor 値', () => {
    const c = new AgentSdkClient({ model: 'claude-opus-4-7', apiKey: 'sk-ant' });
    expect(c.provider).toBe('anthropic');
    expect(c.model).toBe('claude-opus-4-7');
  });
});

describe('AgentSdkClient.complete — happy path with web_search server tool', () => {
  it('Messages API 応答の text と usage を返し、cost_jpy=0 で provider/model を伴う', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      successResponse({
        text: 'found 3 trending topics',
        inputTokens: 1200,
        outputTokens: 480,
        cacheRead: 200,
        cacheCreate: 0,
        extraContent: [
          // server_tool_use と web_search_tool_result が text の前後に混ざるケース
          { type: 'server_tool_use', name: 'web_search', input: { query: 'self help' } },
          { type: 'web_search_tool_result', tool_use_id: 't1', content: [] },
        ],
      }),
    );

    const client = new AgentSdkClient({ model: 'claude-opus-4-7', apiKey: 'sk-ant-test' });
    const result = await client.complete(baseArgs());

    // Anthropic コンストラクタに apiKey が渡る (env 経由でも process.env 丸渡しでもない)
    expect(anthropicConstructorCalls).toEqual([{ apiKey: 'sk-ant-test' }]);

    // messages.create の引数検証
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    const callArg = messagesCreateMock.mock.calls[0]![0] as {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ type?: string; name: string }>;
    };
    expect(callArg.model).toBe('claude-opus-4-7');
    expect(callArg.max_tokens).toBe(4096); // DEFAULT_MAX_TOKENS
    expect(callArg.system).toBe('you are a marketer');
    expect(callArg.messages).toEqual([
      { role: 'user', content: 'find me trending self-help topics' },
    ]);
    // web_search server tool が常に含まれる
    expect(callArg.tools).toEqual(
      expect.arrayContaining([{ type: 'web_search_20250305', name: 'web_search' }]),
    );

    // 結果集計
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-opus-4-7');
    expect(result.text).toBe('found 3 trending topics');
    expect(result.usage.inputTokens).toBe(1200);
    expect(result.usage.outputTokens).toBe(480);
    expect(result.usage.cachedInputTokens).toBe(200); // cache_read + cache_creation
    expect(result.costJpy).toBe(0); // withTokenLogging が後段で計算
  });

  it('args.tools の追加ツールは web_search と並んで tools に積まれる', async () => {
    messagesCreateMock.mockResolvedValueOnce(successResponse());
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    await client.complete(
      baseArgs({
        tools: [{ name: 'custom_tool', description: 'do something', inputSchema: { type: 'object' } }],
      }),
    );
    const callArg = messagesCreateMock.mock.calls[0]![0] as {
      tools: Array<Record<string, unknown>>;
    };
    expect(callArg.tools).toEqual(
      expect.arrayContaining([
        { type: 'web_search_20250305', name: 'web_search' },
        { name: 'custom_tool', description: 'do something', input_schema: { type: 'object' } },
      ]),
    );
  });

  it('maxOutputTokens / temperature が指定されれば API へ渡る', async () => {
    messagesCreateMock.mockResolvedValueOnce(successResponse());
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    await client.complete(baseArgs({ maxOutputTokens: 8192, temperature: 0.3 }));
    const callArg = messagesCreateMock.mock.calls[0]![0] as {
      max_tokens: number;
      temperature: number;
    };
    expect(callArg.max_tokens).toBe(8192);
    expect(callArg.temperature).toBe(0.3);
  });

  it('複数 system メッセージは \\n\\n で結合される', async () => {
    messagesCreateMock.mockResolvedValueOnce(successResponse());
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    await client.complete({
      role: 'marketer',
      genre: 'practical',
      messages: [
        { role: 'system', content: 'S1' },
        { role: 'system', content: 'S2' },
        { role: 'user', content: 'U1' },
      ],
    });
    const callArg = messagesCreateMock.mock.calls[0]![0] as { system: string };
    expect(callArg.system).toBe('S1\n\nS2');
  });
});

describe('AgentSdkClient.complete — Prompt Caching (enablePromptCaching)', () => {
  it('enablePromptCaching=true のとき system が配列ブロック形式 + cache_control になる', async () => {
    messagesCreateMock.mockResolvedValueOnce(successResponse());
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    await client.complete(baseArgs({ enablePromptCaching: true }));

    const callArg = messagesCreateMock.mock.calls[0]![0] as {
      system: unknown;
    };
    expect(callArg.system).toEqual([
      { type: 'text', text: 'you are a marketer', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('enablePromptCaching=false のとき system は従来の文字列形式', async () => {
    messagesCreateMock.mockResolvedValueOnce(successResponse());
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    await client.complete(baseArgs({ enablePromptCaching: false }));

    const callArg = messagesCreateMock.mock.calls[0]![0] as { system: unknown };
    expect(callArg.system).toBe('you are a marketer');
  });

  it('enablePromptCaching 未指定のとき system は従来の文字列形式', async () => {
    messagesCreateMock.mockResolvedValueOnce(successResponse());
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    await client.complete(baseArgs());

    const callArg = messagesCreateMock.mock.calls[0]![0] as { system: unknown };
    expect(callArg.system).toBe('you are a marketer');
  });

  it('enablePromptCaching=true で system なしのとき system フィールドは省略される', async () => {
    messagesCreateMock.mockResolvedValueOnce(successResponse());
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    await client.complete({
      role: 'marketer',
      genre: 'practical',
      messages: [{ role: 'user', content: 'hello' }],
      enablePromptCaching: true,
    });

    const callArg = messagesCreateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg['system']).toBeUndefined();
  });

  it('cache_creation_input_tokens のみ > 0 のとき cachedInputTokens に集約される', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      successResponse({ cacheRead: 0, cacheCreate: 500 }),
    );
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    const result = await client.complete(baseArgs({ enablePromptCaching: true }));
    expect(result.usage.cachedInputTokens).toBe(500);
  });

  it('cache_read + cache_creation の合算が cachedInputTokens に入る', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      successResponse({ cacheRead: 300, cacheCreate: 200 }),
    );
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    const result = await client.complete(baseArgs({ enablePromptCaching: true }));
    expect(result.usage.cachedInputTokens).toBe(500);
  });

  it('cache トークンが 0 のとき cachedInputTokens は undefined', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      successResponse({ cacheRead: 0, cacheCreate: 0 }),
    );
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    const result = await client.complete(baseArgs({ enablePromptCaching: true }));
    expect(result.usage.cachedInputTokens).toBeUndefined();
  });
});

describe('AgentSdkClient.complete — retry policy', () => {
  it('429 (rate_limit) は最大 3 回試行で成功すれば返す', async () => {
    messagesCreateMock
      .mockRejectedValueOnce(apiError(429, 'rate limited'))
      .mockRejectedValueOnce(apiError(429, 'rate limited'))
      .mockResolvedValueOnce(successResponse({ text: 'finally' }));

    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    const result = await client.complete(baseArgs());
    expect(messagesCreateMock).toHaveBeenCalledTimes(3);
    expect(result.text).toBe('finally');
  });

  it('429 が 3 回連続なら ProviderError(retryable=false)', async () => {
    messagesCreateMock.mockRejectedValue(apiError(429, 'still 429'));
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    let caught: unknown;
    try {
      await client.complete(baseArgs());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(false);
    expect((caught as ProviderError).details).toMatchObject({
      status: 429,
      kind: 'rate_limit',
    });
    expect(messagesCreateMock).toHaveBeenCalledTimes(3);
  });

  it('500 (server_error) は 1 回だけリトライ → 2 回目で成功する', async () => {
    messagesCreateMock
      .mockRejectedValueOnce(apiError(500, 'upstream blew up'))
      .mockResolvedValueOnce(successResponse({ text: 'recovered' }));

    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    const result = await client.complete(baseArgs());
    expect(result.text).toBe('recovered');
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
  });

  it('503 が 2 回連続なら ProviderError', async () => {
    messagesCreateMock.mockRejectedValue(apiError(503, 'unavailable'));
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    let caught: unknown;
    try {
      await client.complete(baseArgs());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).details).toMatchObject({
      status: 503,
      kind: 'server_error',
    });
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
  });

  it('400 (client_error) は即時 ProviderError、リトライしない', async () => {
    messagesCreateMock.mockRejectedValue(apiError(400, 'bad request'));
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    let caught: unknown;
    try {
      await client.complete(baseArgs());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(false);
    expect((caught as ProviderError).details).toMatchObject({
      status: 400,
      kind: 'client_error',
    });
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('stop_reason=refusal は ProviderError(retryable=false)', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      ...successResponse(),
      stop_reason: 'refusal',
    });
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    let caught: unknown;
    try {
      await client.complete(baseArgs());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(false);
    expect((caught as ProviderError).details).toMatchObject({ stop_reason: 'refusal' });
  });
});

describe('AgentSdkClient.complete — responseSchema は拒否', () => {
  it('responseSchema 指定で ConfigError (silent 無視しない)', async () => {
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    const schema = z.object({ ok: z.boolean() });
    await expect(
      client.complete(baseArgs({ responseSchema: schema })),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });
});

describe('AgentSdkClient — assertAnthropicProvider (factory 整合性チェック)', () => {
  it('role=marketer, provider=anthropic は通る', () => {
    expect(() => assertAnthropicProvider('marketer', 'anthropic')).not.toThrow();
  });

  it('provider != anthropic は ConfigError', () => {
    expect(() => assertAnthropicProvider('marketer', 'openai')).toThrow(ConfigError);
    expect(() => assertAnthropicProvider('marketer', 'google')).toThrow(/anthropic/);
  });

  it('role != marketer は ConfigError (writer など)', () => {
    expect(() => assertAnthropicProvider('writer', 'anthropic')).toThrow(ConfigError);
    expect(() => assertAnthropicProvider('writer', 'anthropic')).toThrow(/marketer/);
  });
});

describe('AgentSdkClient.stream — 未実装', () => {
  it('stream() は ConfigError を throw する', async () => {
    const client = new AgentSdkClient({ model: 'm', apiKey: 'k' });
    const iter = client.stream(baseArgs());
    await expect(
      (async () => {
        for await (const _ of iter) void _;
      })(),
    ).rejects.toThrow(/does not support streaming/);
  });
});
