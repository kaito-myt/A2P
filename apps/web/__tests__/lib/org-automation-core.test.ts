import { describe, it, expect, vi } from 'vitest';

import {
  updateOrgAutomationCore,
  serializeOrgAutomation,
  UpdateOrgAutomationInputSchema,
  ORG_AUTOMATION_DEFAULTS,
  type OrgAutomationDeps,
} from '@/lib/org-automation-core';

function deps(overrides: Partial<OrgAutomationDeps> = {}): {
  deps: OrgAutomationDeps;
  updates: Array<{ where: unknown; data: Record<string, unknown> }>;
  audits: unknown[];
} {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const audits: unknown[] = [];
  const d: OrgAutomationDeps = {
    appSettingsRepo: {
      update: vi.fn(async (a: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(a);
        return {};
      }),
    },
    auditLogRepo: { create: vi.fn(async (a: unknown) => { audits.push(a); return {}; }) },
    session: { user: { id: 'u1' } } as OrgAutomationDeps['session'],
    ...overrides,
  };
  return { deps: d, updates, audits };
}

describe('serializeOrgAutomation', () => {
  it('boolean/cron を正規化しデフォルトを埋める', () => {
    const v = serializeOrgAutomation({
      org_auto_plan_enabled: true,
      org_plan_cron: '0 20 * * *',
      org_auto_execute_enabled: false,
      org_execute_cron: '',
      org_ops_watch_enabled: true,
      org_ops_watch_cron: '*/10 * * * *',
      org_finance_tick_enabled: false,
      org_finance_tick_cron: '0 * * * *',
      org_kdp_auto_publish_enabled: true,
      org_kdp_screen_cron: '30 * * * *',
    });
    expect(v.org_auto_plan_enabled).toBe(true);
    expect(v.org_plan_cron).toBe('0 20 * * *');
    // 空文字は falsy だが ?? はそのまま使う（空文字は現状の DB 値として尊重）
    expect(v.org_execute_cron).toBe('');
    expect(v.org_kdp_auto_publish_enabled).toBe(true);
  });

  it('未存在フィールドはデフォルトへフォールバック', () => {
    const v = serializeOrgAutomation({
      org_auto_plan_enabled: false,
      org_plan_cron: null as unknown as string,
      org_auto_execute_enabled: false,
      org_execute_cron: undefined as unknown as string,
      org_ops_watch_enabled: false,
      org_ops_watch_cron: undefined as unknown as string,
      org_finance_tick_enabled: false,
      org_finance_tick_cron: undefined as unknown as string,
      org_kdp_auto_publish_enabled: false,
      org_kdp_screen_cron: undefined as unknown as string,
    });
    expect(v).toEqual(ORG_AUTOMATION_DEFAULTS);
  });
});

describe('UpdateOrgAutomationInputSchema', () => {
  it('有効な cron 式は通す', () => {
    expect(UpdateOrgAutomationInputSchema.safeParse({ org_plan_cron: '0 20 * * *' }).success).toBe(true);
  });

  it('無効な cron 式は弾く', () => {
    expect(UpdateOrgAutomationInputSchema.safeParse({ org_plan_cron: 'not a cron' }).success).toBe(false);
    expect(UpdateOrgAutomationInputSchema.safeParse({ org_execute_cron: '* * *' }).success).toBe(false);
  });

  it('boolean フラグのみの部分更新も通す', () => {
    expect(UpdateOrgAutomationInputSchema.safeParse({ org_auto_plan_enabled: true }).success).toBe(true);
  });
});

describe('updateOrgAutomationCore', () => {
  it('指定フィールドのみ更新し audit を残す', async () => {
    const { deps: d, updates, audits } = deps();
    const res = await updateOrgAutomationCore(
      { org_auto_plan_enabled: true, org_plan_cron: '0 21 * * *' },
      d,
    );
    expect(res.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.where).toEqual({ id: 'singleton' });
    expect(updates[0]!.data.org_auto_plan_enabled).toBe(true);
    expect(updates[0]!.data.org_plan_cron).toBe('0 21 * * *');
    expect(updates[0]!.data.org_auto_execute_enabled).toBeUndefined();
    expect(audits).toHaveLength(1);
    const auditArg = audits[0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('org_automation.update');
  });

  it('空入力なら更新しない', async () => {
    const { deps: d, updates } = deps();
    const res = await updateOrgAutomationCore({}, d);
    expect(res.ok).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it('不正な cron は validation エラー', async () => {
    const { deps: d } = deps();
    const res = await updateOrgAutomationCore({ org_kdp_screen_cron: 'bogus' }, d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation');
  });

  it('5フラグ全て一括更新できる', async () => {
    const { deps: d, updates } = deps();
    const res = await updateOrgAutomationCore(
      {
        org_auto_plan_enabled: true,
        org_plan_cron: '0 20 * * *',
        org_auto_execute_enabled: true,
        org_execute_cron: '*/15 * * * *',
        org_ops_watch_enabled: true,
        org_ops_watch_cron: '*/10 * * * *',
        org_finance_tick_enabled: true,
        org_finance_tick_cron: '0 * * * *',
        org_kdp_auto_publish_enabled: true,
        org_kdp_screen_cron: '30 * * * *',
      },
      d,
    );
    expect(res.ok).toBe(true);
    expect(Object.keys(updates[0]!.data)).toHaveLength(10);
  });
});
