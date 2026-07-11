import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `org.ops.watch` タスク (docs/06 §8-4) — 運用本部の横断監視。
 *
 * 制作パイプラインの Job を走査し、
 *  - 失敗ジョブ（リトライ余地あり）→ `recover_job`(approved) を起票（dispatcher が自動再投入）
 *  - リトライ上限到達 or 長時間スタックの running → `triage_error`(needs_human) を起票（人手判断）
 * を全社ToDoバックログに追加する。
 *
 * 暴走防止: 1 book につき開いている sysops タスクがあれば重複起票しない。1 回の起票上限あり。
 * cron（既定OFF）＋ web からの手動起動。
 */

export const ORG_OPS_WATCH_TASK_NAME = 'org.ops.watch';

/** 失敗ジョブを recover と判定する retries 上限（超えたら人手 triage）。 */
const MAX_RECOVER_RETRIES = 3;
/** running のままこの分数を超えたらスタックとみなす。 */
const STUCK_MINUTES = 30;
/** 1 回の watch で起票する ops タスクの上限。 */
const MAX_OPS_TASKS_PER_RUN = 10;
/** 失敗ジョブの検出ウィンドウ（時間）。 */
const FAILED_LOOKBACK_HOURS = 24;

const OPEN_STATUSES = ['proposed', 'approved', 'in_progress', 'blocked', 'needs_human'];

export const OrgOpsWatchPayloadSchema = z.object({
  job_id: z.string().min(1).optional(),
  trigger: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

interface WatchJobRow {
  id: string;
  book_id: string | null;
  kind: string;
  status: string;
  retries: number;
  error: string | null;
  started_at: Date | null;
  created_at: Date;
}

export interface OrgOpsWatchPrisma {
  job: {
    findMany: (args: {
      where: {
        kind: { startsWith: string };
        OR: Array<Record<string, unknown>>;
      };
      select: {
        id: true;
        book_id: true;
        kind: true;
        status: true;
        retries: true;
        error: true;
        started_at: true;
        created_at: true;
      };
      orderBy: { created_at: 'desc' };
      take: number;
    }) => Promise<WatchJobRow[]>;
    update?: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
  orgTask: {
    findMany: (args: {
      where: { division: string; status: { in: string[] }; kind: { in: string[] } };
      select: { book_id: true };
    }) => Promise<Array<{ book_id: string | null }>>;
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
}

export interface OrgOpsWatchDeps {
  prisma?: OrgOpsWatchPrisma;
  logger?: Logger;
  now?: () => Date;
}

export interface OrgOpsWatchResult {
  scanned: number;
  recover_created: number;
  triage_created: number;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function runOrgOpsWatch(payload: unknown, deps: OrgOpsWatchDeps = {}): Promise<OrgOpsWatchResult> {
  const parsed = OrgOpsWatchPayloadSchema.safeParse(payload ?? {});
  const jobId = parsed.success ? parsed.data.job_id : undefined;
  const limit = (parsed.success && parsed.data.limit) || MAX_OPS_TASKS_PER_RUN;

  const log = deps.logger ?? createLogger(`worker.${ORG_OPS_WATCH_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as OrgOpsWatchPrisma);
  const now = deps.now ?? (() => new Date());

  const result: OrgOpsWatchResult = { scanned: 0, recover_created: 0, triage_created: 0 };

  try {
    const nowTs = now();
    const failedSince = new Date(nowTs.getTime() - FAILED_LOOKBACK_HOURS * 3600_000);
    const stuckBefore = new Date(nowTs.getTime() - STUCK_MINUTES * 60_000);

    const jobs = await prisma.job.findMany({
      where: {
        kind: { startsWith: 'pipeline.book.' },
        OR: [
          { status: 'failed', created_at: { gte: failedSince } },
          { status: 'running', started_at: { lt: stuckBefore } },
        ],
      },
      select: {
        id: true,
        book_id: true,
        kind: true,
        status: true,
        retries: true,
        error: true,
        started_at: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    result.scanned = jobs.length;

    // 既に開いている sysops(recover/triage) タスクの book を集めて重複起票を防ぐ。
    const openOps = await prisma.orgTask.findMany({
      where: { division: 'sysops', status: { in: OPEN_STATUSES }, kind: { in: ['recover_job', 'triage_error'] } },
      select: { book_id: true },
    });
    const covered = new Set(openOps.map((t) => t.book_id).filter((x): x is string => !!x));

    // book 単位に集約（最進捗の失敗/スタックを代表に）。
    const byBook = new Map<string, WatchJobRow>();
    for (const j of jobs) {
      if (!j.book_id) continue;
      const prev = byBook.get(j.book_id);
      if (!prev || j.created_at > prev.created_at) byBook.set(j.book_id, j);
    }

    let created = 0;
    for (const [bookId, rep] of byBook) {
      if (created >= limit) break;
      if (covered.has(bookId)) continue;

      const stuck = rep.status === 'running';
      const retriable = !stuck && rep.retries < MAX_RECOVER_RETRIES;
      const kind = retriable ? 'recover_job' : 'triage_error';
      const status = retriable ? 'approved' : 'needs_human';
      const assignee = retriable ? 'ops_worker' : 'human';
      const errSnippet = (rep.error ?? (stuck ? `${STUCK_MINUTES}分以上 running のままスタック` : '(詳細不明)')).slice(0, 500);
      const title = retriable
        ? `復旧: ${rep.kind} 失敗ジョブを再投入`
        : `要調査: ${rep.kind} が${stuck ? 'スタック' : `リトライ上限(${MAX_RECOVER_RETRIES})到達`}`;
      const instruction = [
        `対象書籍のパイプライン ${rep.kind} が ${stuck ? 'スタック(running)' : `失敗(retries=${rep.retries})`}。`,
        retriable
          ? '最進捗の失敗ステップを再投入して復旧する。'
          : '自動復旧の範囲を超過。原因（コスト停止/データ不整合/外部API）を調査し人手で判断する。',
        '',
        `失敗ジョブ: ${rep.id} (${rep.kind})`,
        `エラー: ${errSnippet}`,
      ].join('\n');

      await prisma.orgTask.create({
        data: {
          division: 'sysops',
          book_id: bookId,
          owner_role: 'ops_mgr',
          assignee_role: assignee,
          kind,
          title,
          instruction,
          status,
          priority: 'should',
        },
      });
      created += 1;
      covered.add(bookId);
      if (retriable) result.recover_created += 1;
      else result.triage_created += 1;
    }

    if (jobId && prisma.job.update) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', finished_at: now(), error: null, result_json: result },
      });
    }
    log.info({ task: ORG_OPS_WATCH_TASK_NAME, ...result }, 'org.ops.watch done');
    return result;
  } catch (err) {
    if (jobId && prisma.job.update) {
      try {
        await prisma.job.update({
          where: { id: jobId },
          data: { status: 'failed', finished_at: now(), error: serializeError(err) },
        });
      } catch {
        // best-effort
      }
    }
    throw err;
  }
}

export const orgOpsWatchTask: Task = async (payload: unknown, _helpers: JobHelpers) => {
  await runOrgOpsWatch(payload);
};
