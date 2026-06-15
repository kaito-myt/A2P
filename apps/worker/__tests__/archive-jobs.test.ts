import { gunzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@a2p/contracts/logger';

import {
  ARCHIVE_JOBS_TASK_NAME,
  runArchiveJobs,
  type ArchiveJobsDeps,
  type ArchiveJobsPrisma,
  type JobRow,
} from '../src/tasks/archive-jobs.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  const calls: Array<{ level: 'info' | 'warn' | 'error'; obj: Record<string, unknown>; msg: string }> = [];
  const mk = (level: 'info' | 'warn' | 'error') =>
    (obj: Record<string, unknown>, msg?: string) => {
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

type UploadFn = NonNullable<ArchiveJobsDeps['upload']>;

function makeRow(id: string, createdAt: Date): JobRow {
  return {
    id,
    graphile_job_id: null,
    kind: 'pipeline.book.kickoff',
    book_id: null,
    parent_job_id: null,
    status: 'done',
    payload_json: { test: true },
    result_json: null,
    error: null,
    retries: 0,
    started_at: null,
    finished_at: null,
    created_at: createdAt,
  };
}

/**
 * 100 行の古い Job 行を作る。created_at は 120 日前 (retention 90 日を超える)。
 * 2 ヶ月にまたがって 50 行ずつ用意する。
 */
function make100OldRows(now: Date): JobRow[] {
  const rows: JobRow[] = [];
  // 120 日前の月と 150 日前の月に 50 行ずつ
  for (let i = 0; i < 50; i++) {
    const d = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000);
    rows.push(makeRow(`old-120-${i}`, d));
  }
  for (let i = 0; i < 50; i++) {
    const d = new Date(now.getTime() - 150 * 24 * 60 * 60 * 1000);
    rows.push(makeRow(`old-150-${i}`, d));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('archive.jobs', () => {
  it('task identifier が docs/05 §5.3.18 と一致する', () => {
    expect(ARCHIVE_JOBS_TASK_NAME).toBe('archive.jobs');
  });

  it('(1) 100 行の古い Job → R2 gzip PUT + DB 削除', async () => {
    const { logger, calls } = makeLogger();
    const now = new Date('2026-06-04T12:00:00Z');
    const oldRows = make100OldRows(now);

    // 2 ヶ月にまたがるので upload は 2 回呼ばれる
    const upload = vi.fn<UploadFn>(async (key, body, contentType) => ({
      key,
      sha256: 'a'.repeat(64),
      size: body.byteLength,
      contentType,
    }));

    const deleteMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({
      count: where.id.in.length,
    }));

    const prisma: ArchiveJobsPrisma = {
      appSettings: {
        findUnique: vi.fn(async () => ({ job_log_retention_days: 90 })),
      },
      job: {
        findMany: vi.fn(async () => oldRows),
        deleteMany,
      },
    };

    const result = await runArchiveJobs({ prisma, logger, now: () => now, upload });

    // 2 ヶ月分なので upload は 2 回
    expect(upload).toHaveBeenCalledTimes(2);

    // R2 キーが正しい形式
    const uploadedKeys = upload.mock.calls.map((c) => c[0]);
    expect(uploadedKeys.every((k) => /^archive\/jobs\/\d{4}-\d{2}\.jsonl\.gz$/.test(k))).toBe(true);

    // content-type が gzip
    for (const call of upload.mock.calls) {
      expect(call[2]).toBe('application/gzip');
    }

    // gzip 展開して JSONL が正しい構造か確認 (1 件目の call)
    const firstGz = upload.mock.calls[0]![1];
    const jsonl = gunzipSync(firstGz).toString('utf8');
    const parsed = jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(parsed.length).toBe(50);
    expect(parsed[0]).toHaveProperty('id');
    expect(parsed[0]).toHaveProperty('kind');
    expect(parsed[0]).toHaveProperty('created_at');

    // DB 削除が呼ばれた (100 件)
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const deletedIds = deleteMany.mock.calls[0]![0].where.id.in;
    expect(deletedIds).toHaveLength(100);

    // 結果に件数が入っている
    expect(result.archivedCount).toBe(100);
    expect(result.deletedCount).toBe(100);
    expect(result.keys).toHaveLength(2);

    // ログ: 完了ログに deletedCount が含まれる
    const completedLog = calls.find((c) => c.msg.includes('completed'));
    expect(completedLog).toBeDefined();
    expect(completedLog!.obj).toMatchObject({ deletedCount: 100, archivedCount: 100 });
  });

  it('(2) 保持期間内の行は削除されない', async () => {
    const { logger } = makeLogger();
    const now = new Date('2026-06-04T12:00:00Z');
    // 30 日前 → retention 90 日以内なので対象外
    const recentRows: JobRow[] = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      recentRows.push(makeRow(`recent-${i}`, d));
    }

    const upload = vi.fn<UploadFn>();
    const deleteMany = vi.fn();

    const prisma: ArchiveJobsPrisma = {
      appSettings: {
        findUnique: vi.fn(async () => ({ job_log_retention_days: 90 })),
      },
      job: {
        // findMany に渡す where.created_at.lt を検証するため空配列を返す
        // (実際の DB フィルタはテスト外; ここでは保持期間内行が返らないことをシミュレート)
        findMany: vi.fn(async () => []),
        deleteMany,
      },
    };

    const result = await runArchiveJobs({ prisma, logger, now: () => now, upload });

    // findMany に渡された cutoff が正しい (90 日前)
    const findManyCall = (prisma.job.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const cutoff: Date = findManyCall.where.created_at.lt;
    const expectedCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);

    // 空行なので upload も deleteMany も呼ばれない
    expect(upload).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(result.archivedCount).toBe(0);
    expect(result.deletedCount).toBe(0);
  });

  it('(3) R2 アップロード失敗 → DB 削除されない (resilience)', async () => {
    const { logger } = makeLogger();
    const now = new Date('2026-06-04T12:00:00Z');
    const oldRows = [makeRow('old-1', new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000))];

    const upload = vi.fn<UploadFn>(async () => {
      throw new Error('R2 network error');
    });

    const deleteMany = vi.fn();

    const prisma: ArchiveJobsPrisma = {
      appSettings: {
        findUnique: vi.fn(async () => ({ job_log_retention_days: 90 })),
      },
      job: {
        findMany: vi.fn(async () => oldRows),
        deleteMany,
      },
    };

    // R2 失敗は throw されるはず
    await expect(runArchiveJobs({ prisma, logger, now: () => now, upload })).rejects.toThrow(
      'R2 network error',
    );

    // DB 削除は呼ばれていない
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('(4) 削除件数が logger.info に記録される', async () => {
    const { logger, calls } = makeLogger();
    const now = new Date('2026-06-04T12:00:00Z');
    const oldRows = [
      makeRow('old-a', new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000)),
      makeRow('old-b', new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000)),
      makeRow('old-c', new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000)),
    ];

    const upload = vi.fn<UploadFn>(async (key, body, contentType) => ({
      key,
      sha256: 'b'.repeat(64),
      size: body.byteLength,
      contentType,
    }));

    const prisma: ArchiveJobsPrisma = {
      appSettings: {
        findUnique: vi.fn(async () => ({ job_log_retention_days: 90 })),
      },
      job: {
        findMany: vi.fn(async () => oldRows),
        deleteMany: vi.fn(async () => ({ count: 3 })),
      },
    };

    await runArchiveJobs({ prisma, logger, now: () => now, upload });

    // 完了ログに deletedCount: 3 が含まれる
    const infos = calls.filter((c) => c.level === 'info');
    const completedLog = infos.find((c) => c.obj.deletedCount !== undefined);
    expect(completedLog).toBeDefined();
    expect(completedLog!.obj.deletedCount).toBe(3);
    expect(completedLog!.obj.archivedCount).toBe(3);
  });

  it('AppSettings が存在しない場合はデフォルト 90 日を使用する', async () => {
    const { logger } = makeLogger();
    const now = new Date('2026-06-04T12:00:00Z');

    const prisma: ArchiveJobsPrisma = {
      appSettings: {
        findUnique: vi.fn(async () => null),
      },
      job: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(),
      },
    };

    await runArchiveJobs({ prisma, logger, now: () => now, upload: vi.fn() });

    const findManyCall = (prisma.job.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const cutoff: Date = findManyCall.where.created_at.lt;
    const expectedCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);
  });

  it('bigint graphile_job_id が文字列にシリアライズされる', async () => {
    const { logger } = makeLogger();
    const now = new Date('2026-06-04T12:00:00Z');
    const rowWithBigInt: JobRow = {
      ...makeRow('bigint-row', new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000)),
      graphile_job_id: BigInt('9007199254740993'), // > Number.MAX_SAFE_INTEGER
    };

    const upload = vi.fn<UploadFn>(async (key, body, contentType) => ({
      key,
      sha256: 'c'.repeat(64),
      size: body.byteLength,
      contentType,
    }));

    const prisma: ArchiveJobsPrisma = {
      appSettings: {
        findUnique: vi.fn(async () => ({ job_log_retention_days: 90 })),
      },
      job: {
        findMany: vi.fn(async () => [rowWithBigInt]),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
    };

    await runArchiveJobs({ prisma, logger, now: () => now, upload });

    const gz = upload.mock.calls[0]![1];
    const line = gunzipSync(gz).toString('utf8').trim();
    const parsed = JSON.parse(line);
    // bigint は文字列になっている (JSON.parse で精度ロスなし)
    expect(parsed.graphile_job_id).toBe('9007199254740993');
  });
});
