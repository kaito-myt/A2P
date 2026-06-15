/**
 * plans-view.ts ユニットテスト (T-08-02).
 *
 * 検証:
 *  1. serializePublishingPlan: Date → ISO 文字列 / plan_json 展開
 *  2. serializePlansPage: account + null plan → latestPlan null
 *  3. serializePlansPage: account + plan → latestPlan populated
 *  4. plan_json が不正な場合は months=[] で返る
 */
import { describe, expect, it } from 'vitest';

import {
  serializePublishingPlan,
  serializePlansPage,
  type PublishingPlanView,
} from '../../lib/plans-view';

const FAKE_PLAN_JSON = {
  months: [
    {
      ym: '2026-06',
      planned_count: 5,
      theme_categories: ['副業', 'AI 活用'],
      series_candidates: ['副業の応用 Vol.2'],
    },
    {
      ym: '2026-07',
      planned_count: 4,
      theme_categories: ['時間術'],
      series_candidates: [],
    },
  ],
  notes: 'テスト用メモ',
};

const FAKE_PLAN = {
  id: 'plan_1',
  account_id: 'acc_1',
  period_from: new Date('2026-06-01T00:00:00.000Z'),
  period_to: new Date('2026-08-01T00:00:00.000Z'),
  plan_json: FAKE_PLAN_JSON,
  created_at: new Date('2026-06-05T10:00:00.000Z'),
};

const FAKE_ACCOUNT = {
  id: 'acc_1',
  pen_name: 'テスト太郎',
  display_name: '太郎さん',
};

// ---------------------------------------------------------------------------
// serializePublishingPlan
// ---------------------------------------------------------------------------

describe('serializePublishingPlan', () => {
  it('Date を ISO 文字列に変換する', () => {
    const result = serializePublishingPlan(FAKE_PLAN);
    expect(result.period_from).toBe('2026-06-01T00:00:00.000Z');
    expect(result.period_to).toBe('2026-08-01T00:00:00.000Z');
    expect(result.created_at).toBe('2026-06-05T10:00:00.000Z');
  });

  it('plan_json の months を展開する', () => {
    const result = serializePublishingPlan(FAKE_PLAN);
    expect(result.months).toHaveLength(2);
    expect(result.months[0]!.ym).toBe('2026-06');
    expect(result.months[0]!.planned_count).toBe(5);
    expect(result.months[0]!.theme_categories).toEqual(['副業', 'AI 活用']);
    expect(result.months[0]!.series_candidates).toEqual(['副業の応用 Vol.2']);
  });

  it('notes を返す', () => {
    const result = serializePublishingPlan(FAKE_PLAN);
    expect(result.notes).toBe('テスト用メモ');
  });

  it('notes がない場合は null を返す', () => {
    const planNoNotes = { ...FAKE_PLAN, plan_json: { months: FAKE_PLAN_JSON.months } };
    const result = serializePublishingPlan(planNoNotes);
    expect(result.notes).toBeNull();
  });

  it('plan_json が不正な場合は months=[] を返す', () => {
    const planBadJson = { ...FAKE_PLAN, plan_json: 'invalid' as unknown as typeof FAKE_PLAN_JSON };
    const result = serializePublishingPlan(planBadJson);
    expect(result.months).toEqual([]);
  });

  it('plan_json が null の場合は months=[] を返す', () => {
    const planNullJson = { ...FAKE_PLAN, plan_json: null as unknown as typeof FAKE_PLAN_JSON };
    const result = serializePublishingPlan(planNullJson);
    expect(result.months).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// serializePlansPage
// ---------------------------------------------------------------------------

describe('serializePlansPage', () => {
  it('latestPlan が null の場合は null を返す', () => {
    const result = serializePlansPage(FAKE_ACCOUNT, null);
    expect(result.latestPlan).toBeNull();
  });

  it('latestPlan がある場合はシリアライズして返す', () => {
    const result = serializePlansPage(FAKE_ACCOUNT, FAKE_PLAN);
    expect(result.latestPlan).not.toBeNull();
    expect(result.latestPlan?.id).toBe('plan_1');
    expect(result.latestPlan?.months).toHaveLength(2);
  });

  it('account 情報を正しく返す', () => {
    const result = serializePlansPage(FAKE_ACCOUNT, null);
    expect(result.account.id).toBe('acc_1');
    expect(result.account.pen_name).toBe('テスト太郎');
    expect(result.account.display_name).toBe('太郎さん');
  });

  it('display_name が null の場合も動作する', () => {
    const accountNoDisplayName = { ...FAKE_ACCOUNT, display_name: null };
    const result = serializePlansPage(accountNoDisplayName, null);
    expect(result.account.display_name).toBeNull();
  });
});
