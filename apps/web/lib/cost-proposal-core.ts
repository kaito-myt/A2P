/**
 * F-062 — コスト改善提案の承認/却下と、安全・可逆なアクション実行のコアロジック。
 *
 * 承認時に実行できるのは「安全・可逆な設定変更」のみ:
 *  - switch_model_assignment: 役割のモデル割当をより安価なものへ切替（旧割当は archived、戻せる）。
 *  - set_app_setting: 許可リストの運用設定のみ変更（投稿頻度 cron / 見直しの ON/OFF 等）。
 *  - advisory: 自動実行しない（承認＝了承のみ）。
 *
 * 実 IO（prisma）は DI。副作用の無い純ロジックとしてユニットテスト可能。
 */
import { z } from 'zod';

import { fail, ok, type ActionResult } from '@a2p/contracts';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

const m = messages.costDashboard.proposals;

/** set_app_setting で変更を許可する設定キー（安全・可逆）。 */
export const COST_SETTING_ALLOWLIST: Record<string, 'string' | 'boolean'> = {
  promo_dispatch_cron: 'string',
  promo_review_cron: 'string',
  promo_daily_review_enabled: 'boolean',
  cost_analyze_cron: 'string',
};

const VALID_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

export interface CostProposalRow {
  id: string;
  status: string;
  action_kind: string;
  action_params_json: unknown;
}

export interface CostProposalRepo {
  findUnique(args: { where: { id: string }; select: { id: true; status: true; action_kind: true; action_params_json: true } }): Promise<CostProposalRow | null>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
}

export interface ModelAssignmentRepo {
  updateMany(args: { where: { role: string; genre: string | null; status: string }; data: { status: string; archived_at: Date } }): Promise<{ count: number }>;
  create(args: { data: { role: string; genre: string | null; provider: string; model: string; status: string; created_by: string } }): Promise<unknown>;
}

export interface AppSettingsRepo {
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
}

export interface AuditLogRepo {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

export interface CostProposalDeps {
  proposalRepo: CostProposalRepo;
  modelAssignmentRepo: ModelAssignmentRepo;
  appSettingsRepo: AppSettingsRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  now?: () => Date;
}

const IdSchema = z.object({ id: z.string().min(1) });

/**
 * アクションを実行する（承認済み想定）。成功時 {message}、失敗時は理由を返す。
 */
export async function applyProposalAction(
  actionKind: string,
  params: unknown,
  deps: CostProposalDeps,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const now = deps.now ?? (() => new Date());
  const p = (params ?? {}) as Record<string, unknown>;

  if (actionKind === 'advisory') {
    return { ok: true, message: m.applied.advisory };
  }

  if (actionKind === 'switch_model_assignment') {
    const role = typeof p.role === 'string' ? p.role.trim() : '';
    const provider = typeof p.provider === 'string' ? p.provider.trim() : '';
    const model = typeof p.model === 'string' ? p.model.trim() : '';
    const genre = typeof p.genre === 'string' && p.genre.trim().length > 0 ? p.genre.trim() : null;
    if (!role || !VALID_PROVIDERS.has(provider) || !model) {
      return { ok: false, message: m.applied.invalidModelAction };
    }
    // 旧 active を archived にしてから新規 active を作成（part-unique 制約回避）。
    await deps.modelAssignmentRepo.updateMany({
      where: { role, genre, status: 'active' },
      data: { status: 'archived', archived_at: now() },
    });
    await deps.modelAssignmentRepo.create({
      data: { role, genre, provider, model, status: 'active', created_by: deps.session.user.id },
    });
    return { ok: true, message: m.applied.modelSwitched(role, `${provider}/${model}`) };
  }

  if (actionKind === 'set_app_setting') {
    const key = typeof p.key === 'string' ? p.key.trim() : '';
    const expected = COST_SETTING_ALLOWLIST[key];
    if (!expected) {
      return { ok: false, message: m.applied.settingNotAllowed(key || '(空)') };
    }
    let value: string | boolean;
    if (expected === 'boolean') {
      value = p.value === true || p.value === 'true';
    } else {
      if (typeof p.value !== 'string' || p.value.trim().length === 0) {
        return { ok: false, message: m.applied.settingInvalidValue };
      }
      value = p.value.trim();
    }
    await deps.appSettingsRepo.update({ where: { id: 'singleton' }, data: { [key]: value } });
    return { ok: true, message: m.applied.settingChanged(key, String(value)) };
  }

  return { ok: false, message: m.applied.unknownAction(actionKind) };
}

/**
 * 提案を承認し、アクションを実行する。status を applied/failed に更新。
 */
export async function approveCostProposalCore(
  input: unknown,
  deps: CostProposalDeps,
): Promise<ActionResult<{ id: string; applied: boolean; message: string }>> {
  const parsed = IdSchema.safeParse(input);
  if (!parsed.success) return fail('validation', m.error);
  const now = deps.now ?? (() => new Date());

  const proposal = await deps.proposalRepo.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, status: true, action_kind: true, action_params_json: true },
  });
  if (!proposal) return fail('not_found', m.error);
  if (proposal.status === 'applied') {
    return ok({ id: proposal.id, applied: true, message: m.applied.alreadyApplied });
  }
  if (proposal.status === 'dismissed') {
    return fail('conflict', m.applied.alreadyDismissed);
  }

  const result = await applyProposalAction(proposal.action_kind, proposal.action_params_json, deps);

  await deps.proposalRepo.update({
    where: { id: proposal.id },
    data: {
      status: result.ok ? 'applied' : 'failed',
      applied_at: result.ok ? now() : null,
      apply_result: result.message.slice(0, 500),
    },
  });
  await deps.auditLogRepo.create({
    data: {
      actor_id: deps.session.user.id,
      action: 'cost_proposal.approve',
      target_kind: 'cost_improvement_proposal',
      target_id: proposal.id,
      after_json: { action_kind: proposal.action_kind, ok: result.ok, message: result.message },
    },
  });

  if (!result.ok) return fail('unknown', result.message);
  return ok({ id: proposal.id, applied: true, message: result.message });
}

/** 提案を却下する（実行しない）。 */
export async function dismissCostProposalCore(
  input: unknown,
  deps: CostProposalDeps,
): Promise<ActionResult<{ id: string }>> {
  const parsed = IdSchema.safeParse(input);
  if (!parsed.success) return fail('validation', m.error);

  const proposal = await deps.proposalRepo.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, status: true, action_kind: true, action_params_json: true },
  });
  if (!proposal) return fail('not_found', m.error);
  if (proposal.status === 'applied') return fail('conflict', m.applied.alreadyApplied);

  await deps.proposalRepo.update({ where: { id: proposal.id }, data: { status: 'dismissed' } });
  await deps.auditLogRepo.create({
    data: {
      actor_id: deps.session.user.id,
      action: 'cost_proposal.dismiss',
      target_kind: 'cost_improvement_proposal',
      target_id: proposal.id,
      after_json: { dismissed: true },
    },
  });
  return ok({ id: proposal.id });
}
