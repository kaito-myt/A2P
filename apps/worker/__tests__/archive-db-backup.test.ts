import { gunzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { ConfigError } from '@a2p/contracts/errors';
import type { Logger } from '@a2p/contracts/logger';

import {
  ARCHIVE_DB_BACKUP_TASK_NAME,
  archiveDbBackupKeyForDate,
  runArchiveDbBackup,
  type ArchiveDbBackupDeps,
} from '../src/tasks/archive-db-backup.js';

type NotifyFailureFn = NonNullable<ArchiveDbBackupDeps['notifyFailure']>;
type PgDumpFn = NonNullable<ArchiveDbBackupDeps['pgDump']>;
type UploadFn = NonNullable<ArchiveDbBackupDeps['upload']>;

function makeLogger() {
  const calls: Array<{ level: 'info' | 'warn' | 'error'; obj: Record<string, unknown>; msg: string }> = [];
  const mk = (level: 'info' | 'warn' | 'error') => (obj: Record<string, unknown>, msg?: string) => {
    calls.push({ level, obj, msg: msg ?? '' });
  };
  const logger = {
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  return { logger, calls };
}

describe('archive.db.backup', () => {
  it('task identifier が docs/05 §5.4 (R-12 緩和) と一致する', () => {
    expect(ARCHIVE_DB_BACKUP_TASK_NAME).toBe('archive.db.backup');
  });

  it('R2 キー規約: archive/db/{yyyy-mm-dd}.sql.gz (packages/storage/dbBackup 委譲)', () => {
    const key = archiveDbBackupKeyForDate(new Date(Date.UTC(2026, 4, 23, 18, 0, 0)));
    expect(key).toBe('archive/db/2026-05-23.sql.gz');
  });

  it('DATABASE_URL 未設定なら ConfigError', async () => {
    const { logger } = makeLogger();
    await expect(
      runArchiveDbBackup({
        logger,
        databaseUrl: undefined,
        // 通知も dump も到達しないことを担保
        pgDump: vi.fn<PgDumpFn>(),
        upload: vi.fn<UploadFn>(),
        notifyFailure: vi.fn<NotifyFailureFn>(),
        now: () => new Date(Date.UTC(2026, 4, 23)),
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('pg_dump → gzip → uploader の順で呼び出し、UploadResult を返す', async () => {
    const { logger, calls } = makeLogger();
    const dumpSql = Buffer.from(
      '-- PostgreSQL database dump\nCREATE TABLE foo(id int);\nINSERT INTO foo VALUES (1);\n',
      'utf8',
    );
    const pgDump = vi.fn(async () => dumpSql);
    const upload = vi.fn(async (key: string, body: Buffer, contentType: string) => ({
      key,
      sha256: 'abc'.padEnd(64, '0'),
      size: body.byteLength,
      contentType,
    }));
    const notifyFailure = vi.fn<NotifyFailureFn>();

    const result = await runArchiveDbBackup({
      logger,
      databaseUrl: 'postgresql://u:p@h:5432/db',
      pgDump,
      upload,
      notifyFailure,
      now: () => new Date(Date.UTC(2026, 4, 24, 18, 0, 0)),
      attempt: 1,
      maxAttempts: 3,
    });

    expect(pgDump).toHaveBeenCalledWith('postgresql://u:p@h:5432/db');
    expect(upload).toHaveBeenCalledTimes(1);
    const uploadCall = upload.mock.calls[0]!;
    expect(uploadCall[0]).toBe('archive/db/2026-05-24.sql.gz');
    expect(uploadCall[2]).toBe('application/gzip');

    // gzip 復号して元 SQL が復元できることを確認
    const decompressed = gunzipSync(uploadCall[1]);
    expect(decompressed.toString('utf8')).toBe(dumpSql.toString('utf8'));

    expect(result.key).toBe('archive/db/2026-05-24.sql.gz');
    expect(result.size).toBeGreaterThan(0);
    expect(notifyFailure).not.toHaveBeenCalled();

    // ログに start と uploaded が出る
    const messages = calls.map((c) => c.msg);
    expect(messages.some((m) => m.includes('start'))).toBe(true);
    expect(messages.some((m) => m.includes('uploaded'))).toBe(true);
  });

  it('upload 失敗時は notifier を呼び、その後に再 throw する', async () => {
    const { logger, calls } = makeLogger();
    const uploadErr = new Error('R2 5xx');
    const upload = vi.fn<UploadFn>(async () => {
      throw uploadErr;
    });
    const notifyFailure = vi.fn<NotifyFailureFn>(async () => {});

    await expect(
      runArchiveDbBackup({
        logger,
        databaseUrl: 'postgresql://u:p@h:5432/db',
        pgDump: vi.fn(async () => Buffer.from('DUMP', 'utf8')),
        upload,
        notifyFailure,
        now: () => new Date(Date.UTC(2026, 4, 24, 18, 0, 0)),
        attempt: 2,
        maxAttempts: 3,
      }),
    ).rejects.toThrow('R2 5xx');

    expect(notifyFailure).toHaveBeenCalledTimes(1);
    const notifyArgs = notifyFailure.mock.calls[0]![0]!;
    expect(notifyArgs.reason).toContain('R2 5xx');
    expect(notifyArgs.attempt).toBe(2);
    expect(notifyArgs.maxAttempts).toBe(3);
    expect(notifyArgs.occurredAt).toBe('2026-05-24T18:00:00.000Z');

    // 失敗ログが出る
    const errorLogs = calls.filter((c) => c.level === 'error');
    expect(errorLogs.length).toBeGreaterThanOrEqual(1);
    expect(errorLogs.some((c) => c.msg.includes('failed'))).toBe(true);
  });

  it('pg_dump 失敗時も notifier を呼ぶ', async () => {
    const { logger } = makeLogger();
    const notifyFailure = vi.fn<NotifyFailureFn>(async () => {});
    await expect(
      runArchiveDbBackup({
        logger,
        databaseUrl: 'postgresql://u:p@h:5432/db',
        pgDump: vi.fn<PgDumpFn>(async () => {
          throw new Error('pg_dump: connection refused');
        }),
        upload: vi.fn<UploadFn>(),
        notifyFailure,
        now: () => new Date(Date.UTC(2026, 4, 24)),
      }),
    ).rejects.toThrow('pg_dump: connection refused');
    expect(notifyFailure).toHaveBeenCalledTimes(1);
  });

  it('notifier 失敗は元例外を覆い隠さない', async () => {
    const { logger, calls } = makeLogger();
    await expect(
      runArchiveDbBackup({
        logger,
        databaseUrl: 'postgresql://u:p@h:5432/db',
        pgDump: vi.fn<PgDumpFn>(async () => {
          throw new Error('primary failure');
        }),
        upload: vi.fn<UploadFn>(),
        notifyFailure: vi.fn<NotifyFailureFn>(async () => {
          throw new Error('mail failed too');
        }),
        now: () => new Date(Date.UTC(2026, 4, 24)),
      }),
    ).rejects.toThrow('primary failure');
    // mail 失敗もログに残る
    expect(calls.some((c) => c.level === 'error' && c.msg.includes('notification'))).toBe(true);
  });
});
