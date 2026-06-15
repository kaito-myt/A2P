import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@a2p/contracts/logger';
import { ValidationError } from '@a2p/contracts/errors';

import {
  ALERT_COST_CHECK_TASK_NAME,
  runAlertCostCheck,
  type AlertCostCheckPrisma,
  type GetBookCostBreakdownFn,
  type GetMonthlyTotalCostFn,
  type SweepExpiredLocksFn,
} from '../src/tasks/alert-cost-check.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  const calls: Array<{
    level: 'info' | 'warn' | 'error';
    obj: Record<string, unknown>;
    msg: string;
  }> = [];
  const mk =
    (level: 'info' | 'warn' | 'error') =>
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

interface Captures {
  bookUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  alertCreates: Array<{
    data: { kind: string; severity: string; payload_json: Record<string, unknown> };
  }>;
  jobUpdateManys: Array<{
    where: { book_id: string; status: { in: string[] } };
    data: { status: string };
    result: { count: number };
  }>;
  settingsUpdates: Array<{
    where: { id: string };
    data: Record<string, unknown>;
  }>;
}

function makeMocks(opts: {
  bookCostStatus?: string;
  bookStatus?: string;
  totalCostJpy: number;
  warnJpy?: number;
  pauseJpy?: number;
  monthlyYellowJpy?: number;
  monthlyOrangeJpy?: number;
  monthlyRedJpy?: number;
  monthlyBudgetExceeded?: boolean;
  forceContinue?: boolean;
  existingWarnAlert?: boolean;
  existingPauseAlert?: boolean;
  existingMonthlyAlertKinds?: string[];
  cancelledJobCount?: number;
  bookExists?: boolean;
}) {
  const captures: Captures = {
    bookUpdates: [],
    alertCreates: [],
    jobUpdateManys: [],
    settingsUpdates: [],
  };

  const prisma: AlertCostCheckPrisma = {
    appSettings: {
      findUnique: async () => ({
        cost_per_book_warn_jpy: opts.warnJpy ?? 500,
        cost_per_book_pause_jpy: opts.pauseJpy ?? 750,
        monthly_cost_yellow_jpy: opts.monthlyYellowJpy ?? 40000,
        monthly_cost_orange_jpy: opts.monthlyOrangeJpy ?? 47500,
        monthly_cost_red_jpy: opts.monthlyRedJpy ?? 50000,
        monthly_budget_exceeded: opts.monthlyBudgetExceeded ?? false,
        force_continue: opts.forceContinue ?? false,
      }),
      update: async (args) => {
        captures.settingsUpdates.push(args as (typeof captures.settingsUpdates)[0]);
        return { id: args.where.id };
      },
    },
    book: {
      findUnique: async () =>
        opts.bookExists === false
          ? null
          : {
              id: 'book-1',
              cost_status: opts.bookCostStatus ?? 'normal',
              status: opts.bookStatus ?? 'running',
              title: 'Test Book',
            },
      update: async (args) => {
        captures.bookUpdates.push(args as (typeof captures.bookUpdates)[0]);
        return { id: args.where.id };
      },
    },
    alert: {
      findFirst: async (args) => {
        if (
          args.where.kind === 'cost_per_book_warn' &&
          opts.existingWarnAlert
        ) {
          return { id: 'existing-warn-alert' };
        }
        if (
          args.where.kind === 'cost_per_book_pause' &&
          opts.existingPauseAlert
        ) {
          return { id: 'existing-pause-alert' };
        }
        if (
          opts.existingMonthlyAlertKinds?.includes(args.where.kind)
        ) {
          return { id: `existing-${args.where.kind}` };
        }
        return null;
      },
      create: async (args) => {
        captures.alertCreates.push(args as (typeof captures.alertCreates)[0]);
        return { id: 'new-alert' };
      },
    },
    job: {
      updateMany: async (args) => {
        const result = { count: opts.cancelledJobCount ?? 0 };
        captures.jobUpdateManys.push({
          ...(args as Omit<(typeof captures.jobUpdateManys)[0], 'result'>),
          result,
        });
        return result;
      },
    },
  };

  const getBookCostBreakdownFn: GetBookCostBreakdownFn = async () => ({
    book_id: 'book-1',
    rows: [],
    total_cost_jpy: opts.totalCostJpy,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cached_input_tokens: 0,
    total_image_count: 0,
  });

  const mailCalls: Array<{ subject: string }> = [];
  const sendEmailImpl = async (params: { subject: string }) => {
    mailCalls.push({ subject: params.subject });
    return { id: `test-mail-${mailCalls.length}` };
  };

  return { prisma, getBookCostBreakdownFn, captures, sendEmailImpl, mailCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('alert.cost.check task', () => {
  it('task name matches docs/05 §5.3.17', () => {
    expect(ALERT_COST_CHECK_TASK_NAME).toBe('alert.cost.check');
  });

  // ---------- validation ----------

  it('rejects invalid payload', async () => {
    const { logger } = makeLogger();
    await expect(
      runAlertCostCheck({ scope: 'invalid' }, { logger }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects per_book scope without book_id', async () => {
    const { logger } = makeLogger();
    await expect(
      runAlertCostCheck({ scope: 'per_book' }, { logger }),
    ).rejects.toThrow(ValidationError);
  });

  // ---------- monthly scope (T-07-03) ----------

  describe('monthly scope', () => {
    // Helper: create a monthly test with configurable date and cost
    function makeMonthlyDeps(opts: {
      monthlyCostJpy: number;
      now: Date;
      monthlyYellowJpy?: number;
      monthlyOrangeJpy?: number;
      monthlyRedJpy?: number;
      existingMonthlyAlertKinds?: string[];
    }) {
      const { logger, calls } = makeLogger();
      const mocks = makeMocks({
        totalCostJpy: 0,
        monthlyYellowJpy: opts.monthlyYellowJpy,
        monthlyOrangeJpy: opts.monthlyOrangeJpy,
        monthlyRedJpy: opts.monthlyRedJpy,
        existingMonthlyAlertKinds: opts.existingMonthlyAlertKinds,
      });

      const getMonthlyTotalCostFn: GetMonthlyTotalCostFn = async (_prisma, year, month) => ({
        year,
        month,
        total_cost_jpy: opts.monthlyCostJpy,
      });

      // Default no-op sweep: avoids real sweepExpiredLocks / default Prisma client fall-through
      const sweepCaptured: Array<{ deletedCount: number }> = [];
      const sweepExpiredLocksFn: SweepExpiredLocksFn = async (_deps) => {
        sweepCaptured.push({ deletedCount: 0 });
        return { deletedCount: 0 };
      };

      return {
        logger,
        calls,
        ...mocks,
        getMonthlyTotalCostFn,
        sweepExpiredLocksFn,
        sweepCaptured,
      };
    }

    it('creates 80% (yellow) Alert when predicted cost >= yellow threshold', async () => {
      // 15 days into a 30-day month, actual 20000 => predicted 40000
      const now = new Date(Date.UTC(2026, 5, 15)); // June 15, 2026
      const deps = makeMonthlyDeps({ monthlyCostJpy: 20000, now });

      await runAlertCostCheck(
        { scope: 'monthly' },
        {
          prisma: deps.prisma,
          logger: deps.logger,
          now: () => now,
          getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
          sendEmailImpl: deps.sendEmailImpl,
          sweepExpiredLocksFn: deps.sweepExpiredLocksFn,
        },
      );

      const yellowAlerts = deps.captures.alertCreates.filter(
        (a) => a.data.kind === 'monthly_cost_80',
      );
      expect(yellowAlerts).toHaveLength(1);
      expect(yellowAlerts[0]!.data.severity).toBe('warning');
      expect(yellowAlerts[0]!.data.payload_json).toMatchObject({
        year: 2026,
        month: 6,
        actual_cost_jpy: 20000,
        threshold_jpy: 40000,
      });

      // Should also send mail
      expect(deps.mailCalls.some((m) => m.subject.includes('80%'))).toBe(true);
    });

    it('creates 95% (orange) Alert when predicted cost >= orange threshold', async () => {
      // 10 days into a 31-day month, actual 16000 => predicted ~49600 (>= 47500)
      const now = new Date(Date.UTC(2026, 0, 10)); // Jan 10, 2026
      const deps = makeMonthlyDeps({ monthlyCostJpy: 16000, now });

      await runAlertCostCheck(
        { scope: 'monthly' },
        {
          prisma: deps.prisma,
          logger: deps.logger,
          now: () => now,
          getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
          sendEmailImpl: deps.sendEmailImpl,
          sweepExpiredLocksFn: deps.sweepExpiredLocksFn,
        },
      );

      const orangeAlerts = deps.captures.alertCreates.filter(
        (a) => a.data.kind === 'monthly_cost_95',
      );
      expect(orangeAlerts).toHaveLength(1);
      expect(orangeAlerts[0]!.data.severity).toBe('warning');

      // Also creates 80% since predicted >= yellow too
      const yellowAlerts = deps.captures.alertCreates.filter(
        (a) => a.data.kind === 'monthly_cost_80',
      );
      expect(yellowAlerts).toHaveLength(1);
    });

    it('creates 100% (red) Alert + sets monthly_budget_exceeded flag', async () => {
      // 10 days into a 30-day month, actual 20000 => predicted 60000 (>= 50000)
      const now = new Date(Date.UTC(2026, 5, 10)); // June 10, 2026
      const deps = makeMonthlyDeps({ monthlyCostJpy: 20000, now });

      await runAlertCostCheck(
        { scope: 'monthly' },
        {
          prisma: deps.prisma,
          logger: deps.logger,
          now: () => now,
          getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
          sendEmailImpl: deps.sendEmailImpl,
          sweepExpiredLocksFn: deps.sweepExpiredLocksFn,
        },
      );

      const redAlerts = deps.captures.alertCreates.filter(
        (a) => a.data.kind === 'monthly_cost_100',
      );
      expect(redAlerts).toHaveLength(1);
      expect(redAlerts[0]!.data.severity).toBe('critical');

      // monthly_budget_exceeded flag set
      expect(deps.captures.settingsUpdates).toHaveLength(1);
      expect(deps.captures.settingsUpdates[0]!.data).toEqual({
        monthly_budget_exceeded: true,
      });

      // All three alerts created (100 >= 95 >= 80)
      expect(deps.captures.alertCreates).toHaveLength(3);
    });

    it('skips Alert creation if same month same kind already exists (deduplication)', async () => {
      const now = new Date(Date.UTC(2026, 5, 15)); // June 15
      const deps = makeMonthlyDeps({
        monthlyCostJpy: 20000,
        now,
        existingMonthlyAlertKinds: ['monthly_cost_80'],
      });

      await runAlertCostCheck(
        { scope: 'monthly' },
        {
          prisma: deps.prisma,
          logger: deps.logger,
          now: () => now,
          getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
          sendEmailImpl: deps.sendEmailImpl,
          sweepExpiredLocksFn: deps.sweepExpiredLocksFn,
        },
      );

      // 80% skipped because it already exists; no alerts created at all
      // (predicted 40000 only hits 80%, which is deduplicated)
      expect(deps.captures.alertCreates).toHaveLength(0);
      expect(deps.mailCalls).toHaveLength(0);
    });

    it('extrapolates correctly on day 1 of the month', async () => {
      // Day 1 of a 31-day month, actual 2000 => predicted 62000 (2000/1*31)
      const now = new Date(Date.UTC(2026, 0, 1)); // Jan 1, 2026 (31 days)
      const deps = makeMonthlyDeps({ monthlyCostJpy: 2000, now });

      await runAlertCostCheck(
        { scope: 'monthly' },
        {
          prisma: deps.prisma,
          logger: deps.logger,
          now: () => now,
          getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
          sendEmailImpl: deps.sendEmailImpl,
          sweepExpiredLocksFn: deps.sweepExpiredLocksFn,
        },
      );

      // predicted = 2000 / 1 * 31 = 62000 => hits all three thresholds
      expect(deps.captures.alertCreates).toHaveLength(3);
      const kinds = deps.captures.alertCreates.map((a) => a.data.kind).sort();
      expect(kinds).toEqual(['monthly_cost_100', 'monthly_cost_80', 'monthly_cost_95']);

      // Verify the predicted value in payload
      const redAlert = deps.captures.alertCreates.find(
        (a) => a.data.kind === 'monthly_cost_100',
      );
      expect(redAlert!.data.payload_json.predicted_cost_jpy).toBe(62000);
      expect(redAlert!.data.payload_json.elapsed_days).toBe(1);
      expect(redAlert!.data.payload_json.total_days).toBe(31);
    });

    it('creates no alerts when predicted cost is below all thresholds', async () => {
      // 15 days into a 30-day month, actual 10000 => predicted 20000 (< 40000)
      const now = new Date(Date.UTC(2026, 5, 15)); // June 15
      const deps = makeMonthlyDeps({ monthlyCostJpy: 10000, now });

      await runAlertCostCheck(
        { scope: 'monthly' },
        {
          prisma: deps.prisma,
          logger: deps.logger,
          now: () => now,
          getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
          sendEmailImpl: deps.sendEmailImpl,
          sweepExpiredLocksFn: deps.sweepExpiredLocksFn,
        },
      );

      expect(deps.captures.alertCreates).toHaveLength(0);
      expect(deps.captures.settingsUpdates).toHaveLength(0);
      expect(deps.mailCalls).toHaveLength(0);
    });

    it('uses custom thresholds from AppSettings', async () => {
      // Custom thresholds: yellow=10000, orange=20000, red=30000
      // 15 days into 30-day month, actual 7500 => predicted 15000
      // Hits custom yellow(10000) but not orange(20000) or red(30000)
      const now = new Date(Date.UTC(2026, 5, 15)); // June 15
      const deps = makeMonthlyDeps({
        monthlyCostJpy: 7500,
        now,
        monthlyYellowJpy: 10000,
        monthlyOrangeJpy: 20000,
        monthlyRedJpy: 30000,
      });

      await runAlertCostCheck(
        { scope: 'monthly' },
        {
          prisma: deps.prisma,
          logger: deps.logger,
          now: () => now,
          getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
          sendEmailImpl: deps.sendEmailImpl,
          sweepExpiredLocksFn: deps.sweepExpiredLocksFn,
        },
      );

      expect(deps.captures.alertCreates).toHaveLength(1);
      expect(deps.captures.alertCreates[0]!.data.kind).toBe('monthly_cost_80');
      expect(deps.captures.settingsUpdates).toHaveLength(0);
    });

    it('does not set budget_exceeded for 80% or 95% thresholds', async () => {
      // 15 days into 30-day month, actual 24000 => predicted 48000
      // Hits yellow(40000) and orange(47500) but NOT red(50000)
      const now = new Date(Date.UTC(2026, 5, 15));
      const deps = makeMonthlyDeps({ monthlyCostJpy: 24000, now });

      await runAlertCostCheck(
        { scope: 'monthly' },
        {
          prisma: deps.prisma,
          logger: deps.logger,
          now: () => now,
          getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
          sendEmailImpl: deps.sendEmailImpl,
          sweepExpiredLocksFn: deps.sweepExpiredLocksFn,
        },
      );

      // Two alerts (80% and 95%) but no settings update
      expect(deps.captures.alertCreates).toHaveLength(2);
      expect(deps.captures.settingsUpdates).toHaveLength(0);
    });

    // ---------- T-07-11: lock sweep wiring ----------

    it('calls sweepExpiredLocksFn in monthly scope (T-07-11)', async () => {
      const now = new Date(Date.UTC(2026, 5, 15));
      const deps = makeMonthlyDeps({ monthlyCostJpy: 10000, now }); // below all thresholds, no alerts

      const sweepCalls: Array<{ deletedCount: number }> = [];
      const fakeSweep: SweepExpiredLocksFn = async (_deps) => {
        sweepCalls.push({ deletedCount: 2 });
        return { deletedCount: 2 };
      };

      await runAlertCostCheck(
        { scope: 'monthly' },
        {
          prisma: deps.prisma,
          logger: deps.logger,
          now: () => now,
          getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
          sendEmailImpl: deps.sendEmailImpl,
          sweepExpiredLocksFn: fakeSweep,
        },
      );

      expect(sweepCalls).toHaveLength(1);
      expect(sweepCalls[0]!.deletedCount).toBe(2);
    });

    it('does not abort monthly cost alert when sweep throws (T-07-11)', async () => {
      const now = new Date(Date.UTC(2026, 5, 10));
      const deps = makeMonthlyDeps({ monthlyCostJpy: 20000, now }); // predicted 60000 => all alerts

      const failingSweep: SweepExpiredLocksFn = async () => {
        throw new Error('db connection lost');
      };

      // Should not throw; cost alert logic completes normally
      await expect(
        runAlertCostCheck(
          { scope: 'monthly' },
          {
            prisma: deps.prisma,
            logger: deps.logger,
            now: () => now,
            getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
            sendEmailImpl: deps.sendEmailImpl,
            sweepExpiredLocksFn: failingSweep,
          },
        ),
      ).resolves.toBeUndefined();

      // All three cost alerts still created despite sweep failure
      expect(deps.captures.alertCreates).toHaveLength(3);
    });

    it('sends mail for each threshold hit', async () => {
      // 10 days into 30-day month, actual 20000 => predicted 60000 => all three
      const now = new Date(Date.UTC(2026, 5, 10));
      const deps = makeMonthlyDeps({ monthlyCostJpy: 20000, now });

      await runAlertCostCheck(
        { scope: 'monthly' },
        {
          prisma: deps.prisma,
          logger: deps.logger,
          now: () => now,
          getMonthlyTotalCostFn: deps.getMonthlyTotalCostFn,
          sendEmailImpl: deps.sendEmailImpl,
          sweepExpiredLocksFn: deps.sweepExpiredLocksFn,
        },
      );

      expect(deps.mailCalls).toHaveLength(3);
      const subjects = deps.mailCalls.map((m) => m.subject);
      expect(subjects.some((s) => s.includes('100%'))).toBe(true);
      expect(subjects.some((s) => s.includes('95%'))).toBe(true);
      expect(subjects.some((s) => s.includes('80%'))).toBe(true);
    });
  });

  // ---------- below threshold ----------

  it('does nothing when cost is below warn threshold', async () => {
    const { logger } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures, sendEmailImpl, mailCalls } =
      makeMocks({ totalCostJpy: 300 });

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl },
    );

    expect(captures.alertCreates).toHaveLength(0);
    expect(captures.bookUpdates).toHaveLength(0);
    expect(captures.jobUpdateManys).toHaveLength(0);
    expect(mailCalls).toHaveLength(0);
  });

  // ---------- warn threshold ----------

  it('creates warn Alert + updates cost_status when cost >= warn and < pause', async () => {
    const { logger } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures, sendEmailImpl, mailCalls } =
      makeMocks({ totalCostJpy: 550 });

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl },
    );

    // Alert created
    expect(captures.alertCreates).toHaveLength(1);
    expect(captures.alertCreates[0]!.data.kind).toBe('cost_per_book_warn');
    expect(captures.alertCreates[0]!.data.severity).toBe('warning');
    expect(captures.alertCreates[0]!.data.payload_json).toMatchObject({
      book_id: 'book-1',
      total_cost_jpy: 550,
    });

    // Book.cost_status = 'warn'
    expect(captures.bookUpdates).toHaveLength(1);
    expect(captures.bookUpdates[0]!.data).toEqual({ cost_status: 'warn' });

    // No job cancellation for warn
    expect(captures.jobUpdateManys).toHaveLength(0);

    // Mail sent
    expect(mailCalls).toHaveLength(1);
    expect(mailCalls[0]!.subject).toContain('書籍コスト警告');
  });

  it('exactly at warn threshold triggers warn', async () => {
    const { logger } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures, sendEmailImpl } = makeMocks({
      totalCostJpy: 500,
    });

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl },
    );

    expect(captures.alertCreates).toHaveLength(1);
    expect(captures.alertCreates[0]!.data.kind).toBe('cost_per_book_warn');
  });

  // ---------- pause threshold ----------

  it('creates pause Alert + updates Book + cancels jobs when cost >= pause', async () => {
    const { logger } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures, sendEmailImpl, mailCalls } =
      makeMocks({ totalCostJpy: 800, cancelledJobCount: 3 });

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl },
    );

    // Alert created
    expect(captures.alertCreates).toHaveLength(1);
    expect(captures.alertCreates[0]!.data.kind).toBe('cost_per_book_pause');
    expect(captures.alertCreates[0]!.data.severity).toBe('critical');

    // Book updated
    expect(captures.bookUpdates).toHaveLength(1);
    expect(captures.bookUpdates[0]!.data).toEqual({
      cost_status: 'paused',
      status: 'paused_cost',
    });

    // Jobs cancelled
    expect(captures.jobUpdateManys).toHaveLength(1);
    expect(captures.jobUpdateManys[0]!.where).toEqual({
      book_id: 'book-1',
      status: { in: ['queued', 'running'] },
    });
    expect(captures.jobUpdateManys[0]!.result.count).toBe(3);

    // Mail sent
    expect(mailCalls).toHaveLength(1);
    expect(mailCalls[0]!.subject).toContain('書籍コスト警告');
  });

  it('exactly at pause threshold triggers pause', async () => {
    const { logger } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures, sendEmailImpl } = makeMocks({
      totalCostJpy: 750,
      cancelledJobCount: 1,
    });

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl },
    );

    expect(captures.alertCreates).toHaveLength(1);
    expect(captures.alertCreates[0]!.data.kind).toBe('cost_per_book_pause');
  });

  // ---------- idempotency ----------

  it('does not duplicate warn if cost_status is already warn', async () => {
    const { logger } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures, sendEmailImpl, mailCalls } =
      makeMocks({ totalCostJpy: 550, bookCostStatus: 'warn' });

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl },
    );

    expect(captures.alertCreates).toHaveLength(0);
    expect(captures.bookUpdates).toHaveLength(0);
    expect(mailCalls).toHaveLength(0);
  });

  it('does not duplicate pause if cost_status is already paused', async () => {
    const { logger } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures, sendEmailImpl, mailCalls } =
      makeMocks({ totalCostJpy: 800, bookCostStatus: 'paused' });

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl },
    );

    expect(captures.alertCreates).toHaveLength(0);
    expect(captures.bookUpdates).toHaveLength(0);
    expect(captures.jobUpdateManys).toHaveLength(0);
    expect(mailCalls).toHaveLength(0);
  });

  it('does not create duplicate Alert if unresolved alert already exists', async () => {
    const { logger } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures, sendEmailImpl } = makeMocks({
      totalCostJpy: 550,
      existingWarnAlert: true,
    });

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl },
    );

    // Alert NOT created (already exists), but book still updated
    expect(captures.alertCreates).toHaveLength(0);
    expect(captures.bookUpdates).toHaveLength(1);
    expect(captures.bookUpdates[0]!.data).toEqual({ cost_status: 'warn' });
  });

  // ---------- book not found ----------

  it('skips gracefully when book not found', async () => {
    const { logger, calls } = makeLogger();
    const { prisma, getBookCostBreakdownFn, sendEmailImpl } = makeMocks({
      totalCostJpy: 0,
      bookExists: false,
    });

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-missing' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl },
    );

    expect(calls.some((c) => c.msg.includes('book not found'))).toBe(true);
  });

  // ---------- custom thresholds ----------

  it('uses AppSettings thresholds instead of defaults', async () => {
    const { logger } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures, sendEmailImpl } = makeMocks({
      totalCostJpy: 200,
      warnJpy: 100,
      pauseJpy: 300,
    });

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl },
    );

    // 200 >= custom warn(100) and < custom pause(300) => warn
    expect(captures.alertCreates).toHaveLength(1);
    expect(captures.alertCreates[0]!.data.kind).toBe('cost_per_book_warn');
  });

  // ---------- graceful degradation on sendEmail failure ----------

  it('continues without throwing when sendEmail fails with ConfigError (RESEND_API_KEY missing)', async () => {
    const { logger, calls } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures } = makeMocks({
      totalCostJpy: 550,
    });

    class ConfigError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'ConfigError';
      }
    }

    const failingEmailImpl = async () => {
      throw new ConfigError('RESEND_API_KEY not set');
    };

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      {
        prisma,
        logger,
        getBookCostBreakdownFn,
        sendEmailImpl: failingEmailImpl as never,
      },
    );

    // Alert was still created despite mail failure
    expect(captures.alertCreates).toHaveLength(1);
    expect(captures.alertCreates[0]!.data.kind).toBe('cost_per_book_warn');
    // Warn log about skipped mail
    expect(calls.some((c) => c.msg.includes('mail skipped'))).toBe(true);
  });

  it('continues without throwing when sendEmail fails with non-ConfigError', async () => {
    const { logger, calls } = makeLogger();
    const { prisma, getBookCostBreakdownFn, captures } = makeMocks({
      totalCostJpy: 550,
    });

    const failingEmailImpl = async () => {
      throw new Error('network down');
    };

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      {
        prisma,
        logger,
        getBookCostBreakdownFn,
        sendEmailImpl: failingEmailImpl as never,
      },
    );

    // Alert was still created
    expect(captures.alertCreates).toHaveLength(1);
    // Warn log about send failure
    expect(calls.some((c) => c.msg.includes('mail send failed'))).toBe(true);
  });

  // ---------- T-07-11: per_book scope must NOT sweep ----------

  it('does NOT call sweepExpiredLocksFn in per_book scope (T-07-11)', async () => {
    const { logger } = makeLogger();
    const { prisma, getBookCostBreakdownFn, sendEmailImpl } = makeMocks({
      totalCostJpy: 300,
    });

    const sweepCalls: number[] = [];
    const fakeSweep: SweepExpiredLocksFn = async () => {
      sweepCalls.push(1);
      return { deletedCount: 0 };
    };

    await runAlertCostCheck(
      { scope: 'per_book', book_id: 'book-1' },
      { prisma, logger, getBookCostBreakdownFn, sendEmailImpl, sweepExpiredLocksFn: fakeSweep },
    );

    expect(sweepCalls).toHaveLength(0);
  });
});
