/**
 * docs/05 §6.1.1 / docs/03 §A-02 §C-05 §C-06 — Anthropic Messages API ベースの LLMClient 実装。
 *
 * Marketer (F-001) で `web_search_20250305` server tool を使うため `@anthropic-ai/sdk`
 * (公式 Messages API クライアント) を直接呼ぶ。Vercel AI SDK は server tool に未対応
 * (一般的な tool_use ループ前提) のため、Marketer 経路だけ本クラスを使う。
 *
 * 設計判断 [2026-05]:
 *  - 旧 `@anthropic-ai/claude-agent-sdk` は Claude Code CLI のプログラマブルラッパで
 *    `claude` バイナリを子プロセス起動する方式。Railway コンテナでの本番運用に不適合と
 *    判定したため Messages API 直叩きに切替えた (docs/03 §A-02 / docs/05 §6.1.1)。
 *  - constructor は `{ model, apiKey }` を取り、内部で DB / env を一切参照しない
 *    (AISdkClient と完全対称)。API キー取得は factory (`createLLMClient`) の責務。
 *  - 構造化出力 (`responseSchema`) は AISdkClient で扱う設計のため、本クラスに
 *    `responseSchema` を渡されたら `ConfigError` で reject する (silent 無視しない)。
 *  - 実コスト (costJpy) は `withTokenLogging` (T-02-04) が wrap して計算する。
 *    本クラス単体では costJpy=0 を返す (AISdkClient と同じ規約)。
 */

import Anthropic from '@anthropic-ai/sdk';
import pRetry, { AbortError } from 'p-retry';

import { ConfigError, ProviderError } from '@a2p/contracts/errors';
import type {
  AgentRole,
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
  LLMStreamChunk,
  LLMUsage,
} from '@a2p/contracts/agents';

import { classifyProviderError, isNonRetryable } from './errors.js';

/** AgentSdkClient は Anthropic 固定。 */
const PROVIDER = 'anthropic' as const;

/**
 * docs/05 §6.3.1 / 上記コメント — Marketer は `web_search_20250305` を server tool として利用する。
 * クライアント側で tool_use ↔ tool_result のループ処理は不要 (Anthropic 側で完結)。
 */
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
} as const;

const DEFAULT_MAX_TOKENS = 4096;

export interface AgentSdkClientOptions {
  /** Anthropic モデル ID (例: 'claude-opus-4-7')。 */
  model: string;
  /** Anthropic API キー。`getApiKey('anthropic')` 経由で factory から渡される。 */
  apiKey: string;
}

interface RetryPolicy {
  /** 同じエラー種別を含めた最大「総試行回数」(初回 + リトライ)。 */
  maxAttempts: number;
}

// 設計: T-02-03 task spec / docs/03 §A-04 — AISdkClient と同一パターン
const RATE_LIMIT_POLICY: RetryPolicy = { maxAttempts: 3 };
const SERVER_ERROR_POLICY: RetryPolicy = { maxAttempts: 2 };
const NETWORK_POLICY: RetryPolicy = { maxAttempts: 2 };
const UNKNOWN_POLICY: RetryPolicy = { maxAttempts: 2 };
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const MAX_RETRIES = Math.max(
  RATE_LIMIT_POLICY.maxAttempts,
  SERVER_ERROR_POLICY.maxAttempts,
  NETWORK_POLICY.maxAttempts,
  UNKNOWN_POLICY.maxAttempts,
) - 1;

/** Anthropic API レスポンスの content block 配列から text を抽出する。 */
function extractText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** Anthropic usage を LLMUsage に正規化。cache_read + cache_creation を cachedInputTokens に合算。 */
function toLLMUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): LLMUsage {
  const cached =
    (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const out: LLMUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
  if (cached > 0) out.cachedInputTokens = cached;
  return out;
}

/** Anthropic Messages API では system は top-level field。残りは role が user|assistant のみ許容。 */
function splitMessages(messages: LLMCompleteArgs['messages']): {
  system?: string;
  rest: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systems = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  const system = systems.length > 0 ? systems.join('\n\n') : undefined;
  return system !== undefined ? { system, rest } : { rest };
}

/**
 * 追加ツール (`args.tools`) を Anthropic Messages API の tools 配列形に変換する。
 * Marketer 既定の web_search server tool は常に先頭に含める。
 */
function buildTools(args: LLMCompleteArgs): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [{ ...WEB_SEARCH_TOOL }];
  for (const t of args.tools ?? []) {
    // 既定の web_search と重複する場合はスキップ (caller が同名を渡しても安全)
    if (t.name === WEB_SEARCH_TOOL.name) continue;
    tools.push({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.inputSchema !== undefined ? { input_schema: t.inputSchema } : {}),
    });
  }
  return tools;
}

export class AgentSdkClient implements LLMClient {
  readonly #model: string;
  readonly #apiKey: string;

  constructor(opts: AgentSdkClientOptions) {
    if (!opts.apiKey) throw new ConfigError('AgentSdkClient: apiKey is required');
    if (!opts.model) throw new ConfigError('AgentSdkClient: model is required');
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
  }

  get provider(): typeof PROVIDER {
    return PROVIDER;
  }

  get model(): string {
    return this.#model;
  }

  async complete<T = string>(args: LLMCompleteArgs): Promise<LLMCompleteResult<T>> {
    if (args.responseSchema) {
      // 構造化出力は AISdkClient (generateObject) の責務。Marketer は自由テキスト + 検索結果を返す設計。
      throw new ConfigError(
        'AgentSdkClient does not support responseSchema (use AISdkClient for structured output)',
      );
    }

    const client = new Anthropic({ apiKey: this.#apiKey });
    const { system, rest } = splitMessages(args.messages);
    const tools = buildTools(args);

    const run = async (): Promise<LLMCompleteResult<T>> => {
      // enablePromptCaching=true のとき、system を配列ブロック形式に変換して cache_control を付与する。
      // Anthropic Prompt Caching 仕様: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
      const systemParam =
        args.enablePromptCaching && system !== undefined
          ? ([{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] as never)
          : system;

      const response = await client.messages.create({
        model: this.#model,
        max_tokens: args.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        ...(systemParam !== undefined ? { system: systemParam } : {}),
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        messages: rest,
        // Anthropic SDK の tool 型は server tool / custom tool / MCP 等のユニオン。
        // 我々は最小形 (web_search server tool + 任意 custom) しか渡さないので
        // 型を狭めて any 抑止だけ最小限に行う。
        tools: tools as never,
      });

      if (response.stop_reason === 'refusal') {
        throw new ProviderError('anthropic refused the request', {
          retryable: false,
          details: { stop_reason: response.stop_reason },
        });
      }

      const text = extractText(response.content as ReadonlyArray<{ type: string; text?: string }>);
      const usage = toLLMUsage(response.usage);

      return {
        text: text as T,
        usage,
        costJpy: 0,
        provider: PROVIDER,
        model: this.#model,
      };
    };

    return await this.#runWithRetry(run);
  }

  // Marketer 用途 (1 回応答 + server-side web search) では stream は使わない。
  // インターフェース整合のため定義のみ。呼ばれたら明示的に失敗させる。
  // eslint-disable-next-line require-yield
  async *stream(_args: LLMCompleteArgs): AsyncIterable<LLMStreamChunk> {
    throw new ConfigError('AgentSdkClient does not support streaming');
  }

  async #runWithRetry<R>(fn: () => Promise<R>): Promise<R> {
    const attemptCounter = { current: 0 };

    try {
      return await pRetry(
        async () => {
          attemptCounter.current += 1;
          try {
            return await fn();
          } catch (raw) {
            // 既に確定済みの non-retryable ProviderError (e.g. stop_reason=refusal) は
            // そのまま即時中断する。classifier に通して details を消失させない。
            if (raw instanceof ProviderError && !raw.retryable) {
              throw new AbortError(raw);
            }
            const classified = classifyProviderError(raw);
            if (isNonRetryable(classified.kind)) {
              throw new AbortError(
                new ProviderError(
                  `${PROVIDER} messages.create failed: ${classified.message}`,
                  {
                    retryable: false,
                    cause: raw,
                    details: { status: classified.status, kind: classified.kind },
                  },
                ),
              );
            }
            const policy = pickPolicy(classified.kind);
            if (attemptCounter.current >= policy.maxAttempts) {
              throw new AbortError(
                new ProviderError(
                  `${PROVIDER} messages.create failed after ${attemptCounter.current} attempt(s): ${classified.message}`,
                  {
                    retryable: false,
                    cause: raw,
                    details: { status: classified.status, kind: classified.kind },
                  },
                ),
              );
            }
            throw raw;
          }
        },
        {
          retries: MAX_RETRIES,
          factor: 2,
          minTimeout: BACKOFF_BASE_MS,
          maxTimeout: BACKOFF_MAX_MS,
          randomize: false,
        },
      );
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const classified = classifyProviderError(err);
      throw new ProviderError(
        `${PROVIDER} messages.create failed: ${classified.message}`,
        {
          retryable: false,
          cause: err,
          details: { status: classified.status, kind: classified.kind },
        },
      );
    }
  }
}

function pickPolicy(kind: ReturnType<typeof classifyProviderError>['kind']): RetryPolicy {
  switch (kind) {
    case 'rate_limit':
      return RATE_LIMIT_POLICY;
    case 'server_error':
      return SERVER_ERROR_POLICY;
    case 'network':
      return NETWORK_POLICY;
    case 'client_error':
      return { maxAttempts: 1 };
    case 'unknown':
    default:
      return UNKNOWN_POLICY;
  }
}

/**
 * docs/05 §6.1.2 — factory (`createLLMClient`) から呼び出す provider/role 整合チェック。
 * 「Marketer + Anthropic の組合せ」以外で本クラスがインスタンス化されることはバグ。
 *
 * factory 経路でしか new されない前提だが、CI 整合チェック (docs/05 §10.1) や
 * 将来の追加 role に備え、静的ヘルパとして export しておく。
 */
export function assertAnthropicProvider(role: AgentRole, provider: string): void {
  if (provider !== PROVIDER) {
    throw new ConfigError(
      `AgentSdkClient requires provider='anthropic', got '${provider}'`,
    );
  }
  if (role !== 'marketer') {
    throw new ConfigError(
      `AgentSdkClient is only valid for role='marketer', got '${role}'`,
    );
  }
}
