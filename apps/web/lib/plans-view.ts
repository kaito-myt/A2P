/**
 * S-005 長期出版プラン RSC シリアライザ (T-08-02).
 *
 * Prisma PublishingPlan + Account を Client Component に渡せる plain-object に変換する。
 * Date / Decimal / Json 正規化パターンは settings-view / alerts-view と同様。
 */
import type { Account, PublishingPlan } from '@a2p/db';
import type { MarketerPlanOutput, PlanMonth } from '@a2p/contracts/agents/marketer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanMonthView {
  ym: string;
  planned_count: number;
  theme_categories: string[];
  series_candidates: string[];
}

export interface PublishingPlanView {
  id: string;
  account_id: string;
  period_from: string;
  period_to: string;
  months: PlanMonthView[];
  notes: string | null;
  created_at: string;
}

export interface PlansPageData {
  account: {
    id: string;
    pen_name: string;
    display_name: string | null;
  };
  latestPlan: PublishingPlanView | null;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function serializePlanMonth(m: PlanMonth): PlanMonthView {
  return {
    ym: m.ym,
    planned_count: m.planned_count,
    theme_categories: m.theme_categories,
    series_candidates: m.series_candidates ?? [],
  };
}

function parsePlanJson(raw: unknown): MarketerPlanOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.months)) return null;
  return r as unknown as MarketerPlanOutput;
}

export function serializePublishingPlan(
  plan: Pick<PublishingPlan, 'id' | 'account_id' | 'period_from' | 'period_to' | 'plan_json' | 'created_at'>,
): PublishingPlanView {
  const parsed = parsePlanJson(plan.plan_json);
  const months: PlanMonthView[] = parsed?.months.map(serializePlanMonth) ?? [];

  return {
    id: plan.id,
    account_id: plan.account_id,
    period_from: plan.period_from instanceof Date
      ? plan.period_from.toISOString()
      : String(plan.period_from),
    period_to: plan.period_to instanceof Date
      ? plan.period_to.toISOString()
      : String(plan.period_to),
    months,
    notes: typeof parsed?.notes === 'string' ? parsed.notes : null,
    created_at: plan.created_at instanceof Date
      ? plan.created_at.toISOString()
      : String(plan.created_at),
  };
}

export function serializePlansPage(
  account: Pick<Account, 'id' | 'pen_name' | 'display_name'>,
  latestPlan: Pick<PublishingPlan, 'id' | 'account_id' | 'period_from' | 'period_to' | 'plan_json' | 'created_at'> | null,
): PlansPageData {
  return {
    account: {
      id: account.id,
      pen_name: account.pen_name,
      display_name: account.display_name,
    },
    latestPlan: latestPlan ? serializePublishingPlan(latestPlan) : null,
  };
}
