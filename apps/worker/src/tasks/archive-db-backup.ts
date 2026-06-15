import { execFile } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { promisify } from 'node:util';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { JobHelpers, Task } from 'graphile-worker';

import { ConfigError, ProviderError, StorageError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { buildDbBackupFailedEmail, sendEmail } from '@a2p/notify';
import { dbBackup, uploadBuffer, type UploadResult } from '@a2p/storage';

const execFileAsync = promisify(execFile);

/**
 * `archive.db.backup` タスク (T-01-12, R-12)
 *
 * 週次の Postgres ダンプを R2 に退避する。Railway 障害時に R2 から復元できるよう、
 * `DATABASE_URL` を `pg_dump` に渡し、gzip 圧縮した SQL を `archive/db/{yyyy-mm-dd}.sql.gz`
 * として保存する。R2 キー生成は `packages/storage` の `dbBackup()` に集約 (docs/05 §13 #7)。
 *
 * 失敗時は logger.error と Resend (db-backup-failed テンプレ) で運営者へ通知し、例外を
 * throw して graphile-worker のリトライ機構 (max_attempts=3) に委譲する。
 */

export const ARCHIVE_DB_BACKUP_TASK_NAME = 'archive.db.backup';

/** 内部用: `Date` から YMD (UTC) を返してから `dbBackup()` に渡す。 */
export function archiveDbBackupKeyForDate(date: Date = new Date()): string {
  return dbBackup(formatYmd(date));
}

function formatYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface ArchiveDbBackupDeps {
  /** pg_dump 実行を差し替えるためのフック。テストで in-memory に SQL を返すために使う。 */
  pgDump?: (databaseUrl: string) => Promise<Buffer>;
  /** R2 アップロードを差し替えるためのフック。 */
  upload?: (key: string, body: Buffer, contentType: string) => Promise<UploadResult>;
  /** メール送信を差し替えるためのフック。 */
  notifyFailure?: (params: {
    occurredAt: string;
    reason: string;
    attempt: number;
    maxAttempts: number;
  }) => Promise<void>;
  /** ロガー差し替え。 */
  logger?: Logger;
  /** バックアップキー算出に使う基準時刻。テストで固定。 */
  now?: () => Date;
  /** `DATABASE_URL` 差し替え。本番では `process.env.DATABASE_URL`。 */
  databaseUrl?: string;
  /** graphile-worker の `max_attempts` を通知文に含めるため。 */
  maxAttempts?: number;
  /** 現在の試行回数 (graphile-worker `attempts` 由来、1-origin)。 */
  attempt?: number;
}

/**
 * 本体。graphile-worker から呼ばれるのは下の `archiveDbBackupTask` (Task 互換)。
 * テストはこの関数を直接呼ぶ。
 */
export async function runArchiveDbBackup(
  deps: ArchiveDbBackupDeps = {},
): Promise<{ key: string; size: number; sha256: string }> {
  const log = deps.logger ?? createLogger(`worker.${ARCHIVE_DB_BACKUP_TASK_NAME}`);
  const now = deps.now?.() ?? new Date();
  const databaseUrl = deps.databaseUrl ?? process.env.DATABASE_URL;
  const maxAttempts = deps.maxAttempts ?? 3;
  const attempt = deps.attempt ?? 1;

  if (!databaseUrl) {
    throw new ConfigError('DATABASE_URL が未設定です: archive.db.backup を実行できません', {
      details: { missing: ['DATABASE_URL'] },
    });
  }

  const key = archiveDbBackupKeyForDate(now);
  log.info({ task: ARCHIVE_DB_BACKUP_TASK_NAME, key, attempt, maxAttempts }, 'db backup start');

  try {
    const dumpBuf = deps.pgDump
      ? await deps.pgDump(databaseUrl)
      : await runPgDump(databaseUrl);
    const gz = await gzipBuffer(dumpBuf);
    const uploader = deps.upload ?? defaultUploader;
    const result = await uploader(key, gz, 'application/gzip');
    log.info(
      {
        task: ARCHIVE_DB_BACKUP_TASK_NAME,
        key: result.key,
        size: result.size,
        sha256: result.sha256,
      },
      'db backup uploaded to R2',
    );
    return { key: result.key, size: result.size, sha256: result.sha256 };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(
      {
        task: ARCHIVE_DB_BACKUP_TASK_NAME,
        key,
        attempt,
        maxAttempts,
        err,
      },
      'db backup failed',
    );
    const notifier = deps.notifyFailure ?? defaultNotifyFailure;
    try {
      await notifier({
        occurredAt: now.toISOString(),
        reason,
        attempt,
        maxAttempts,
      });
    } catch (notifyErr) {
      log.error(
        { task: ARCHIVE_DB_BACKUP_TASK_NAME, notifyErr },
        'failed to send db-backup-failed notification',
      );
    }
    throw err;
  }
}

export const archiveDbBackupTask: Task = async (_payload: unknown, helpers: JobHelpers) => {
  // graphile-worker の `attempts` は完了済み試行回数。今回の試行は +1。
  const attempt = helpers.job.attempts + 1;
  const maxAttempts = helpers.job.max_attempts;
  await runArchiveDbBackup({ attempt, maxAttempts });
};

// ---------------------------------------------------------------------------
// internals (実機実行用) — テストではすべて DI で差し替える
// ---------------------------------------------------------------------------

async function runPgDump(databaseUrl: string): Promise<Buffer> {
  try {
    // -Fp: plain SQL / -Z 0: 圧縮なし (本コードで gzip する) / --no-owner --no-privileges:
    // 復元時の権限差異を吸収。`--dbname=` で接続文字列を渡す。
    //
    // セキュリティ補足: `execFile` 引数渡しのため shell injection は防げるが、`--dbname=`
    // の argv は `ps aux` 経由で同一ホスト上の他プロセスから見える点に留意。A2P は
    // シングルテナント (Railway 上の 1 worker 1 プロジェクト) 前提のため許容するが、
    // 将来マルチホスト/マルチテナント化する際は `PGPASSWORD` env 経由 + `-h -U -d` 分離に
    // 切り替えること (再評価フラグ)。
    const { stdout } = await execFileAsync(
      'pg_dump',
      ['-Fp', '-Z', '0', '--no-owner', '--no-privileges', `--dbname=${databaseUrl}`],
      {
        // SQL ダンプは数百 MB に達しうるが、Railway Worker の RAM 制約を踏まえ
        // 512 MB を上限とする。超過時は Phase 2 でストリーミング実装に切替。
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'buffer',
      },
    );
    return stdout as unknown as Buffer;
  } catch (err) {
    throw new ProviderError('pg_dump 実行に失敗しました', {
      details: { command: 'pg_dump' },
      cause: err,
    });
  }
}

async function gzipBuffer(input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  await pipeline(Readable.from(input), createGzip(), writable);
  return Buffer.concat(chunks);
}

async function defaultUploader(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<UploadResult> {
  try {
    return await uploadBuffer(key, body, contentType);
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError('R2 への DB バックアップアップロードに失敗しました', {
      details: { key },
      cause: err,
    });
  }
}

async function defaultNotifyFailure(args: {
  occurredAt: string;
  reason: string;
  attempt: number;
  maxAttempts: number;
}): Promise<void> {
  const built = buildDbBackupFailedEmail(args);
  await sendEmail({ subject: built.subject, react: built.react });
}
