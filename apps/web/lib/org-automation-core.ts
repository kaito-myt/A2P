/**
 * 経営（AI 組織）の自律運用フラグ (S-org-automation) の読み書きコアロジック。
 *
 * CEOティック(org.plan)/実行ディスパッチ(org.execute)/障害自己復旧(org.ops.watch)/
 * 予算ガード(org.finance.tick)/KDP事前審査(org.kdp.screen) を cron で自動起動するかを
 * AppSettings(singleton) に保存する。各フラグは worker 起動時に
 * `fetchAppSettingsForCron` (apps/worker/src/runner.ts) が読み crontab.ts のエントリを
 * ゲートするため、cron の変更は worker 再起動後にしか反映されない。
 *
 * `app/actions/org-automation.ts` (SA ラッパ) から呼ばれる。依存は DI で受け取り Vitest 可能にする。
 * 設計は pipeline-settings-core.ts と同じ DI パターンだが、独立モジュールにしている。
 *
 * 仕様根拠: docs/06 (経営エージェント) / packages/db/schema.prisma AppSettings org_* フィールド
 */
import { z } from 'zod';

import { isA2PError, fail, ok, type ActionResult } from '@a2p/contracts';
import { Prisma } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { isValidCronExpression } from './cron-utils';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// 入力スキーマ (全フィールド optional — 部分更新可)
// ---------------------------------------------------------------------------

const cronField = z
  .string()
  .trim()
  .refine((v) => isValidCronExpression(v), { message: messages.orgAutomation.cronErrorInvalid });

export const UpdateOrgAutomationInputSchema = z.object({
  org_auto_plan_enabled: z.boolean().optional(),
  org_plan_cron: cronField.optional(),
  org_auto_execute_enabled: z.boolean().optional(),
  org_execute_cron: cronField.optional(),
  org_ops_watch_enabled: z.boolean().optional(),
  org_ops_watch_cron: cronField.optional(),
  org_finance_tick_enabled: z.boolean().optional(),
  org_finance_tick_cron: cronField.optional(),
  org_kdp_auto_publish_enabled: z.boolean().optional(),
  org_kdp_screen_cron: cronField.optional(),
});

export type UpdateOrgAutomationInput = z.infer<typeof UpdateOrgAutomationInputSchema>;

// ---------------------------------------------------------------------------
// ビュー型 (RSC → Client)
// ---------------------------------------------------------------------------

export interface OrgAutomationView {
  org_auto_plan_enabled: boolean;
  org_plan_cron: string;
  org_auto_execute_enabled: boolean;
  org_execute_cron: string;
  org_ops_watch_enabled: boolean;
  org_ops_watch_cron: string;
  org_finance_tick_enabled: boolean;
  org_finance_tick_cron: string;
  org_kdp_auto_publish_enabled: boolean;
  org_kdp_screen_cron: string;
}

interface RawOrgAutomation {
  org_auto_plan_enabled: boolean;
  org_plan_cron: string;
  org_auto_execute_enabled: boolean;
  org_execute_cron: string;
  org_ops_watch_enabled: boolean;
  org_ops_watch_cron: string;
  org_finance_tick_enabled: boolean;
  org_finance_tick_cron: string;
  org_kdp_auto_publish_enabled: boolean;
  org_kdp_screen_cron: string;
}

/** AppSettings 行未存在時のデフォルト（packages/db/schema.prisma の @default と一致）。 */
export const ORG_AUTOMATION_DEFAULTS: OrgAutomationView = {
  org_auto_plan_enabled: false,
  org_plan_cron: '0 20 * * *',
  org_auto_execute_enabled: false,
  org_execute_cron: '*/15 * * * *',
  org_ops_watch_enabled: false,
  org_ops_watch_cron: '*/10 * * * *',
  org_finance_tick_enabled: false,
  org_finance_tick_cron: '0 * * * *',
  org_kdp_auto_publish_enabled: false,
  org_kdp_screen_cron: '30 * * * *',
};

export function serializeOrgAutomation(raw: RawOrgAutomation): OrgAutomationView {
  return {
    org_auto_plan_enabled: Boolean(raw.org_auto_plan_enabled),
    org_plan_cron: raw.org_plan_cron ?? ORG_AUTOMATION_DEFAULTS.org_plan_cron,
    org_auto_execute_enabled: Boolean(raw.org_auto_execute_enabled),
    org_execute_cron: raw.org_execute_cron ?? ORG_AUTOMATION_DEFAULTS.org_execute_cron,
    org_ops_watch_enabled: Boolean(raw.org_ops_watch_enabled),
    org_ops_watch_cron: raw.org_ops_watch_cron ?? ORG_AUTOMATION_DEFAULTS.org_ops_watch_cron,
    org_finance_tick_enabled: Boolean(raw.org_finance_tick_enabled),
    org_finance_tick_cron: raw.org_finance_tick_cron ?? ORG_AUTOMATION_DEFAULTS.org_finance_tick_cron,
    org_kdp_auto_publish_enabled: Boolean(raw.org_kdp_auto_publish_enabled),
    org_kdp_screen_cron: raw.org_kdp_screen_cron ?? ORG_AUTOMATION_DEFAULTS.org_kdp_screen_cron,
  };
}

// ---------------------------------------------------------------------------
// DI 境界
// ---------------------------------------------------------------------------

export interface OrgAutomationAppSettingsRepo {
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
}

export interface OrgAutomationAuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export interface OrgAutomationDeps {
  appSettingsRepo: OrgAutomationAppSettingsRepo;
  auditLogRepo: OrgAutomationAuditLogRepo;
  session: AuthenticatedSession;
}

// ---------------------------------------------------------------------------
// コア
// ---------------------------------------------------------------------------

export async function updateOrgAutomationCore(
  input: unknown,
  deps: OrgAutomationDeps,
): Promise<ActionResult<void>> {
  const parsed = UpdateOrgAutomationInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', messages.orgAutomation.errors.validation, parsed.error.flatten());
  }
  const data = parsed.data;

  const updateData: Record<string, unknown> = {};
  if (data.org_auto_plan_enabled !== undefined) updateData.org_auto_plan_enabled = data.org_auto_plan_enabled;
  if (data.org_plan_cron !== undefined) updateData.org_plan_cron = data.org_plan_cron;
  if (data.org_auto_execute_enabled !== undefined) updateData.org_auto_execute_enabled = data.org_auto_execute_enabled;
  if (data.org_execute_cron !== undefined) updateData.org_execute_cron = data.org_execute_cron;
  if (data.org_ops_watch_enabled !== undefined) updateData.org_ops_watch_enabled = data.org_ops_watch_enabled;
  if (data.org_ops_watch_cron !== undefined) updateData.org_ops_watch_cron = data.org_ops_watch_cron;
  if (data.org_finance_tick_enabled !== undefined) updateData.org_finance_tick_enabled = data.org_finance_tick_enabled;
  if (data.org_finance_tick_cron !== undefined) updateData.org_finance_tick_cron = data.org_finance_tick_cron;
  if (data.org_kdp_auto_publish_enabled !== undefined) updateData.org_kdp_auto_publish_enabled = data.org_kdp_auto_publish_enabled;
  if (data.org_kdp_screen_cron !== undefined) updateData.org_kdp_screen_cron = data.org_kdp_screen_cron;

  if (Object.keys(updateData).length === 0) {
    return ok(undefined as void);
  }

  try {
    await deps.appSettingsRepo.update({ where: { id: 'singleton' }, data: updateData });
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'org_automation.update',
        target_kind: 'app_settings',
        target_id: 'singleton',
        after_json: updateData as unknown as Prisma.InputJsonValue,
      },
    });
    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.orgAutomation.errors.unknown);
  }
}
