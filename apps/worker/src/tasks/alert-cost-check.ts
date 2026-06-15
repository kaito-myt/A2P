import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { getBookCostBreakdown, getMonthlyTotalCost } from '@a2p/db/cost-aggregation';
import type { PrismaClient } from '@a2p/db';
import { prisma as defaultPrisma } from '@a2p/db';
import {
  sendEmail,
  buildCostExceededEmail,
  buildMonthlyBudgetAlertEmail,
  type SendEmailParams,
} from '@a2p/notify';
import { sweepExpiredLocks, type BookLockDeps } from '@a2p/agents';

/**
 * `alert.cost.check` (docs/05 §5.3.17, F-034/F-036)
 *
 * per_book scope:
 *   1. `getBookCostBreakdown` でコスト合計を取得
 *   2. AppSettings から閾値を読み (cost_per_book_warn_jpy / cost_per_book_pause_jpy)
 *   3. pause 閾値超過 → Alert(cost_per_book_pause, critical) + Book.cost_status='paused'
 *      + Book.status='paused_cost' + 進行中 Job cancel + メール placeholder
 *   4. warn 閾値超過 → Alert(cost_per_book_warn, warning) + Book.cost_status='warn'
 *      + メール placeholder
 *   5. 冪等: 既に warn/paused なら再度同じアクションを取らない
 *
 * monthly scope (T-07-03):
 *   1. `getMonthlyTotalCost` で当月実績取得
 *   2. 線形外挿で月末予測算出
 *   3. AppSettings から閾値取得 (monthly_cost_yellow/orange/red_jpy)
 *   4. 80%/95%/100% 判定 → Alert + メール
 *   5. 100% → AppSettings.monthly_budget_exceeded = true
 *   6. 重複抑止: 同月同 kind の Alert が既にあればスキップ
 */

export const ALERT_COST_CHECK_TASK_NAME = 'alert.cost.check';

export const AlertCostCheckPayloadSchema = z.object({
  scope: z.enum(['per_book', 'monthly']),
  book_id: z.string().min(1).optional(),
});
export type AlertCostCheckPayload = z.infer<typeof AlertCostCheckPayloadSchema>;

const DEFAULT_WARN_JPY = 500;
const DEFAULT_PAUSE_JPY = 750;
const DEFAULT_MONTHLY_YELLOW_JPY = 40_000;
const DEFAULT_MONTHLY_ORANGE_JPY = 47_500;
const DEFAULT_MONTHLY_RED_JPY = 50_000;

// ---------------------------------------------------------------------------
// Prisma subset for DI / testability
// ---------------------------------------------------------------------------

export interface AppSettingsPerBook {
  cost_per_book_warn_jpy: number;
  cost_per_book_pause_jpy: number;
}

export interface AppSettingsMonthly {
  monthly_cost_yellow_jpy: number;
  monthly_cost_orange_jpy: number;
  monthly_cost_red_jpy: number;
  monthly_budget_exceeded: boolean;
  force_continue: boolean;
}

export interface AlertCostCheckPrisma {
  appSettings: {
    findUnique: (args: {
      where: { id: string };
      select: Record<string, true>;
    }) => Promise<(AppSettingsPerBook & AppSettingsMonthly) | null>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<{ id: string }>;
  };
  book: {
    findUnique: (args: {
      where: { id: string };
      select: { id: true; cost_status: true; status: true; title: true };
    }) => Promise<{
      id: string;
      cost_status: string;
      status: string;
      title: string;
    } | null>;
    update: (args: {
      where: { id: string };
      data: {
        cost_status?: string;
        status?: string;
      };
    }) => Promise<{ id: string }>;
  };
  alert: {
    findFirst: (args: {
      where: {
        kind: string;
        payload_json?: { path: string[]; equals: string };
        created_at?: { gte: Date };
        resolved_at: null;
      };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
    create: (args: {
      data: {
        kind: string;
        severity: string;
        payload_json: Record<string, unknown>;
      };
    }) => Promise<{ id: string }>;
  };
  job: {
    updateMany: (args: {
      where: {
        book_id: string;
        status: { in: string[] };
      };
      data: { status: string };
    }) => Promise<{ count: number }>;
  };
}

export type GetBookCostBreakdownFn = typeof getBookCostBreakdown;
export type GetMonthlyTotalCostFn = typeof getMonthlyTotalCost;
export type SweepExpiredLocksFn = typeof sweepExpiredLocks;

export interface AlertCostCheckDeps {
  prisma?: AlertCostCheckPrisma;
  logger?: Logger;
  now?: () => Date;
  getBookCostBreakdownFn?: GetBookCostBreakdownFn;
  getMonthlyTotalCostFn?: GetMonthlyTotalCostFn;
  sendEmailImpl?: typeof sendEmail;
  /** Injected for testing; defaults to sweepExpiredLocks from @a2p/agents. Monthly scope only. */
  sweepExpiredLocksFn?: SweepExpiredLocksFn;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export async function runAlertCostCheck(
  payload: unknown,
  deps: AlertCostCheckDeps = {},
): Promise<void> {
  const parsed = AlertCostCheckPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('alert.cost.check payload invalid', {
      details: { issues: parsed.error.issues },
    });
  }

  const log = deps.logger ?? createLogger(`worker.${ALERT_COST_CHECK_TASK_NAME}`);

  if (parsed.data.scope === 'monthly') {
    await runMonthlyScope(deps, log);
    return;
  }

  // per_book scope
  const bookId = parsed.data.book_id;
  if (!bookId) {
    throw new ValidationError('alert.cost.check: book_id is required for per_book scope', {
      details: { scope: 'per_book' },
    });
  }

  const prisma = deps.prisma ?? (defaultPrisma as unknown as AlertCostCheckPrisma);
  const getCostFn = deps.getBookCostBreakdownFn ?? getBookCostBreakdown;
  const sendMailFn = deps.sendEmailImpl ?? sendEmail;

  // 1. Book を取得
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { id: true, cost_status: true, status: true, title: true },
  });
  if (!book) {
    log.warn(
      { task: ALERT_COST_CHECK_TASK_NAME, bookId },
      'book not found — skipping cost check',
    );
    return;
  }

  // 2. コスト集計
  const breakdown = await getCostFn(
    prisma as unknown as PrismaClient,
    bookId,
  );
  const totalCost = breakdown.total_cost_jpy;

  // 3. 閾値を取得
  const settings = await prisma.appSettings.findUnique({
    where: { id: 'singleton' },
    select: {
      cost_per_book_warn_jpy: true,
      cost_per_book_pause_jpy: true,
    },
  });
  const warnThreshold = settings?.cost_per_book_warn_jpy ?? DEFAULT_WARN_JPY;
  const pauseThreshold = settings?.cost_per_book_pause_jpy ?? DEFAULT_PAUSE_JPY;

  log.info(
    {
      task: ALERT_COST_CHECK_TASK_NAME,
      bookId,
      totalCost,
      warnThreshold,
      pauseThreshold,
      currentCostStatus: book.cost_status,
    },
    'per_book cost check',
  );

  // 4. pause 判定 (>= pause)
  if (totalCost >= pauseThreshold) {
    if (book.cost_status === 'paused') {
      log.info(
        { task: ALERT_COST_CHECK_TASK_NAME, bookId },
        'already paused — skipping (idempotent)',
      );
      return;
    }

    // Alert 重複チェック
    const existingAlert = await prisma.alert.findFirst({
      where: {
        kind: 'cost_per_book_pause',
        payload_json: { path: ['book_id'], equals: bookId },
        resolved_at: null,
      },
      select: { id: true },
    });
    if (!existingAlert) {
      await prisma.alert.create({
        data: {
          kind: 'cost_per_book_pause',
          severity: 'critical',
          payload_json: {
            book_id: bookId,
            book_title: book.title,
            total_cost_jpy: totalCost,
            threshold_jpy: pauseThreshold,
          },
        },
      });
    }

    // Book status 更新
    await prisma.book.update({
      where: { id: bookId },
      data: {
        cost_status: 'paused',
        status: 'paused_cost',
      },
    });

    // 進行中 Job を cancel
    const cancelResult = await prisma.job.updateMany({
      where: {
        book_id: bookId,
        status: { in: ['queued', 'running'] },
      },
      data: { status: 'cancelled' },
    });

    log.info(
      {
        task: ALERT_COST_CHECK_TASK_NAME,
        bookId,
        totalCost,
        cancelledJobs: cancelResult.count,
      },
      'book paused due to cost exceeding pause threshold',
    );

    await safeSendEmail(log, sendMailFn, () =>
      buildCostExceededEmail({
        bookId,
        bookTitle: book.title,
        costJpy: totalCost,
        limitJpy: pauseThreshold,
        status: 'paused',
      }),
    );
    return;
  }

  // 5. warn 判定 (>= warn && < pause)
  if (totalCost >= warnThreshold) {
    if (book.cost_status === 'warn' || book.cost_status === 'paused') {
      log.info(
        { task: ALERT_COST_CHECK_TASK_NAME, bookId, currentCostStatus: book.cost_status },
        'already warn or paused — skipping warn (idempotent)',
      );
      return;
    }

    // Alert 重複チェック
    const existingAlert = await prisma.alert.findFirst({
      where: {
        kind: 'cost_per_book_warn',
        payload_json: { path: ['book_id'], equals: bookId },
        resolved_at: null,
      },
      select: { id: true },
    });
    if (!existingAlert) {
      await prisma.alert.create({
        data: {
          kind: 'cost_per_book_warn',
          severity: 'warning',
          payload_json: {
            book_id: bookId,
            book_title: book.title,
            total_cost_jpy: totalCost,
            threshold_jpy: warnThreshold,
          },
        },
      });
    }

    await prisma.book.update({
      where: { id: bookId },
      data: { cost_status: 'warn' },
    });

    log.info(
      { task: ALERT_COST_CHECK_TASK_NAME, bookId, totalCost },
      'book cost status set to warn',
    );

    await safeSendEmail(log, sendMailFn, () =>
      buildCostExceededEmail({
        bookId,
        bookTitle: book.title,
        costJpy: totalCost,
        limitJpy: warnThreshold,
        status: 'warn',
      }),
    );
    return;
  }

  // 6. 閾値未到達
  log.info(
    { task: ALERT_COST_CHECK_TASK_NAME, bookId, totalCost },
    'cost below thresholds — no action',
  );
}

// ---------------------------------------------------------------------------
// Monthly scope handler (T-07-03, F-036)
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

interface MonthlyThreshold {
  kind: string;
  severity: string;
  label: string;
  thresholdJpy: number;
}

async function runMonthlyScope(
  deps: AlertCostCheckDeps,
  log: Logger,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-based
  const totalDays = daysInMonth(year, month);
  const elapsedDays = now.getUTCDate();

  const prisma = deps.prisma ?? (defaultPrisma as unknown as AlertCostCheckPrisma);
  const getMonthlyCostFn = deps.getMonthlyTotalCostFn ?? getMonthlyTotalCost;
  const sendMailFn = deps.sendEmailImpl ?? sendEmail;
  const sweepFn = deps.sweepExpiredLocksFn ?? sweepExpiredLocks;

  // 1. 当月実績コスト取得
  const { total_cost_jpy: actualCost } = await getMonthlyCostFn(
    prisma as unknown as PrismaClient,
    year,
    month,
  );

  // 2. 線形外挿 (elapsed が 0 日はありえないが安全策)
  const predicted = elapsedDays > 0
    ? (actualCost / elapsedDays) * totalDays
    : 0;

  // 3. 閾値取得
  const settings = await prisma.appSettings.findUnique({
    where: { id: 'singleton' },
    select: {
      monthly_cost_yellow_jpy: true,
      monthly_cost_orange_jpy: true,
      monthly_cost_red_jpy: true,
      monthly_budget_exceeded: true,
      force_continue: true,
    } as Record<string, true>,
  });

  const yellowJpy = settings?.monthly_cost_yellow_jpy ?? DEFAULT_MONTHLY_YELLOW_JPY;
  const orangeJpy = settings?.monthly_cost_orange_jpy ?? DEFAULT_MONTHLY_ORANGE_JPY;
  const redJpy = settings?.monthly_cost_red_jpy ?? DEFAULT_MONTHLY_RED_JPY;

  log.info(
    {
      task: ALERT_COST_CHECK_TASK_NAME,
      scope: 'monthly',
      year,
      month,
      elapsedDays,
      totalDays,
      actualCost,
      predicted,
      yellowJpy,
      orangeJpy,
      redJpy,
    },
    'monthly cost check',
  );

  // 4. 閾値リスト (降順で最も高い閾値から判定)
  const thresholds: MonthlyThreshold[] = [
    { kind: 'monthly_cost_100', severity: 'critical', label: '100%', thresholdJpy: redJpy },
    { kind: 'monthly_cost_95', severity: 'warning', label: '95%', thresholdJpy: orangeJpy },
    { kind: 'monthly_cost_80', severity: 'warning', label: '80%', thresholdJpy: yellowJpy },
  ];

  const monthStartDate = monthStart(now);

  for (const th of thresholds) {
    if (predicted < th.thresholdJpy) continue;

    // 重複抑止: 同月同 kind の Alert が既にあればスキップ
    const existing = await prisma.alert.findFirst({
      where: {
        kind: th.kind,
        created_at: { gte: monthStartDate },
        resolved_at: null,
      },
      select: { id: true },
    });

    if (existing) {
      log.info(
        { task: ALERT_COST_CHECK_TASK_NAME, kind: th.kind },
        'monthly alert already exists for this month — skipping',
      );
      continue;
    }

    await prisma.alert.create({
      data: {
        kind: th.kind,
        severity: th.severity,
        payload_json: {
          year,
          month,
          actual_cost_jpy: actualCost,
          predicted_cost_jpy: predicted,
          threshold_jpy: th.thresholdJpy,
          elapsed_days: elapsedDays,
          total_days: totalDays,
        },
      },
    });

    log.info(
      { task: ALERT_COST_CHECK_TASK_NAME, kind: th.kind, predicted, threshold: th.thresholdJpy },
      `monthly budget alert created: ${th.label}`,
    );

    // 100% 到達 → monthly_budget_exceeded フラグを立てる
    if (th.kind === 'monthly_cost_100') {
      await prisma.appSettings.update({
        where: { id: 'singleton' },
        data: { monthly_budget_exceeded: true },
      });

      log.info(
        { task: ALERT_COST_CHECK_TASK_NAME },
        'monthly_budget_exceeded flag set to true',
      );
    }

    const percentage = th.label === '100%' ? 100 : th.label === '95%' ? 95 : 80;
    await safeSendEmail(log, sendMailFn, () =>
      buildMonthlyBudgetAlertEmail({
        month: `${year}-${String(month).padStart(2, '0')}`,
        usageJpy: actualCost,
        predictedJpy: Math.round(predicted),
        budgetJpy: th.thresholdJpy,
        ratio: percentage / 100,
        elapsedDays,
        totalDays,
      }),
    );
  }

  // Best-effort: sweep expired book locks — failure must not abort the cost alert (T-07-11)
  try {
    const sweepDeps: BookLockDeps = {};
    if (deps.now !== undefined) sweepDeps.now = deps.now;
    const sweepResult = await sweepFn(sweepDeps);
    log.debug(
      { task: ALERT_COST_CHECK_TASK_NAME, deletedCount: sweepResult.deletedCount },
      'expired book locks swept (piggybacked on monthly cost check)',
    );
  } catch (err: unknown) {
    log.warn(
      { task: ALERT_COST_CHECK_TASK_NAME, err },
      'book lock sweep failed — monthly cost alert was not affected',
    );
  }
}

// ---------------------------------------------------------------------------
// Mail helper — graceful degradation when RESEND_API_KEY is unset
// ---------------------------------------------------------------------------

async function safeSendEmail(
  log: Logger,
  sendMailFn: typeof sendEmail,
  buildFn: () => Pick<SendEmailParams, 'subject' | 'react'>,
): Promise<void> {
  const built = buildFn();
  try {
    await sendMailFn({ subject: built.subject, react: built.react });
  } catch (err: unknown) {
    const isConfigError =
      err instanceof Error && err.constructor.name === 'ConfigError';
    if (isConfigError) {
      log.warn(
        { task: ALERT_COST_CHECK_TASK_NAME, subject: built.subject },
        'mail skipped — RESEND_API_KEY or MAIL_FROM/MAIL_TO not configured (graceful fallback)',
      );
      return;
    }
    log.warn(
      { task: ALERT_COST_CHECK_TASK_NAME, err, subject: built.subject },
      'mail send failed — alert was still persisted to DB',
    );
  }
}

// ---------------------------------------------------------------------------
// graphile-worker Task export
// ---------------------------------------------------------------------------

export const alertCostCheckTask: Task = async (
  payload: unknown,
  _helpers: JobHelpers,
) => {
  await runAlertCostCheck(payload);
};
