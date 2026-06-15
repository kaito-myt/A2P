import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * A2P 共通 Pino ロガー (docs/03 §G-01, docs/05 §10.2)
 *
 * - 環境変数 `LOG_LEVEL` を尊重（既定 `info`）
 * - 環境変数 `NODE_ENV` が `'production'` 以外なら `pino-pretty` で整形出力（dev/test）
 * - production では 1 行 JSON 出力 + ISO timestamp
 * - 機密項目は redact wildcard でネスト含めマスク（`***`）
 * - `base.service` は `SERVICE_NAME` env から（既定 `'a2p'`）
 *
 * アプリケーション側からは `createLogger(name)` を呼んで子ロガーを取得する。
 * 例: `const log = createLogger('worker.pipeline.book.kickoff')`
 */

const REDACT_PATHS = [
  // 任意の階層に出現しうる機密キー（ネスト対応のため `*.` プレフィックス両方を用意）
  'password',
  '*.password',
  '*.*.password',
  'passwordHash',
  '*.passwordHash',
  '*.*.passwordHash',
  'password_hash',
  '*.password_hash',
  '*.*.password_hash',
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  'api_key',
  '*.api_key',
  '*.*.api_key',
  'access_key',
  '*.access_key',
  '*.*.access_key',
  'accessKey',
  '*.accessKey',
  '*.*.accessKey',
  'secret',
  '*.secret',
  '*.*.secret',
  'token',
  '*.token',
  '*.*.token',
  'kdpCredentials',
  '*.kdpCredentials',
  'kdp_credentials',
  '*.kdp_credentials',
  'kdp_credentials_enc',
  '*.kdp_credentials_enc',
  'authorization',
  '*.authorization',
  'Authorization',
  '*.Authorization',
  'cookie',
  '*.cookie',
  'Cookie',
  '*.Cookie',
  'set-cookie',
  '*.set-cookie',
  // HTTP 慣例: headers.*
  'headers.authorization',
  'headers.cookie',
  'headers.Authorization',
  'headers.Cookie',
  'headers.set-cookie',
];

function buildOptions(): LoggerOptions {
  const level = process.env.LOG_LEVEL ?? 'info';
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';

  const base: LoggerOptions = {
    level,
    base: {
      service: process.env.SERVICE_NAME ?? 'a2p',
      env: nodeEnv,
    },
    // JSON 出力時、ISO タイムスタンプを `time` として埋める
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: REDACT_PATHS,
      censor: '***',
      remove: false,
    },
  };

  if (!isProd) {
    base.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: false,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    };
  }

  return base;
}

let rootLogger: Logger | null = null;

function getRootLogger(): Logger {
  if (rootLogger) return rootLogger;
  rootLogger = pino(buildOptions());
  return rootLogger;
}

/**
 * 名前付き child logger を返す。
 * `name` は `<domain>.<entity>.<action>` のドット表記推奨（docs/05 §5 申し送り）。
 */
export function createLogger(name: string): Logger {
  return getRootLogger().child({ name });
}

/**
 * 既定ルートロガー。アプリ層では極力 `createLogger(name)` を使う。
 * （シリアライズが必要な場合のフォールバック用に export）
 */
export const logger: Logger = getRootLogger();

/** テスト用途: 環境変数を入れ替えた後にルートロガーを再構築する。 */
export function _resetRootLoggerForTests(): void {
  rootLogger = null;
}

export type { Logger } from 'pino';
