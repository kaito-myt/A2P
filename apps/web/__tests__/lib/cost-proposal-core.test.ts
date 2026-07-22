/**
 * F-062 — コスト改善提案の承認/却下・安全実行のテスト。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  approveCostProposalCore,
  dismissCostProposalCore,
  COST_SETTING_ALLOWLIST,
  type CostProposalDeps,
  type CostProposalRow,
} from '@/lib/cost-proposal-core';

const session = { user: { id: 'u1', username: 'op' } } as never;

function buildDeps(proposal: CostProposalRow | null) {
  const modelAssignmentRepo = { updateMany: vi.fn(async () => ({ count: 1 })), create: vi.fn(async () => ({})) };
  const appSettingsRepo = { update: vi.fn(async () => ({})) };
  const auditLogRepo = { create: vi.fn(async () => ({})) };
  const proposalUpdate = vi.fn(async () => ({}));
  const proposalRepo = { findUnique: vi.fn(async () => proposal), update: proposalUpdate };
  const deps: CostProposalDeps = {
    proposalRepo: proposalRepo as never,
    modelAssignmentRepo: modelAssignmentRepo as never,
    appSettingsRepo: appSettingsRepo as never,
    auditLogRepo: auditLogRepo as never,
    session,
    now: () => new Date('2026-07-22T00:00:00Z'),
  };
  return { deps, modelAssignmentRepo, appSettingsRepo, proposalUpdate };
}

describe('approveCostProposalCore', () => {
  it('switch_model_assignment: 旧割当を archive → 新規 active 作成、applied に更新', async () => {
    const { deps, modelAssignmentRepo, proposalUpdate } = buildDeps({
      id: 'p1', status: 'proposed', action_kind: 'switch_model_assignment',
      action_params_json: { role: 'editor', genre: null, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    });
    const res = await approveCostProposalCore({ id: 'p1' }, deps);
    expect(res.ok).toBe(true);
    expect(modelAssignmentRepo.updateMany).toHaveBeenCalledWith({
      where: { role: 'editor', genre: null, status: 'active' },
      data: { status: 'archived', archived_at: expect.any(Date) },
    });
    expect(modelAssignmentRepo.create).toHaveBeenCalledWith({
      data: { role: 'editor', genre: null, provider: 'anthropic', model: 'claude-haiku-4-5-20251001', status: 'active', created_by: 'u1' },
    });
    expect(proposalUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p1' }, data: expect.objectContaining({ status: 'applied' }) }));
  });

  it('set_app_setting: 許可キーは app_settings を更新', async () => {
    const { deps, appSettingsRepo } = buildDeps({
      id: 'p2', status: 'proposed', action_kind: 'set_app_setting',
      action_params_json: { key: 'promo_dispatch_cron', value: '0 */2 * * *' },
    });
    const res = await approveCostProposalCore({ id: 'p2' }, deps);
    expect(res.ok).toBe(true);
    expect(appSettingsRepo.update).toHaveBeenCalledWith({ where: { id: 'singleton' }, data: { promo_dispatch_cron: '0 */2 * * *' } });
  });

  it('set_app_setting: 許可外キーは実行せず失敗(status=failed)', async () => {
    const { deps, appSettingsRepo, proposalUpdate } = buildDeps({
      id: 'p3', status: 'proposed', action_kind: 'set_app_setting',
      action_params_json: { key: 'monthly_budget_jpy', value: 0 },
    });
    const res = await approveCostProposalCore({ id: 'p3' }, deps);
    expect(res.ok).toBe(false);
    expect(appSettingsRepo.update).not.toHaveBeenCalled();
    expect(proposalUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }));
  });

  it('switch_model_assignment: 不正プロバイダは失敗', async () => {
    const { deps, modelAssignmentRepo } = buildDeps({
      id: 'p4', status: 'proposed', action_kind: 'switch_model_assignment',
      action_params_json: { role: 'writer', provider: 'evilai', model: 'x' },
    });
    const res = await approveCostProposalCore({ id: 'p4' }, deps);
    expect(res.ok).toBe(false);
    expect(modelAssignmentRepo.create).not.toHaveBeenCalled();
  });

  it('advisory: 実行はせず applied(了承)にする', async () => {
    const { deps, modelAssignmentRepo, appSettingsRepo } = buildDeps({
      id: 'p5', status: 'proposed', action_kind: 'advisory', action_params_json: {},
    });
    const res = await approveCostProposalCore({ id: 'p5' }, deps);
    expect(res.ok).toBe(true);
    expect(modelAssignmentRepo.create).not.toHaveBeenCalled();
    expect(appSettingsRepo.update).not.toHaveBeenCalled();
  });

  it('却下済みは承認できない', async () => {
    const { deps } = buildDeps({ id: 'p6', status: 'dismissed', action_kind: 'advisory', action_params_json: {} });
    const res = await approveCostProposalCore({ id: 'p6' }, deps);
    expect(res.ok).toBe(false);
  });
});

describe('dismissCostProposalCore', () => {
  it('proposed を dismissed に更新', async () => {
    const { deps, proposalUpdate } = buildDeps({ id: 'p7', status: 'proposed', action_kind: 'advisory', action_params_json: {} });
    const res = await dismissCostProposalCore({ id: 'p7' }, deps);
    expect(res.ok).toBe(true);
    expect(proposalUpdate).toHaveBeenCalledWith({ where: { id: 'p7' }, data: { status: 'dismissed' } });
  });

  it('applied は却下できない', async () => {
    const { deps } = buildDeps({ id: 'p8', status: 'applied', action_kind: 'advisory', action_params_json: {} });
    const res = await dismissCostProposalCore({ id: 'p8' }, deps);
    expect(res.ok).toBe(false);
  });
});

describe('COST_SETTING_ALLOWLIST', () => {
  it('危険な予算/コスト上限キーは含まない', () => {
    expect(COST_SETTING_ALLOWLIST.monthly_budget_jpy).toBeUndefined();
    expect(COST_SETTING_ALLOWLIST.promo_dispatch_cron).toBe('string');
    expect(COST_SETTING_ALLOWLIST.promo_daily_review_enabled).toBe('boolean');
  });
});
