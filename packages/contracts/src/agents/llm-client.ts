import type { z } from 'zod';

/**
 * docs/05 §6.1 — LLM クライアント二層構造の統一インターフェース。
 * 実装 (AISdkClient / AgentSdkClient) は T-02-02 / T-02-03 で追加する。
 *
 * このファイルが LLM クライアント型の唯一の定義場所。
 * `packages/agents/src/lib/llm-client.ts` はここから re-export する。
 */

/** docs/05 §6.1.3 — getApiKey() が扱う 4 プロバイダ。 */
export type Provider = 'anthropic' | 'openai' | 'google' | 'tavily';

/** docs/05 §6.1 / §6.3 — ランタイムエージェントの役割識別子。 */
export type AgentRole =
  | 'marketer'
  | 'marketer_plan'
  | 'writer'
  | 'editor'
  | 'judge'
  | 'thumbnail_text'
  | 'thumbnail_image'
  | 'cover_text_check'
  | 'cover_art_direction'
  | 'outline_review'
  | 'promoter'
  | 'readings'
  | 'optimizer'
  | 'revision'
  // docs/06 — 組織エージェント（CEO ＋ 6 本部長）。
  | 'ceo'
  | 'editorial_mgr'
  | 'publish_mgr'
  | 'analytics_mgr'
  | 'promo_mgr'
  | 'ops_mgr'
  | 'finance_mgr'
  // docs/06 P2 — 担当者（実行）ロール。
  | 'sales_analyst'
  | 'market_analyst'
  | 'metadata_worker'
  // docs/06 P3 — 販促/経営の担当者ロール。
  | 'promo_analyst'
  | 'cost_accountant';

/**
 * マルチモーダル入力用の画像添付。`content` (テキスト) と併せてユーザーメッセージに付与する。
 * `data` は base64 (data: プレフィックス無し) / data URL / http(s) URL のいずれか。
 */
export interface LLMMessageImage {
  data: string;
  mimeType: string;
}

/** docs/02 / docs/05 §6.3 — 対応ジャンル 3 種。 */
export type Genre = 'practical' | 'business' | 'self_help';

/**
 * complete()/stream() に渡す任意のツール。
 * 例: Anthropic web_search_20250305 (server tool) や Tavily ラッパなど。
 * 具体的なツール定義は実装側で provider 依存に分岐する (T-02-03)。
 */
export interface LLMTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface LLMCompleteArgs {
  role: AgentRole;
  genre?: Genre | null;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
    /** マルチモーダル: ユーザーメッセージに添付する画像 (ビジョンモデル用)。 */
    images?: LLMMessageImage[];
  }>;
  tools?: LLMTool[];
  responseSchema?: z.ZodSchema;
  bookId?: string;
  themeSessionId?: string;
  jobId?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Anthropic Prompt Caching: system プロンプトに cache_control を付与する。未指定/false で従来挙動。 */
  enablePromptCaching?: boolean;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  imageCount?: number;
}

export interface LLMCompleteResult<T = string> {
  text: T;
  usage: LLMUsage;
  costJpy: number;
  provider: string;
  model: string;
}

export interface LLMStreamChunk {
  delta: string;
  usage?: LLMUsage;
}

export interface LLMClient {
  complete<T = string>(args: LLMCompleteArgs): Promise<LLMCompleteResult<T>>;
  stream(args: LLMCompleteArgs): AsyncIterable<LLMStreamChunk>;
}
