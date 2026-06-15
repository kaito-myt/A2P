import { createGzip } from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { jobsArchive, uploadBuffer, type UploadResult } from '@a2p/storage';

/**
 * `archive.jobs` タスク (T-09-04, docs/05 §5.3.18)
 *
 * 週次 (毎週日曜 03:00 JST = 土曜 18:00 UTC) に実行。
 * `Job` テーブルの `created_at < now() - retention_days` な行を JSONL + gzip で R2 に退避し、
 * 退避成功後に DB から削除する。
 *
 * 安全性: R2 書き込みが失敗した場合は DB 削除を一切行わない (archive-then-delete 順序)。
 * 月ごとに `archive/jobs/{yyyy-mm}.jsonl.gz` を生成する。
 */

export const ARCHIVE_JOBS_TASK_NAME = 'archive.jobs';

export const ArchiveJobsPayloadSchema = z.object({});
export type ArchiveJobsPayload = z.infer<typeof ArchiveJobsPayloadSchema>;

const DEFAULT_RETENTION_DAYS = 90;

// ---------------------------------------------------------------------------
// Minimal Prisma subset for DI / testability
// ---------------------------------------------------------------------------

export interface JobRow {
  id: string;
  graphile_job_id: bigint | null;
  kind: string;
  book_id: string | null;
  parent_job_id: string | null;
  status: string;
  payload_json: unknown;
  result_json: unknown;
  error: string | null;
  retries: number;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

export interface ArchiveJobsPrisma {
  appSettings: {
    findUnique: (args: {
      where: { id: string };
      select: { job_log_retention_days: true };
    }) => Promise<{ job_log_retention_days: number } | null>;
  };
  job: {
    findMany: (args: {
      where: { created_at: { lt: Date } };
      orderBy: { created_at: 'asc' };
    }) => Promise<JobRow[]>;
    deleteMany: (args: {
      where: { id: { in: string[] } };
    }) => Promise<{ count: number }>;
  };
}

export interface ArchiveJobsDeps {
  prisma?: ArchiveJobsPrisma;
  logger?: Logger;
  now?: () => Date;
  upload?: (key: string, body: Buffer, contentType: string) => Promise<UploadResult>;
}

export interface ArchiveJobsResult {
  archivedCount: number;
  deletedCount: number;
  keys: string[];
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * 本体。graphile-worker から呼ばれるのは下の `archiveJobsTask`。
 * テストはこの関数を直接呼ぶ。
 */
export async function runArchiveJobs(deps: ArchiveJobsDeps = {}): Promise<ArchiveJobsResult> {
  const log = deps.logger ?? createLogger(`worker.${ARCHIVE_JOBS_TASK_NAME}`);
  const now = deps.now?.() ?? new Date();
  const uploader = deps.upload ?? defaultUploader;

  // 1. 保持日数を取得
  const prisma = deps.prisma ?? (await importDefaultPrisma());
  const settings = await prisma.appSettings.findUnique({
    where: { id: 'singleton' },
    select: { job_log_retention_days: true },
  });
  const retentionDays = settings?.job_log_retention_days ?? DEFAULT_RETENTION_DAYS;

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  log.info(
    { task: ARCHIVE_JOBS_TASK_NAME, retentionDays, cutoff: cutoff.toISOString() },
    'archive.jobs start',
  );

  // 2. 対象行を取得
  const rows = await prisma.job.findMany({
    where: { created_at: { lt: cutoff } },
    orderBy: { created_at: 'asc' },
  });

  if (rows.length === 0) {
    log.info({ task: ARCHIVE_JOBS_TASK_NAME }, 'no jobs to archive');
    return { archivedCount: 0, deletedCount: 0, keys: [] };
  }

  // 3. 月ごとにグループ化
  const byMonth = groupByMonth(rows);

  // 4. 月ごとに JSONL→gzip→R2 アップロード (失敗したら throw して DB 削除しない)
  const uploadedKeys: string[] = [];
  const allIds: string[] = [];

  for (const [ym, monthRows] of byMonth) {
    const jsonl = monthRows
      .map((r) => JSON.stringify(serializeRow(r)))
      .join('\n');
    const gz = await gzipBuffer(Buffer.from(jsonl, 'utf8'));
    const key = jobsArchive(ym);

    log.info(
      { task: ARCHIVE_JOBS_TASK_NAME, key, count: monthRows.length, sizeBytes: gz.byteLength },
      'uploading archive to R2',
    );

    // R2 失敗はそのまま throw → DB 削除には到達しない
    const result = await uploader(key, gz, 'application/gzip');

    log.info(
      { task: ARCHIVE_JOBS_TASK_NAME, key: result.key, sha256: result.sha256, size: result.size },
      'archive uploaded to R2',
    );

    uploadedKeys.push(result.key);
    for (const r of monthRows) allIds.push(r.id);
  }

  // 5. R2 書き込みが全て成功したら DB 削除
  const deleteResult = await prisma.job.deleteMany({
    where: { id: { in: allIds } },
  });

  log.info(
    {
      task: ARCHIVE_JOBS_TASK_NAME,
      deletedCount: deleteResult.count,
      archivedCount: rows.length,
      keys: uploadedKeys,
    },
    'archive.jobs completed',
  );

  return {
    archivedCount: rows.length,
    deletedCount: deleteResult.count,
    keys: uploadedKeys,
  };
}

export const archiveJobsTask: Task = async (_payload: unknown, _helpers: JobHelpers) => {
  await runArchiveJobs();
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatYm(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function groupByMonth(rows: JobRow[]): Map<string, JobRow[]> {
  const map = new Map<string, JobRow[]>();
  for (const row of rows) {
    const ym = formatYm(row.created_at);
    const existing = map.get(ym);
    if (existing) {
      existing.push(row);
    } else {
      map.set(ym, [row]);
    }
  }
  return map;
}

/** bigint → string 変換を含む安全なシリアライズ。 */
function serializeRow(row: JobRow): Record<string, unknown> {
  return {
    id: row.id,
    graphile_job_id: row.graphile_job_id !== null ? String(row.graphile_job_id) : null,
    kind: row.kind,
    book_id: row.book_id,
    parent_job_id: row.parent_job_id,
    status: row.status,
    payload_json: row.payload_json,
    result_json: row.result_json,
    error: row.error,
    retries: row.retries,
    started_at: row.started_at?.toISOString() ?? null,
    finished_at: row.finished_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
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
  return uploadBuffer(key, body, contentType);
}

// Lazy import to avoid hard dependency when deps.prisma is injected (tests).
async function importDefaultPrisma(): Promise<ArchiveJobsPrisma> {
  const { prisma } = await import('@a2p/db');
  return prisma as unknown as ArchiveJobsPrisma;
}
