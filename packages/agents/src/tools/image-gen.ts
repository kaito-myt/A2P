/**
 * docs/03 §C-07 §E-04 / docs/05 §10.1 / T-02-06 — OpenAI `gpt-image-1` 画像生成ラッパ。
 *
 * 設計:
 *  - costJpy 算出と token_usage への記録は `withImageLogging` (本 PR 同梱) の責務。
 *    本関数単体では costJpy=0 と imageCount のみ返す (AISdkClient と同規約)。
 *  - リトライポリシは AISdkClient / AgentSdkClient と完全対称:
 *      429 (rate_limit) ×3 / 5xx (server_error) ×2 / 4xx (client_error) 即時打切 / network ×2
 *    `classifyProviderError` を流用してエラー種別を判定する。
 *  - sharp による KDP 寸法アップスケールは枠だけ。本実装は SP-05 で行う
 *    (`// TODO(SP-05): sharp で KDP 寸法へアップスケール` を残す)。
 *  - DI: `deps.openaiFactory` を差し替えれば SDK 呼出を msw 等に依らずモック可能。
 */
import pRetry, { AbortError } from 'p-retry';

import { ConfigError, ProviderError } from '@a2p/contracts/errors';

import { classifyProviderError, isNonRetryable } from '../lib/errors.js';

/**
 * OpenAI `gpt-image-1` の quality パラメータ。
 * gpt-image-1 は `low | medium | high | auto` を取る (DALL·E 3 の standard/hd ではない)。
 */
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';

/**
 * gpt-image-1 の出力フォーマット。`output_format` にそのまま渡す。
 * 既定 (未指定) は OpenAI 側の既定 = PNG。
 */
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp';

export interface GenerateImageArgs {
  /** 画像生成プロンプト (日本語可)。 */
  prompt: string;
  /** 出力幅 (px)。OpenAI gpt-image-1 がサポートするサイズに正規化される。 */
  width: number;
  /** 出力高さ (px)。 */
  height: number;
  /** 生成枚数。既定 1。 */
  count?: number;
  /** OpenAI 品質オプション。既定 'standard'。 */
  quality?: ImageQuality;
  /** 出力フォーマット (png | jpeg | webp)。未指定なら OpenAI 既定 (PNG)。 */
  outputFormat?: ImageOutputFormat;
  /** jpeg/webp の圧縮率 0-100 (高いほど高品質)。outputFormat が jpeg/webp の時のみ有効。 */
  outputCompression?: number;
}

export interface GenerateImageResult {
  /** 生成された画像バイナリ (base64 デコード後)。フォーマットは outputFormat に従う (既定 PNG)。 */
  images: Buffer[];
  /** 単体呼出では常に 0。実コストは `withImageLogging` が算出する。 */
  costJpy: number;
  usage: {
    imageCount: number;
  };
}

/**
 * OpenAI Images API の最小サブセット型。本ファイル内では SDK 全体に依存せず、
 * 必要なメソッド形状だけを記述する (テストで差し替え可能にするため)。
 */
export interface OpenAIImagesClient {
  images: {
    generate(args: {
      model: string;
      prompt: string;
      size: string;
      n: number;
      quality?: ImageQuality;
      output_format?: ImageOutputFormat;
      output_compression?: number;
    }): Promise<{
      data?: Array<{ b64_json?: string | null } | null> | null;
    }>;
  };
}

export interface ImageGenDeps {
  /** API キー解決関数 (既定: `getApiKey('openai')`)。 */
  getApiKey?: () => Promise<string>;
  /** OpenAI クライアント生成関数 (テスト時に差し替え可)。 */
  openaiFactory?: (apiKey: string) => OpenAIImagesClient;
}

// ---------------------------------------------------------------------------
// リトライポリシ — AISdkClient と同一値 (docs/03 §A-04)
// ---------------------------------------------------------------------------

interface RetryPolicy {
  maxAttempts: number;
}
const RATE_LIMIT_POLICY: RetryPolicy = { maxAttempts: 3 };
const SERVER_ERROR_POLICY: RetryPolicy = { maxAttempts: 2 };
const NETWORK_POLICY: RetryPolicy = { maxAttempts: 2 };
const UNKNOWN_POLICY: RetryPolicy = { maxAttempts: 2 };
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const MAX_RETRIES =
  Math.max(
    RATE_LIMIT_POLICY.maxAttempts,
    SERVER_ERROR_POLICY.maxAttempts,
    NETWORK_POLICY.maxAttempts,
    UNKNOWN_POLICY.maxAttempts,
  ) - 1;

const PROVIDER = 'openai';
const MODEL = 'gpt-image-1';

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
 * 既定の OpenAI クライアント生成関数。`openai` SDK を遅延 import するため
 * テスト時 (factory 差し替え) には SDK ロード自体を回避できる。
 */
async function defaultOpenaiFactory(apiKey: string): Promise<OpenAIImagesClient> {
  const mod = await import('openai');
  const OpenAI = (mod as { default?: new (opts: { apiKey: string }) => OpenAIImagesClient }).default
    ?? (mod as unknown as new (opts: { apiKey: string }) => OpenAIImagesClient);
  return new OpenAI({ apiKey });
}

/**
 * 既定の API キー解決関数。`getApiKey('openai')` を遅延 import で呼ぶ。
 * 循環参照回避と、テストで `getApiKey` をモックしなくても済む形にするため。
 */
async function defaultGetApiKey(): Promise<string> {
  const mod = await import('../lib/get-api-key.js');
  return mod.getApiKey('openai');
}

function normalizeSize(width: number, height: number): string {
  if (!Number.isFinite(width) || width <= 0) {
    throw new ConfigError(`generateImage: invalid width=${String(width)}`);
  }
  if (!Number.isFinite(height) || height <= 0) {
    throw new ConfigError(`generateImage: invalid height=${String(height)}`);
  }
  // TODO(SP-05): sharp で KDP 寸法へアップスケール — 現状は OpenAI が返す size をそのまま使う。
  //   KDP 表紙は 2560x1600 等の特定寸法だが、gpt-image-1 のサポートサイズは
  //   1024x1024 / 1024x1536 / 1536x1024 / auto。SP-05 で sharp による後処理を入れる。
  return `${Math.round(width)}x${Math.round(height)}`;
}

async function runWithRetry<R>(fn: () => Promise<R>): Promise<R> {
  const attemptCounter = { current: 0 };
  try {
    return await pRetry(
      async () => {
        attemptCounter.current += 1;
        try {
          return await fn();
        } catch (raw) {
          const classified = classifyProviderError(raw);
          if (isNonRetryable(classified.kind)) {
            throw new AbortError(
              new ProviderError(
                `${PROVIDER} images.generate failed: ${classified.message}`,
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
                `${PROVIDER} images.generate failed after ${attemptCounter.current} attempt(s): ${classified.message}`,
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
    throw new ProviderError(`${PROVIDER} images.generate failed: ${classified.message}`, {
      retryable: false,
      cause: err,
      details: { status: classified.status, kind: classified.kind },
    });
  }
}

/**
 * OpenAI `gpt-image-1` で画像を生成する。
 *
 * @throws ConfigError 入力検証エラー (空 prompt / 不正サイズ / count<=0)
 * @throws ProviderError 認証/リクエスト/サーバエラー (リトライ後)
 */
export async function generateImage(
  args: GenerateImageArgs,
  deps: ImageGenDeps = {},
): Promise<GenerateImageResult> {
  if (!args.prompt || args.prompt.trim().length === 0) {
    throw new ConfigError('generateImage: prompt is required');
  }
  const count = args.count ?? 1;
  if (!Number.isInteger(count) || count <= 0) {
    throw new ConfigError(`generateImage: count must be a positive integer (got ${String(count)})`);
  }
  const size = normalizeSize(args.width, args.height);

  const apiKey = await (deps.getApiKey ?? defaultGetApiKey)();
  const client = await (deps.openaiFactory
    ? Promise.resolve(deps.openaiFactory(apiKey))
    : defaultOpenaiFactory(apiKey));

  const response = await runWithRetry(() =>
    client.images.generate({
      model: MODEL,
      prompt: args.prompt,
      size,
      n: count,
      ...(args.quality !== undefined ? { quality: args.quality } : {}),
      ...(args.outputFormat !== undefined ? { output_format: args.outputFormat } : {}),
      ...(args.outputCompression !== undefined
        ? { output_compression: args.outputCompression }
        : {}),
    }),
  );

  const data = response.data ?? [];
  const images: Buffer[] = [];
  for (const item of data) {
    const b64 = item?.b64_json;
    if (typeof b64 !== 'string' || b64.length === 0) {
      throw new ProviderError(`${PROVIDER} images.generate returned empty b64_json`, {
        retryable: false,
        details: { received: data.length },
      });
    }
    images.push(Buffer.from(b64, 'base64'));
  }

  if (images.length === 0) {
    throw new ProviderError(`${PROVIDER} images.generate returned no images`, {
      retryable: false,
    });
  }

  return {
    images,
    costJpy: 0,
    usage: { imageCount: images.length },
  };
}

/** withImageLogging から型参照される — 画像生成関数の最小シグネチャ。 */
export type GenerateImageFn = (
  args: GenerateImageArgs,
  deps?: ImageGenDeps,
) => Promise<GenerateImageResult>;
