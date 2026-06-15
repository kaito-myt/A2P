/**
 * graphile-worker enqueue helper for the web app (T-02-10 etc).
 *
 * Web 側から `addJob('catalog.fetch', payload)` のように呼び出すための薄い
 * ラッパ。`makeWorkerUtils` のコネクションを長寿命プロセスで再利用する。
 *
 * - Next.js dev mode のホットリロードで多重生成されないよう globalThis に保持。
 * - 呼び出し側は `enqueueJob(taskName, payload)` だけを使う。
 * - DATABASE_URL は `process.env` から直読み (env.ts は zod 経由で消費されるが
 *   SA 経路では DI せず process.env を使う既存 prisma クライアントと整合)。
 *
 * 例:
 *   await enqueueJob('catalog.fetch', { trigger: 'manual' });
 */
import {
  makeWorkerUtils,
  type WorkerUtils,
  type TaskSpec,
} from 'graphile-worker';

import { ConfigError } from '@a2p/contracts';

interface GlobalWithUtils {
  __a2pWorkerUtils?: Promise<WorkerUtils> | undefined;
}

const g = globalThis as unknown as GlobalWithUtils;

async function getUtils(): Promise<WorkerUtils> {
  if (g.__a2pWorkerUtils) return g.__a2pWorkerUtils;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.length === 0) {
    throw new ConfigError('DATABASE_URL is not set; cannot enqueue worker jobs', {
      userMessage: 'DATABASE_URL が未設定のためジョブを起動できません',
    });
  }
  const pending = makeWorkerUtils({ connectionString });
  g.__a2pWorkerUtils = pending;
  // 失敗時はキャッシュをクリアして次回再試行できるようにする
  pending.catch(() => {
    g.__a2pWorkerUtils = undefined;
  });
  return pending;
}

/**
 * 任意の task をエンキューする。
 *
 * 戻り値は graphile-worker の job id (BigInt) を文字列化したもの。
 * SA の戻り値型で扱いやすいよう string にする (BigInt は JSON 化不可)。
 */
export async function enqueueJob(
  taskName: string,
  payload: unknown = {},
  spec: TaskSpec = {},
): Promise<string> {
  const utils = await getUtils();
  const job = await utils.addJob(taskName, payload as Record<string, unknown>, spec);
  return String(job.id);
}

/**
 * テスト/シャットダウン用にプール release。通常運用では呼ばない。
 */
export async function releaseWorkerUtils(): Promise<void> {
  if (!g.__a2pWorkerUtils) return;
  const utils = await g.__a2pWorkerUtils;
  g.__a2pWorkerUtils = undefined;
  await utils.release();
}
