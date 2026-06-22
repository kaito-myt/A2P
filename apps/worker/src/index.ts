import { Agent, setGlobalDispatcher } from 'undici';

import { parseEnv } from '@a2p/contracts/env';
import { createLogger } from '@a2p/contracts/logger';

import { installGracefulShutdown, startRunner } from './runner.js';

// LLM の長文生成 (例: 全章一括校閲 / 長い章本文) は、応答ヘッダ到達まで undici 既定の
// headersTimeout=300s を超えることがあり "Headers Timeout Error" で失敗する。
// worker プロセス全体の fetch (Anthropic/OpenAI/Google SDK が利用) のタイムアウトを
// 15 分へ延長する。これは起動時の副作用として最初に適用する。
setGlobalDispatcher(
  new Agent({
    headersTimeout: 15 * 60_000,
    bodyTimeout: 15 * 60_000,
    connectTimeout: 60_000,
  }),
);

/**
 * apps/worker のプロセスエントリ。
 *
 * - 起動直後に env 検証 (`parseEnv`)。未設定があれば `process.exit(1)`
 * - graphile-worker runner を起動
 * - SIGTERM / SIGINT で graceful shutdown
 * - runner.promise の終了 (= worker pool 終了) でプロセス終了
 */

// テスト用途で main を import したいときに副作用を起こさないよう、CLI 起動条件を明示する。
// tsx で直接実行された場合のみ main() を呼ぶ。
const isDirectInvocation = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  // tsx は ts ファイルを直接受け取るため、basename で判定
  return entry.endsWith('/index.ts') || entry.endsWith('\\index.ts') || entry.endsWith('/index.js') || entry.endsWith('\\index.js');
})();

export async function main(): Promise<void> {
  const env = parseEnv();
  const log = createLogger('worker.main');
  log.info(
    {
      nodeEnv: env.NODE_ENV,
      bookConcurrency: env.WORKER_BOOK_CONCURRENCY,
      chapterConcurrency: env.WORKER_CHAPTER_CONCURRENCY,
    },
    'worker boot',
  );

  const runner = await startRunner({
    connectionString: env.DATABASE_URL,
    bookConcurrency: env.WORKER_BOOK_CONCURRENCY,
    chapterConcurrency: env.WORKER_CHAPTER_CONCURRENCY,
    logger: log,
  });

  installGracefulShutdown(runner, log);

  try {
    await runner.promise;
    log.info('worker pool finished');
  } catch (err) {
    log.error({ err }, 'worker pool exited with error');
    process.exit(1);
  }
}

if (isDirectInvocation) {
  main().catch((err: unknown) => {
    // parseEnv は exit(1) するが、念のため fallback

    console.error('[worker] fatal:', err);
    process.exit(1);
  });
}
