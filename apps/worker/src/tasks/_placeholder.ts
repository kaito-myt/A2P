import type { JobHelpers, Task } from 'graphile-worker';

import { createLogger } from '@a2p/contracts/logger';

/**
 * placeholder タスクファクトリ (SP-01 T-01-12 範囲)
 *
 * docs/05 §2 で列挙されているタスクのうち、SP-01 では雛形のみ用意し、本実装は後続スプリント
 * (SP-02 以降) で個別タスクファイルを置き換える。
 *
 * 雛形の責務:
 *   - taskList への登録ができる (`buildTaskList()` から参照可能)
 *   - 起動ログ (`task placeholder`) を child logger で出力
 *   - payload は型検証しない (本実装時に zod schema 追加)
 *
 * 本実装で各ファイルが置き換わったら placeholder を import から外し、`taskList` 配下の登録も
 * 本実装版に差し替えること。
 */
export function definePlaceholderTask(taskName: string): Task {
  return async (_payload: unknown, _helpers: JobHelpers) => {
    const log = createLogger(`worker.${taskName}`);
    log.info({ task: taskName }, 'task placeholder (SP-01: 後続スプリントで本実装)');
  };
}
