import { z } from 'zod';

/**
 * A2P 環境変数スキーマ (docs/03 §5 全 29 項目)
 *
 * 起動時に `parseEnv(process.env)` を呼び、失敗した場合はアプリを `process.exit(1)` で停止する。
 * - `apps/web/instrumentation.ts` または起動エントリ
 * - `apps/worker/src/index.ts` 起動エントリ
 *
 * 任意項目はデフォルト値を持つ。Phase 3 専用 (`KDP_CRED_KEY`) や本番のみ必須
 * (`NEXTAUTH_URL`) のものは optional とし、利用箇所側で個別チェックする。
 *
 * T-02-13 で 4 プロバイダ API キー (ANTHROPIC/OPENAI/GOOGLE/TAVILY) を `.optional()`
 * 化した。DB の `ApiCredential` (UI 設定) が優先、env はフォールバック。
 *
 * `emptyToUndef()`: `.env.local` の `KEY=` (空文字) を `undefined` 扱いにする
 * preprocess。`.optional()` 系フィールドに使うと運用者が行を残したまま
 * 値を消せる (`.min(1)` だと空文字で fail していた既知バグの解消)。
 */

const NodeEnvSchema = z.enum(['development', 'test', 'production']);
const LogLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

const HexString = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`), `${bytes} bytes (${bytes * 2} hex chars) required`);

const PositiveInt = z.coerce.number().int().positive();
const NonNegativeInt = z.coerce.number().int().nonnegative();

/**
 * 空文字を undefined に正規化してから schema に渡す preprocess。
 * `.optional()` 系のフィールドにのみ適用する (`AUTH_USERNAME` 等の必須には付けない)。
 */
const emptyToUndef = <S extends z.ZodTypeAny>(schema: S) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

export const EnvSchema = z.object({
  // --- 1. 実行モード -------------------------------------------------------
  NODE_ENV: NodeEnvSchema,

  // --- 2. DB --------------------------------------------------------------
  DATABASE_URL: z.string().url(),

  // --- 3-5. 認証 / アプリ URL ---------------------------------------------
  NEXTAUTH_SECRET: HexString(32),
  NEXTAUTH_URL: emptyToUndef(z.string().url().optional()),
  NEXT_PUBLIC_APP_URL: z.string().url(),

  // --- 6-7. シングルユーザー認証 ------------------------------------------
  AUTH_USERNAME: z.string().min(1),
  AUTH_PASSWORD_HASH: z.string().min(1),

  // --- 8-11. LLM プロバイダ (T-02-13 で DB 経由優先化、env はフォールバック) -
  ANTHROPIC_API_KEY: emptyToUndef(z.string().min(1).optional()),
  OPENAI_API_KEY: emptyToUndef(z.string().min(1).optional()),
  GOOGLE_GENERATIVE_AI_API_KEY: emptyToUndef(z.string().min(1).optional()),
  TAVILY_API_KEY: emptyToUndef(z.string().min(1).optional()),

  // --- 12-16. R2 (オブジェクトストレージ) ---------------------------------
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  R2_PUBLIC_URL_BASE: z.string().url(),

  // --- 17-19. メール (Resend) ---------------------------------------------
  RESEND_API_KEY: z.string().min(1),
  MAIL_FROM: z.string().email(),
  MAIL_TO: z.string().email(),

  // --- 20. KDP 認証情報暗号鍵 (Phase 3 必須) ------------------------------
  KDP_CRED_KEY: emptyToUndef(HexString(32).optional()),

  // --- 20a. API 認証情報暗号鍵 (Phase 1 必須 — T-02-13) -------------------
  API_CRED_KEY: emptyToUndef(HexString(32).optional()),

  // --- 21-22. 監視 / ログ --------------------------------------------------
  SENTRY_DSN: emptyToUndef(z.string().url().optional()),
  LOG_LEVEL: LogLevelSchema.default('info'),

  // --- 23-24. ワーカー並列度 ----------------------------------------------
  WORKER_BOOK_CONCURRENCY: PositiveInt.default(5),
  WORKER_CHAPTER_CONCURRENCY: PositiveInt.default(4),

  // --- 25. 単価カタログ取得 cron ------------------------------------------
  MODEL_CATALOG_FETCH_CRON: z.string().min(1).default('0 19 * * *'),

  // --- 26. 為替 API --------------------------------------------------------
  FX_RATE_API_URL: z.string().url().default('https://open.er-api.com/v6/latest/USD'),

  // --- 27-28. コスト上限 (JPY) ---------------------------------------------
  COST_LIMIT_PER_BOOK_JPY: NonNegativeInt.default(500),
  COST_LIMIT_MONTHLY_JPY: NonNegativeInt.default(50000),
});

export type Env = z.infer<typeof EnvSchema>;

/** docs/03 §5 の正本キー一覧。`.env.example` 整合性検査と CI で参照する。 */
export const ENV_KEYS = Object.keys(EnvSchema.shape) as Array<keyof Env>;

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  constructor(
    message: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(message);
  }
}

interface ParseEnvOptions {
  /**
   * 検証失敗時の挙動。
   * - `'exit'` (既定): stderr に整形したメッセージを出力し `process.exit(1)`
   * - `'throw'`: `EnvValidationError` を throw（テスト用途）
   */
  onError?: 'exit' | 'throw';
  /** エラー出力ストリーム差し替え（テスト用途）。 */
  stderr?: { write(chunk: string): boolean };
  /** `process.exit` の差し替え（テスト用途）。 */
  exit?: (code: number) => never;
}

/**
 * `process.env` を検証してパース済み Env を返す。
 * 失敗時の既定動作は `process.exit(1)`。
 */
export function parseEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: ParseEnvOptions = {},
): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;

  const { onError = 'exit', stderr = process.stderr, exit = process.exit } = options;
  const lines = result.error.issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  const message = `[A2P] Environment variable validation failed:\n${lines.join('\n')}\n`;

  if (onError === 'throw') {
    throw new EnvValidationError(message, result.error.issues);
  }
  stderr.write(message);
  return exit(1) as never;
}
