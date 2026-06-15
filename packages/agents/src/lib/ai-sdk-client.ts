/**
 * docs/05 §6.1.1 — Vercel AI SDK ベースの LLMClient 実装。
 * Marketer 以外の役割、または Anthropic 以外のプロバイダで使用される。
 *
 * 実コスト計算 (costJpy) と token_usage への記録は `withTokenLogging`
 * (T-02-04) が wrap して行う。本クラス単体では costJpy=0 を返す。
 */

import type { LanguageModel } from 'ai';
import { generateObject, generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import pRetry, { AbortError } from 'p-retry';

import { ConfigError, ProviderError } from '@a2p/contracts/errors';
import type {
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
  LLMStreamChunk,
  Provider,
} from '@a2p/contracts/agents';

import { classifyProviderError, isNonRetryable } from './errors.js';

/** AI SDK 経由でモデルを呼び出せる 3 プロバイダ。Tavily は web 検索専用なので除外。 */
type AISdkProvider = Exclude<Provider, 'tavily'>;

export interface AISdkClientOptions {
  provider: AISdkProvider;
  model: string;
  apiKey: string;
}

interface RetryPolicy {
  /** 同じエラー種別を含めた最大「総試行回数」(初回 + リトライ)。 */
  maxAttempts: number;
}

// 設計: T-02-02 task spec / docs/03 §A-04
//   rate_limit (429): 最大 3 回
//   server_error (5xx): 最大 1 回リトライ → 総 2 回
//   client_error (429 以外の 4xx): リトライしない → 総 1 回
//   network / unknown: 最大 1 回リトライ → 総 2 回
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

function makeModel(opts: AISdkClientOptions): LanguageModel {
  switch (opts.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: opts.apiKey })(opts.model);
    case 'openai':
      return createOpenAI({ apiKey: opts.apiKey })(opts.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: opts.apiKey })(opts.model);
    default: {
      const exhaustive: never = opts.provider;
      throw new ConfigError(`unsupported provider: ${String(exhaustive)}`);
    }
  }
}

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
 * When enablePromptCaching=true and provider=anthropic, build the messages array
 * with system messages included (with cacheControl providerOptions) instead of
 * using the separate `system` string parameter. This allows @ai-sdk/anthropic to
 * attach cache_control to the system block.
 */
function buildCachedMessages(
  system: string | undefined,
  rest: Array<{ role: 'user' | 'assistant'; content: string }>,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string; providerOptions?: Record<string, Record<string, unknown>> }> {
  const result: Array<{ role: 'system' | 'user' | 'assistant'; content: string; providerOptions?: Record<string, Record<string, unknown>> }> = [];
  if (system !== undefined) {
    result.push({
      role: 'system',
      content: system,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  }
  result.push(...rest);
  return result;
}

function buildToolSet(args: LLMCompleteArgs): Record<string, unknown> | undefined {
  if (!args.tools || args.tools.length === 0) return undefined;
  // T-02-02 スコープでは tool 受け渡しのみサポート。実呼出は AgentSdkClient (T-02-03) や
  // 後続タスクで個別実装する。AI SDK の `tools` 期待形にだけ変換しておく。
  const set: Record<string, unknown> = {};
  for (const t of args.tools) {
    set[t.name] = {
      description: t.description,
      inputSchema: t.inputSchema,
    };
  }
  return set;
}

export class AISdkClient implements LLMClient {
  readonly #provider: AISdkProvider;
  readonly #model: string;
  readonly #apiKey: string;

  constructor(opts: AISdkClientOptions) {
    if (!opts.apiKey) throw new ConfigError('AISdkClient: apiKey is required');
    if (!opts.model) throw new ConfigError('AISdkClient: model is required');
    this.#provider = opts.provider;
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
  }

  get provider(): AISdkProvider {
    return this.#provider;
  }

  get model(): string {
    return this.#model;
  }

  async complete<T = string>(args: LLMCompleteArgs): Promise<LLMCompleteResult<T>> {
    const model = makeModel({
      provider: this.#provider,
      model: this.#model,
      apiKey: this.#apiKey,
    });
    const { system, rest } = splitMessages(args.messages);

    const usePromptCaching = this.#provider === 'anthropic' && args.enablePromptCaching === true;

    const run = async (): Promise<LLMCompleteResult<T>> => {
      if (args.responseSchema) {
        let generateObjectArgs: Parameters<typeof generateObject>[0];
        if (usePromptCaching) {
          // Pass system as a message with providerOptions so @ai-sdk/anthropic attaches cache_control
          generateObjectArgs = {
            model,
            schema: args.responseSchema,
            messages: buildCachedMessages(system, rest) as never,
            ...(args.maxOutputTokens !== undefined
              ? { maxOutputTokens: args.maxOutputTokens }
              : {}),
            ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
            maxRetries: 0,
          };
        } else {
          generateObjectArgs = {
            model,
            schema: args.responseSchema,
            ...(system !== undefined ? { system } : {}),
            messages: rest,
            ...(args.maxOutputTokens !== undefined
              ? { maxOutputTokens: args.maxOutputTokens }
              : {}),
            ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
            maxRetries: 0,
          };
        }
        const res = await generateObject(generateObjectArgs);
        return {
          text: res.object as T,
          usage: {
            inputTokens: res.usage.inputTokens ?? 0,
            outputTokens: res.usage.outputTokens ?? 0,
            ...(res.usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: res.usage.cachedInputTokens }
              : {}),
          },
          costJpy: 0,
          provider: this.#provider,
          model: this.#model,
        };
      }
      const tools = buildToolSet(args);
      let generateTextArgs: Parameters<typeof generateText>[0];
      if (usePromptCaching) {
        generateTextArgs = {
          model,
          messages: buildCachedMessages(system, rest) as never,
          ...(tools !== undefined ? { tools: tools as never } : {}),
          ...(args.maxOutputTokens !== undefined
            ? { maxOutputTokens: args.maxOutputTokens }
            : {}),
          ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
          maxRetries: 0,
        };
      } else {
        generateTextArgs = {
          model,
          ...(system !== undefined ? { system } : {}),
          messages: rest,
          ...(tools !== undefined ? { tools: tools as never } : {}),
          ...(args.maxOutputTokens !== undefined
            ? { maxOutputTokens: args.maxOutputTokens }
            : {}),
          ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
          maxRetries: 0,
        };
      }
      const res = await generateText(generateTextArgs);
      return {
        text: res.text as T,
        usage: {
          inputTokens: res.usage.inputTokens ?? 0,
          outputTokens: res.usage.outputTokens ?? 0,
          ...(res.usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: res.usage.cachedInputTokens }
            : {}),
        },
        costJpy: 0,
        provider: this.#provider,
        model: this.#model,
      };
    };

    return await this.#runWithRetry(run);
  }

  // 将来用 (T-02-XX で実装予定)。本タスクではスコープ外。
  // eslint-disable-next-line require-yield
  async *stream(_args: LLMCompleteArgs): AsyncIterable<LLMStreamChunk> {
    throw new ConfigError('AISdkClient.stream: not implemented yet (planned for streaming task)');
  }

  async #runWithRetry<R>(fn: () => Promise<R>): Promise<R> {
    // 種別ごとの上限は内部 attemptCounter + AbortError で打ち切る。
    // p-retry には全体最大 (MAX_RETRIES) を与え、内部で kind 別 cutoff する。
    const attemptCounter = { current: 0 };

    try {
      return await pRetry(
        async () => {
          attemptCounter.current += 1;
          try {
            return await fn();
          } catch (raw) {
            const classified = classifyProviderError(raw);
            // 4xx (429 以外) は即時打ち切り
            if (isNonRetryable(classified.kind)) {
              throw new AbortError(
                new ProviderError(
                  `${this.#provider} request failed: ${classified.message}`,
                  {
                    retryable: false,
                    cause: raw,
                    details: { status: classified.status, kind: classified.kind },
                  },
                ),
              );
            }
            // 種別ごとの maxAttempts を超えていたら打ち切る
            const policy = pickPolicy(classified.kind);
            if (attemptCounter.current >= policy.maxAttempts) {
              throw new AbortError(
                new ProviderError(
                  `${this.#provider} request failed after ${attemptCounter.current} attempt(s): ${classified.message}`,
                  {
                    retryable: false,
                    cause: raw,
                    details: { status: classified.status, kind: classified.kind },
                  },
                ),
              );
            }
            // ここまで来たら次回リトライを許す
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
      // AbortError unwrap (p-retry は AbortError の .originalError ではなく .cause/wrappedError を渡す版もあるが、上で AbortError(new ProviderError(...)) を渡しているので message に Provider 情報が乗っている前提)
      const classified = classifyProviderError(err);
      throw new ProviderError(
        `${this.#provider} request failed: ${classified.message}`,
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
      // client_error は isNonRetryable で即時打ち切る経路に入るので、policy は実質未使用
      return { maxAttempts: 1 };
    case 'unknown':
    default:
      return UNKNOWN_POLICY;
  }
}
