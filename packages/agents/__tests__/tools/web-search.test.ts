/**
 * T-03-03 — Web Search アダプタ I/F の単体テスト。
 *
 * スコープ:
 *  - factory が provider に応じた具象を返すこと
 *  - 各 search() が ConfigError を throw すること (I/F のみ実装のため)
 *  - zod スキーマの境界値検証
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '@a2p/contracts/errors';

import {
  AnthropicNativeWebSearch,
  TavilyWebSearch,
  WebSearchQuerySchema,
  WebSearchResultItemSchema,
  createWebSearchAdapter,
} from '../../src/tools/web-search.js';

describe('createWebSearchAdapter', () => {
  it('returns AnthropicNativeWebSearch when provider=anthropic_native', () => {
    const adapter = createWebSearchAdapter({ provider: 'anthropic_native' });
    expect(adapter).toBeInstanceOf(AnthropicNativeWebSearch);
    expect(adapter.provider).toBe('anthropic_native');
  });

  it('returns TavilyWebSearch when provider=tavily with apiKey', () => {
    const adapter = createWebSearchAdapter({
      provider: 'tavily',
      tavilyApiKey: 'tvly-xxxxxxxx',
    });
    expect(adapter).toBeInstanceOf(TavilyWebSearch);
    expect(adapter.provider).toBe('tavily');
  });

  it('throws ConfigError when provider=tavily and apiKey missing', () => {
    expect(() => createWebSearchAdapter({ provider: 'tavily' })).toThrow(
      ConfigError,
    );
    try {
      createWebSearchAdapter({ provider: 'tavily' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toBe(
        'web_search.tavily_api_key_missing',
      );
    }
  });

  it('throws ConfigError when provider=tavily and apiKey is empty string', () => {
    expect(() =>
      createWebSearchAdapter({ provider: 'tavily', tavilyApiKey: '' }),
    ).toThrow(ConfigError);
  });
});

describe('AnthropicNativeWebSearch', () => {
  it('search() throws ConfigError with anthropic_native_not_callable code', async () => {
    const adapter = new AnthropicNativeWebSearch();
    await expect(
      adapter.search({ query: 'amazon kdp', maxResults: 5 }),
    ).rejects.toBeInstanceOf(ConfigError);

    try {
      await adapter.search({ query: 'amazon kdp', maxResults: 5 });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toBe(
        'web_search.anthropic_native_not_callable',
      );
    }
  });
});

describe('TavilyWebSearch', () => {
  it('search() throws ConfigError with tavily_not_implemented code', async () => {
    const adapter = new TavilyWebSearch({ apiKey: 'tvly-xxxxxxxx' });
    await expect(
      adapter.search({ query: 'amazon kdp', maxResults: 5 }),
    ).rejects.toBeInstanceOf(ConfigError);

    try {
      await adapter.search({ query: 'amazon kdp', maxResults: 5 });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toBe(
        'web_search.tavily_not_implemented',
      );
    }
  });
});

describe('WebSearchQuerySchema', () => {
  it('rejects empty query', () => {
    const result = WebSearchQuerySchema.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });

  it('rejects query longer than 500 chars', () => {
    const result = WebSearchQuerySchema.safeParse({
      query: 'a'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxResults > 20', () => {
    const result = WebSearchQuerySchema.safeParse({
      query: 'ok',
      maxResults: 21,
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxResults < 1', () => {
    const result = WebSearchQuerySchema.safeParse({
      query: 'ok',
      maxResults: 0,
    });
    expect(result.success).toBe(false);
  });

  it('applies default maxResults=5 when omitted', () => {
    const result = WebSearchQuerySchema.safeParse({ query: 'ok' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResults).toBe(5);
    }
  });

  it('accepts a valid query', () => {
    const result = WebSearchQuerySchema.safeParse({
      query: 'amazon kdp 売れ筋',
      maxResults: 10,
      topic: 'news',
    });
    expect(result.success).toBe(true);
  });
});

describe('WebSearchResultItemSchema', () => {
  it('rejects invalid url', () => {
    const result = WebSearchResultItemSchema.safeParse({
      title: 'foo',
      url: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid item with optional fields omitted', () => {
    const result = WebSearchResultItemSchema.safeParse({
      title: 'foo',
      url: 'https://example.com/bar',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid item with all fields', () => {
    const result = WebSearchResultItemSchema.safeParse({
      title: 'foo',
      url: 'https://example.com/bar',
      snippet: 'baz',
      published_at: '2026-05-22T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });
});
