import { fail, type ActionFail } from './result.js';

/**
 * A2P 全層共通の例外型 (docs/05 §9.1)
 *
 * docs/05 で列挙されている 11 種を実装する。各派生は
 * - `code`     … `ActionResult.error.code` にそのまま流れる識別子
 * - `httpStatus` … Route Handler が JSON レスポンスを返す際の既定ステータス
 * - `retryable` … graphile-worker 内 `shouldRetry()` (docs/05 §9.3) の判定材料
 *
 * `userMessage` は UI に出してよい文言、`details` は構造化メタデータ、
 * `cause` は元例外。Pino redact 設定 (logger.ts) で機密キーは除去される前提だが、
 * `details` に資格情報を含めないこと。
 */

export type ErrorCode =
  | 'validation'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limit'
  | 'provider'
  | 'pipeline'
  | 'agent'
  | 'config'
  | 'storage'
  | 'kdp';

export interface A2PErrorOptions {
  /** UI に直接表示可能な日本語文言（任意）。 */
  userMessage?: string;
  /** 付加情報（zod issues / provider response 抜粋など）。機密を入れない。 */
  details?: unknown;
  /** 原因となった例外。Pino では `err` シリアライザ経由でスタック展開される。 */
  cause?: unknown;
}

export class A2PError extends Error {
  override readonly name: string = 'A2PError';
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly userMessage?: string;
  readonly details?: unknown;
  // Error.cause は ES2022 標準だが、ロガー側の利便のため公開フィールドも持つ
  override readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    httpStatus: number,
    retryable: boolean,
    message: string,
    options: A2PErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    if (options.userMessage !== undefined) this.userMessage = options.userMessage;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** Server Actions の戻り値に変換する。`message` は userMessage 優先。 */
  toActionResult(): ActionFail {
    const message = this.userMessage ?? this.message;
    return fail(this.code, message, this.details);
  }

  /** ログ/レスポンス共通の JSON 化（機密は含めない）。 */
  toJSON(): {
    name: string;
    code: ErrorCode;
    httpStatus: number;
    retryable: boolean;
    message: string;
    userMessage?: string;
    details?: unknown;
  } {
    return {
      name: this.name,
      code: this.code,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      message: this.message,
      ...(this.userMessage !== undefined ? { userMessage: this.userMessage } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export class ValidationError extends A2PError {
  override readonly name = 'ValidationError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('validation', 400, false, message, options);
  }
}

export class AuthError extends A2PError {
  override readonly name = 'AuthError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('auth', 401, false, message, options);
  }
}

export class ForbiddenError extends A2PError {
  override readonly name = 'ForbiddenError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('forbidden', 403, false, message, options);
  }
}

export class NotFoundError extends A2PError {
  override readonly name = 'NotFoundError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('not_found', 404, false, message, options);
  }
}

export class ConflictError extends A2PError {
  override readonly name = 'ConflictError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('conflict', 409, false, message, options);
  }
}

export class RateLimitError extends A2PError {
  override readonly name = 'RateLimitError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('rate_limit', 429, true, message, options);
  }
}

/**
 * 外部 LLM / 画像生成 / Web Search プロバイダ起因の失敗。
 * docs/05 §9.1 の `ProviderError` に相当（タスク仕様の LLMError / ExternalError
 * もここに包含する）。`retryable` はデフォルト true だが、4xx 系は false で
 * 投げ直すこと。
 */
export class ProviderError extends A2PError {
  override readonly name = 'ProviderError';
  constructor(message: string, options: A2PErrorOptions & { retryable?: boolean } = {}) {
    const { retryable = true, ...rest } = options;
    super('provider', 502, retryable, message, rest);
  }
}

export class PipelineError extends A2PError {
  override readonly name = 'PipelineError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('pipeline', 500, true, message, options);
  }
}

export class AgentError extends A2PError {
  override readonly name = 'AgentError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('agent', 500, true, message, options);
  }
}

export class ConfigError extends A2PError {
  override readonly name = 'ConfigError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('config', 500, false, message, options);
  }
}

export class StorageError extends A2PError {
  override readonly name = 'StorageError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('storage', 502, true, message, options);
  }
}

export class KdpError extends A2PError {
  override readonly name = 'KdpError';
  constructor(message: string, options: A2PErrorOptions = {}) {
    super('kdp', 502, true, message, options);
  }
}

/** 任意の値が A2PError かを判定する型ガード。 */
export function isA2PError(err: unknown): err is A2PError {
  return err instanceof A2PError;
}
