/**
 * regeneratePlan SA core logic (T-08-02, F-002).
 *
 * `app/actions/plans.ts` (SA wrapper) から呼ばれる業務ロジック。
 * 依存は全て DI で受け取り Vitest でユニットテスト可能にする
 * (themes-core / alerts-core と同パターン)。
 *
 * フロー:
 *  1. 入力 zod 検証 (months ∈ {3,6,12})
 *  2. account 存在チェック
 *  3. published_books + sales_trend を DB から取得してエージェント入力を構築
 *  4. `generatePlan` エージェント呼出 (token_usage は agent 内部で記録済み — 二重記録しない)
 *  5. PublishingPlan に upsert (同 account の最新プランを新規 INSERT)
 *  6. audit_log に `plan.regenerate` を INSERT
 *  7. { plan_id } を返す
 *
 * 仕様根拠: docs/05 §4.3.2 / docs/02 F-002
 */
import { z } from 'zod';

import {
  NotFoundError,
  ValidationError,
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import { Prisma, type Account, type PublishingPlan } from '@a2p/db';
import type {
  MarketerPlanInput,
  MarketerPlanOutput,
} from '@a2p/contracts/agents/marketer';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schema — docs/05 §4.3.2
// ---------------------------------------------------------------------------

export const RegeneratePlanInputSchema = z.object({
  account_id: z.string().min(1),
  /** months ∈ {3, 6, 12} */
  months: z.union([z.literal(3), z.literal(6), z.literal(12)]),
  target_count: z.number().int().min(1).max(500).optional(),
});

export type RegeneratePlanInput = z.infer<typeof RegeneratePlanInputSchema>;

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface AccountRepo {
  findUnique(args: {
    where: { id: string };
    select: { id: true; status: true; pen_name: true };
  }): Promise<Pick<Account, 'id' | 'status' | 'pen_name'> | null>;
}

export interface BookWithSales {
  title: string;
  theme: { genre: string } | null;
  salesRecords: Array<{
    year_month: string;
    royalty_jpy: number;
    review_count: number;
    avg_stars: unknown;
  }>;
}

export interface BookRepo {
  findMany(args: {
    where: { account_id: string; status: string };
    select: {
      title: true;
      theme: { select: { genre: true } };
      salesRecords: {
        orderBy: { year_month: string };
        take: number;
      };
    };
    take: number;
  }): Promise<BookWithSales[]>;
}

export interface SalesAggregateRow {
  year_month: string;
  _sum: { royalty_jpy: number | null };
}

export interface SalesRecordRepo {
  groupBy(args: {
    by: ['year_month'];
    where: {
      book: { account_id: string };
      year_month: { gte: string };
    };
    _sum: { royalty_jpy: true };
    orderBy: { year_month: string };
    take: number;
  }): Promise<SalesAggregateRow[]>;
}

export interface PublishingPlanRepo {
  create(args: {
    data: Prisma.PublishingPlanUncheckedCreateInput;
  }): Promise<Pick<PublishingPlan, 'id'>>;
}

export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export type GeneratePlanFn = (input: MarketerPlanInput) => Promise<MarketerPlanOutput>;

export interface PlansDeps {
  accountRepo: AccountRepo;
  bookRepo: BookRepo;
  salesRecordRepo: SalesRecordRepo;
  publishingPlanRepo: PublishingPlanRepo;
  auditLogRepo: AuditLogRepo;
  generatePlan: GeneratePlanFn;
  session: AuthenticatedSession;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

function toDecimalOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** ym string ("YYYY-MM") from a Date, months offset forward. */
function addMonths(base: Date, n: number): string {
  const d = new Date(base);
  d.setMonth(d.getMonth() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** "YYYY-MM" 12 months ago from now. */
function twelveMonthsAgo(now: Date): string {
  const d = new Date(now);
  d.setMonth(d.getMonth() - 12);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Default target_count when not provided: months × 3 (conservative). */
function defaultTargetCount(months: number): number {
  return months * 3;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function regeneratePlanCore(
  raw: unknown,
  deps: PlansDeps,
): Promise<ActionResult<{ plan_id: string }>> {
  const nowFn = deps.now ?? (() => new Date());

  const parsed = RegeneratePlanInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.plans.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  const input = parsed.data;
  const now = nowFn();

  try {
    // 1. Account 存在チェック
    const account = await deps.accountRepo.findUnique({
      where: { id: input.account_id },
      select: { id: true, status: true, pen_name: true },
    });
    if (!account) {
      throw new NotFoundError('Account not found', {
        userMessage: messages.plans.errors.accountNotFound,
        details: { account_id: input.account_id },
      });
    }

    // 2. published_books 取得 (done 状態の書籍、最大 30 件)
    const books = await deps.bookRepo.findMany({
      where: { account_id: input.account_id, status: 'done' },
      select: {
        title: true,
        theme: { select: { genre: true } },
        salesRecords: {
          orderBy: { year_month: 'desc' },
          take: 1,
        },
      },
      take: 30,
    });

    const publishedBooks: MarketerPlanInput['published_books'] = books.map((b) => {
      const latest = b.salesRecords[0];
      return {
        title: b.title,
        genre: b.theme?.genre ?? 'practical',
        recent_royalty_jpy: latest?.royalty_jpy ?? 0,
        review_count: latest?.review_count ?? 0,
        avg_stars: toDecimalOrNull(latest?.avg_stars),
      };
    });

    // 3. sales_trend 取得 (直近 12 ヶ月、月次合計)
    const fromYm = twelveMonthsAgo(now);
    const salesGroups = await deps.salesRecordRepo.groupBy({
      by: ['year_month'],
      where: {
        book: { account_id: input.account_id },
        year_month: { gte: fromYm },
      },
      _sum: { royalty_jpy: true },
      orderBy: { year_month: 'desc' },
      take: 12,
    });

    const salesTrend: MarketerPlanInput['sales_trend'] = salesGroups.map((g) => ({
      ym: g.year_month,
      total_royalty_jpy: g._sum.royalty_jpy ?? 0,
    }));

    // 4. エージェント呼出 (token_usage は agent 内部で記録 — 二重記録しない)
    const targetCount = input.target_count ?? defaultTargetCount(input.months);

    const agentOutput = await deps.generatePlan({
      accountId: input.account_id,
      months: input.months,
      target_count: targetCount,
      published_books: publishedBooks,
      sales_trend: salesTrend,
    });

    // 5. PublishingPlan 永続化
    const periodFrom = new Date(now);
    periodFrom.setDate(1);
    const periodFromYm = `${periodFrom.getFullYear()}-${String(periodFrom.getMonth() + 1).padStart(2, '0')}`;
    const periodToYm = addMonths(periodFrom, input.months - 1);

    const plan = await deps.publishingPlanRepo.create({
      data: {
        account_id: input.account_id,
        period_from: new Date(`${periodFromYm}-01T00:00:00.000Z`),
        period_to: new Date(`${periodToYm}-01T00:00:00.000Z`),
        plan_json: agentOutput as unknown as Prisma.InputJsonValue,
      },
    });

    // 6. audit_log
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'plan.regenerate',
        target_kind: 'publishing_plan',
        target_id: plan.id,
        before_json: Prisma.JsonNull,
        after_json: {
          account_id: input.account_id,
          months: input.months,
          target_count: targetCount,
          plan_id: plan.id,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ plan_id: plan.id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.plans.errors.unknown);
  }
}
