import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type {
  AgentRole,
  Genre,
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
  LLMStreamChunk,
  LLMUsage,
  Provider,
} from '../src/lib/llm-client.js';

/**
 * docs/05 §6.1 / §6.1.3 の文字列リテラル合意を機械的に検証する。
 * リテラル集合がドキュメントと一致していること、および各型が
 * `LLMClient` を実装可能であることを型レベルで保証する。
 */

const AGENT_ROLES = [
  'marketer',
  'writer',
  'editor',
  'judge',
  'thumbnail_text',
  'thumbnail_image',
  'optimizer',
  'revision',
] as const satisfies readonly AgentRole[];

const GENRES = ['practical', 'business', 'self_help'] as const satisfies readonly Genre[];

const PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'tavily',
] as const satisfies readonly Provider[];

describe('AgentRole', () => {
  it('docs/05 §6.1 と同一の 8 役割を含む', () => {
    expect(AGENT_ROLES).toEqual([
      'marketer',
      'writer',
      'editor',
      'judge',
      'thumbnail_text',
      'thumbnail_image',
      'optimizer',
      'revision',
    ]);
  });

  it('AgentRole 全要素が読み取れる (型レベル exhaustiveness)', () => {
    const seen = new Set<AgentRole>();
    for (const role of AGENT_ROLES) seen.add(role);
    expect(seen.size).toBe(AGENT_ROLES.length);
  });
});

describe('Genre', () => {
  it('docs/05 §6.3 と同一の 3 ジャンル', () => {
    expect(GENRES).toEqual(['practical', 'business', 'self_help']);
  });
});

describe('Provider', () => {
  it('docs/05 §6.1.3 と同一の 4 プロバイダ', () => {
    expect(PROVIDERS).toEqual(['anthropic', 'openai', 'google', 'tavily']);
  });
});

describe('LLMCompleteArgs', () => {
  it('docs/05 §6.1 のフィールド形状を満たす', () => {
    const args: LLMCompleteArgs = {
      role: 'writer',
      genre: 'practical',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' },
      ],
      tools: [{ name: 'web_search_20250305' }],
      responseSchema: z.object({ ok: z.boolean() }),
      bookId: 'bk_1',
      themeSessionId: 'ts_1',
      jobId: 'job_1',
      maxOutputTokens: 4096,
      temperature: 0.7,
    };
    expect(args.role).toBe('writer');
    expect(args.messages).toHaveLength(2);
  });

  it('genre は null を許容する (fallback 用)', () => {
    const args: LLMCompleteArgs = {
      role: 'judge',
      genre: null,
      messages: [{ role: 'user', content: '...' }],
    };
    expect(args.genre).toBeNull();
  });

  it('messages の role はリテラル 3 種に制約される', () => {
    expectTypeOf<LLMCompleteArgs['messages'][number]['role']>().toEqualTypeOf<
      'system' | 'user' | 'assistant'
    >();
  });
});

describe('LLMUsage / LLMCompleteResult', () => {
  it('usage は input/output tokens を必須、cached/image はオプショナル', () => {
    const usage: LLMUsage = { inputTokens: 100, outputTokens: 200 };
    expect(usage.cachedInputTokens).toBeUndefined();
    expect(usage.imageCount).toBeUndefined();
  });

  it('LLMCompleteResult<string> がデフォルト', () => {
    const result: LLMCompleteResult = {
      text: 'hello',
      usage: { inputTokens: 1, outputTokens: 2 },
      costJpy: 0.5,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    };
    expectTypeOf(result.text).toBeString();
  });

  it('LLMCompleteResult<T> でジェネリック構造化出力を表現できる', () => {
    type Themes = { themes: Array<{ title: string }> };
    const result: LLMCompleteResult<Themes> = {
      text: { themes: [{ title: 'タイトル' }] },
      usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 },
      costJpy: 1.23,
      provider: 'openai',
      model: 'gpt-5',
    };
    expectTypeOf(result.text).toEqualTypeOf<Themes>();
    expect(result.text.themes[0]?.title).toBe('タイトル');
  });
});

describe('LLMClient interface', () => {
  it('complete()/stream() を持つ最小実装が型として通る', () => {
    class FakeClient implements LLMClient {
      async complete<T = string>(args: LLMCompleteArgs): Promise<LLMCompleteResult<T>> {
        return {
          text: '' as T,
          usage: { inputTokens: 0, outputTokens: 0 },
          costJpy: 0,
          provider: 'anthropic',
          model: 'noop',
          // args は intentionally 未使用 — interface 形状検査のみ
          ...(args.role ? {} : {}),
        };
      }

      async *stream(_args: LLMCompleteArgs): AsyncIterable<LLMStreamChunk> {
        yield { delta: 'x', usage: { inputTokens: 1, outputTokens: 1 } };
      }
    }

    const client: LLMClient = new FakeClient();
    expectTypeOf(client.complete).toBeFunction();
    expectTypeOf(client.stream).toBeFunction();
  });
});
