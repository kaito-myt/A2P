import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { evaluateKdpPublishReadiness, type KdpReadinessThresholds } from '@a2p/contracts/org';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `org.kdp.screen` タスク (docs/06 P4 増分3) — KDP 公開の事前スクリーニング（ゲート付き）。
 *
 * publish_kdp の org_tasks について、書籍の公開レディ度を決定的に審査する:
 *  - 生成完了 / 未公開 / must コメント無し / 品質スコア≥基準 / メタデータ完備 & 価格帯内
 * すべて満たせば eligible。結果は org_tasks.result_json に記録（常に advisory）。
 *
 * ゲート `org_kdp_auto_publish_enabled`（既定OFF）が ON のときだけ、eligible な needs_human を
 * `approved`（＝公開クリア）へ前進させる。**実際の外部入稿(kdp.submit, Playwright)は Phase 3 まで
 * 人手のまま**であり、本タスクは一切公開処理を行わない（誤公開防止）。
 */

export const ORG_KDP_SCREEN_TASK_NAME = 'org.kdp.screen';

/** 1 回の審査で処理する最大タスク数。 */
const MAX_SCREEN_PER_RUN = 20;

export const OrgKdpScreenPayloadSchema = z.object({
  job_id: z.string().min(1).optional(),
  trigger: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export interface OrgKdpScreenPrisma {
  appSettings: {
    findUnique: (args: {
      where: { id: string };
      select: {
        org_kdp_auto_publish_enabled: true;
        org_kdp_min_quality: true;
        org_kdp_min_price_jpy: true;
        org_kdp_max_price_jpy: true;
      };
    }) => Promise<{
      org_kdp_auto_publish_enabled: boolean;
      org_kdp_min_quality: number;
      org_kdp_min_price_jpy: number;
      org_kdp_max_price_jpy: number;
    } | null>;
  };
  orgTask: {
    findMany: (args: {
      where: { kind: string; status: { in: string[] } };
      select: { id: true; book_id: true; status: true };
      take: number;
    }) => Promise<Array<{ id: string; book_id: string | null; status: string }>>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
  book: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true; publish_status: true; has_blocking_comments: true };
    }) => Promise<{ status: string; publish_status: string; has_blocking_comments: boolean } | null>;
  };
  evalResult: {
    findFirst: (args: {
      where: { book_id: string };
      select: { score_total: true };
      orderBy: { judged_at: 'desc' };
    }) => Promise<{ score_total: number } | null>;
  };
  kdpMetadata: {
    findUnique: (args: {
      where: { book_id: string };
      select: { price_jpy: true; description: true; keywords: true };
    }) => Promise<{ price_jpy: number | null; description: string | null; keywords: string[] } | null>;
  };
  job?: {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
}

export interface OrgKdpScreenDeps {
  prisma?: OrgKdpScreenPrisma;
  logger?: Logger;
  now?: () => Date;
}

export interface OrgKdpScreenResult {
  gate_enabled: boolean;
  screened: number;
  eligible: number;
  cleared: number;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function runOrgKdpScreen(payload: unknown, deps: OrgKdpScreenDeps = {}): Promise<OrgKdpScreenResult> {
  const parsed = OrgKdpScreenPayloadSchema.safeParse(payload ?? {});
  const jobId = parsed.success ? parsed.data.job_id : undefined;
  const limit = (parsed.success && parsed.data.limit) || MAX_SCREEN_PER_RUN;

  const log = deps.logger ?? createLogger(`worker.${ORG_KDP_SCREEN_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as OrgKdpScreenPrisma);
  const now = deps.now ?? (() => new Date());

  const result: OrgKdpScreenResult = { gate_enabled: false, screened: 0, eligible: 0, cleared: 0 };

  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: 'singleton' },
      select: {
        org_kdp_auto_publish_enabled: true,
        org_kdp_min_quality: true,
        org_kdp_min_price_jpy: true,
        org_kdp_max_price_jpy: true,
      },
    });
    const gateEnabled = settings?.org_kdp_auto_publish_enabled ?? false;
    result.gate_enabled = gateEnabled;
    const thresholds: KdpReadinessThresholds = {
      min_quality: settings?.org_kdp_min_quality ?? 70,
      min_price_jpy: settings?.org_kdp_min_price_jpy ?? 250,
      max_price_jpy: settings?.org_kdp_max_price_jpy ?? 1250,
    };

    const tasks = await prisma.orgTask.findMany({
      where: { kind: 'publish_kdp', status: { in: ['needs_human', 'approved'] } },
      select: { id: true, book_id: true, status: true },
      take: limit,
    });

    for (const task of tasks) {
      if (!task.book_id) {
        await prisma.orgTask.update({
          where: { id: task.id },
          data: { result_json: { kdp_readiness: { eligible: false, reasons: ['対象書籍(book_id)未指定'] } } },
        });
        result.screened += 1;
        continue;
      }
      const book = await prisma.book.findUnique({
        where: { id: task.book_id },
        select: { status: true, publish_status: true, has_blocking_comments: true },
      });
      if (!book) {
        await prisma.orgTask.update({
          where: { id: task.id },
          data: { result_json: { kdp_readiness: { eligible: false, reasons: ['書籍が見つかりません'] } } },
        });
        result.screened += 1;
        continue;
      }
      const evalRow = await prisma.evalResult.findFirst({
        where: { book_id: task.book_id },
        select: { score_total: true },
        orderBy: { judged_at: 'desc' },
      });
      const meta = await prisma.kdpMetadata.findUnique({
        where: { book_id: task.book_id },
        select: { price_jpy: true, description: true, keywords: true },
      });

      const readiness = evaluateKdpPublishReadiness(
        {
          book_status: book.status,
          publish_status: book.publish_status,
          has_blocking_comments: book.has_blocking_comments,
          quality_score: evalRow?.score_total ?? null,
          metadata: meta
            ? {
                price_jpy: meta.price_jpy,
                description_len: (meta.description ?? '').trim().length,
                keywords_count: Array.isArray(meta.keywords) ? meta.keywords.length : 0,
              }
            : null,
        },
        thresholds,
      );
      result.screened += 1;
      if (readiness.eligible) result.eligible += 1;

      // ゲート ON かつ eligible なら needs_human → approved（＝公開クリア）へ前進。実際の入稿はしない。
      const data: Record<string, unknown> = { result_json: { kdp_readiness: readiness } };
      if (gateEnabled && readiness.eligible && task.status === 'needs_human') {
        data.status = 'approved';
        data.updated_at = now();
        result.cleared += 1;
      }
      await prisma.orgTask.update({ where: { id: task.id }, data });
    }

    if (jobId && prisma.job) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', finished_at: now(), error: null, result_json: result },
      });
    }
    log.info({ task: ORG_KDP_SCREEN_TASK_NAME, ...result }, 'org.kdp.screen done');
    return result;
  } catch (err) {
    if (jobId && prisma.job) {
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

export const orgKdpScreenTask: Task = async (payload: unknown, _helpers: JobHelpers) => {
  await runOrgKdpScreen(payload);
};
