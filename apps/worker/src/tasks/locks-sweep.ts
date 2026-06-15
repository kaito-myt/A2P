import type { JobHelpers, Task } from 'graphile-worker';

import {
  sweepExpiredLocks,
  type BookLockDeps,
  type BookLockLogger,
} from '@a2p/agents';
import { createLogger, type Logger } from '@a2p/contracts/logger';

/**
 * `locks.sweep` タスク (T-02-07, docs/05 OQ-D-05)
 *
 * `expires_at` 超過の `book_locks` を一括削除する cron 専用タスク。
 * crontab.ts で `0 * * * *` (毎時 0 分) に発火させる。docs/05 §14 #4 で
 * 「BookLock は expires_at 自動解放」と定めたが、PostgreSQL 自体に TTL 機構は無いため
 * 本タスクが運用的な自動解放を担う。
 *
 * 失敗時は throw して graphile-worker のリトライ機構に委譲する。
 */

export const LOCKS_SWEEP_TASK_NAME = 'locks.sweep';

export interface LocksSweepDeps {
  /** 差し替え用 (テスト)。本番は `@a2p/db` のシングルトン経由 (sweepExpiredLocks 既定値)。 */
  prisma?: BookLockDeps['prisma'];
  /** ロガー差し替え。 */
  logger?: Logger;
  /** 「今」を固定するフック (テスト用)。 */
  now?: () => Date;
}

/**
 * Pino Logger を BookLockLogger 形状にアダプトする。BookLockLogger は
 * `(payload, msg?) => void` の最小サブセットだけ要求するため、Pino の
 * `info`/`warn` をそのまま渡せる。
 */
function adaptLogger(log: Logger): BookLockLogger {
  return {
    info: (payload, msg) => log.info(payload, msg),
    warn: (payload, msg) => log.warn(payload, msg),
  };
}

/** テストから直接呼べるよう Task ラッパと分離。 */
export async function runLocksSweep(
  deps: LocksSweepDeps = {},
): Promise<{ deletedCount: number }> {
  const log = deps.logger ?? createLogger(`worker.${LOCKS_SWEEP_TASK_NAME}`);
  const sweepDeps: BookLockDeps = { logger: adaptLogger(log) };
  if (deps.prisma !== undefined) sweepDeps.prisma = deps.prisma;
  if (deps.now !== undefined) sweepDeps.now = deps.now;

  log.info({ task: LOCKS_SWEEP_TASK_NAME }, 'locks sweep start');
  const result = await sweepExpiredLocks(sweepDeps);
  log.info(
    { task: LOCKS_SWEEP_TASK_NAME, deletedCount: result.deletedCount },
    'locks sweep done',
  );
  return result;
}

export const locksSweepTask: Task = async (_payload: unknown, _helpers: JobHelpers) => {
  // sweepExpiredLocks の既定 prisma (@a2p/db シングルトン) を使う。
  await runLocksSweep();
};
