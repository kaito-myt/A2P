/**
 * T-03-03 — Web Search アダプタ I/F (docs/03 §A-03, §R-04 / docs/05 §6.3.1).
 *
 * 設計:
 *  - Marketer は通常 `AgentSdkClient.complete()` の中で Anthropic の server tool
 *    `web_search_20250305` を直接呼ぶ (= 本ファイルの AnthropicNativeWebSearch は no-op)。
 *  - 本ファイルは「Anthropic が不調な場合や、Marketer モデルが Anthropic 以外に
 *    切り替わった場合のフォールバック」を将来 Tavily 等で行う際の共通 I/F を確定する。
 *  - 本タスクのスコープは I/F + 環境変数チェックのみ。Tavily 本実装は Phase 2 (R-04)。
 */

import { z } from 'zod';

import { ConfigError } from '@a2p/contracts/errors';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const WebSearchQuerySchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(20).default(5),
  topic: z.enum(['general', 'news']).default('general').optional(),
});
export type WebSearchQuery = z.infer<typeof WebSearchQuerySchema>;

export const WebSearchResultItemSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string().optional(),
  /** ISO date string (RFC 3339) */
  published_at: z.string().optional(),
});
export type WebSearchResultItem = z.infer<typeof WebSearchResultItemSchema>;

export const WebSearchResultSchema = z.object({
  items: z.array(WebSearchResultItemSchema),
  provider: z.enum(['anthropic_native', 'tavily']),
  query: z.string(),
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export type WebSearchProvider = 'anthropic_native' | 'tavily';

export interface WebSearchAdapter {
  readonly provider: WebSearchProvider;
  search(query: WebSearchQuery): Promise<WebSearchResult>;
}

// ---------------------------------------------------------------------------
// Anthropic Native (no-op)
// ---------------------------------------------------------------------------

/**
 * Anthropic 内蔵 `web_search_20250305` 用のプレースホルダ。
 *
 * 実 web_search は `AgentSdkClient.complete()` 内で Messages API の server tool
 * として呼ばれるため、このアダプタの `search()` は常にエラーを返す。
 * Marketer 等の呼び出し側は `AgentSdkClient` を直接利用すること。
 */
export class AnthropicNativeWebSearch implements WebSearchAdapter {
  readonly provider: WebSearchProvider = 'anthropic_native';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_query: WebSearchQuery): Promise<WebSearchResult> {
    throw new ConfigError('web_search.anthropic_native_not_callable', {
      details: {
        reason:
          'Anthropic native web_search runs inside AgentSdkClient.complete(); use client.complete() instead.',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Tavily (Phase 2)
// ---------------------------------------------------------------------------

export interface TavilyWebSearchOptions {
  apiKey: string;
}

/**
 * Tavily フォールバックアダプタ。Phase 2 で本実装する (docs/03 §R-04)。
 * 現段階では I/F 確定のみで search() は ConfigError を throw する。
 */
export class TavilyWebSearch implements WebSearchAdapter {
  readonly provider: WebSearchProvider = 'tavily';

  // apiKey を constructor で受け取って格納する形だけ用意 (Phase 2 で実装)。
  constructor(_opts: TavilyWebSearchOptions) {
    // intentional no-op (I/F only)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_query: WebSearchQuery): Promise<WebSearchResult> {
    throw new ConfigError('web_search.tavily_not_implemented', {
      details: {
        reason:
          'Tavily fallback is planned in Phase 2; currently use Anthropic native via AgentSdkClient.',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateWebSearchAdapterOptions {
  provider: WebSearchProvider;
  /** Tavily を選択した場合に必須。 */
  tavilyApiKey?: string;
}

export function createWebSearchAdapter(
  opts: CreateWebSearchAdapterOptions,
): WebSearchAdapter {
  if (opts.provider === 'tavily') {
    if (!opts.tavilyApiKey || opts.tavilyApiKey.length === 0) {
      throw new ConfigError('web_search.tavily_api_key_missing', {
        details: {
          reason: 'TAVILY_API_KEY is required for tavily adapter.',
        },
      });
    }
    return new TavilyWebSearch({ apiKey: opts.tavilyApiKey });
  }
  return new AnthropicNativeWebSearch();
}
