/**
 * updateSettings Server Action core logic (T-07-09, S-027).
 *
 * `app/actions/settings.ts` (SA wrapper) から呼ばれる業務ロジック。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする。
 * API キー平文は audit_log に残さない (CLAUDE.md Hard Rule / docs/05 §4.3.15)。
 *
 * 仕様根拠:
 *  - docs/05 §4.3.15 updateSettings SA
 *  - docs/04 S-027
 */
import { z } from 'zod';

import {
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import { Prisma } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schema (docs/05 §4.3.15)
// ---------------------------------------------------------------------------

export const UpdateSettingsInputSchema = z.object({
  notification_email_to: z.string().email().optional(),
  notification_kinds: z.record(z.string(), z.boolean()).optional(),
  cost_per_book_warn_jpy: z.number().int().positive().optional(),
  cost_per_book_pause_jpy: z.number().int().positive().optional(),
  monthly_cost_yellow_jpy: z.number().int().positive().optional(),
  monthly_cost_orange_jpy: z.number().int().positive().optional(),
  monthly_cost_red_jpy: z.number().int().positive().optional(),
  catalog_price_change_threshold: z.number().min(0).max(1).optional(),
  prompt_auto_approval_enabled: z.boolean().optional(),
  prompt_auto_approval_rollback_h: z.number().int().min(1).max(168).optional(),
  sales_auto_fetch_enabled: z.boolean().optional(),
  sales_auto_fetch_cron: z.string().optional(),
  kdp_submit_timeout_minutes: z.number().int().min(1).max(60).optional(),
  kdp_submit_retry_count: z.number().int().min(0).max(5).optional(),
  job_log_retention_days: z.number().int().min(7).max(365).optional(),
  r2_archive_threshold_days: z.number().int().min(30).max(3650).optional(),
  ai_disclosure_text: z.string().max(2000).optional(),
});

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInputSchema>;

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface AppSettingsRow {
  id: string;
  notification_email_to: string;
  notification_kinds_json: unknown;
  cost_per_book_warn_jpy: number;
  cost_per_book_pause_jpy: number;
  monthly_cost_yellow_jpy: number;
  monthly_cost_orange_jpy: number;
  monthly_cost_red_jpy: number;
  catalog_price_change_threshold: unknown;
  prompt_auto_approval_enabled: boolean;
  prompt_auto_approval_rollback_h: number;
  sales_auto_fetch_enabled: boolean;
  sales_auto_fetch_cron: string;
  kdp_submit_timeout_minutes: number;
  kdp_submit_retry_count: number;
  job_log_retention_days: number;
  r2_archive_threshold_days: number;
  ai_disclosure_text: string;
}

export interface AppSettingsRepo {
  findUnique(args: { where: { id: string } }): Promise<AppSettingsRow | null>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<AppSettingsRow>;
}

export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export interface SettingsDeps {
  appSettingsRepo: AppSettingsRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Safely extract a plain-object snapshot for audit_log.
 * API key plaintext must never appear in this log.
 */
function sanitizeForAudit(row: AppSettingsRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    notification_email_to: row.notification_email_to,
    notification_kinds_json: row.notification_kinds_json,
    cost_per_book_warn_jpy: row.cost_per_book_warn_jpy,
    cost_per_book_pause_jpy: row.cost_per_book_pause_jpy,
    monthly_cost_yellow_jpy: row.monthly_cost_yellow_jpy,
    monthly_cost_orange_jpy: row.monthly_cost_orange_jpy,
    monthly_cost_red_jpy: row.monthly_cost_red_jpy,
    catalog_price_change_threshold: row.catalog_price_change_threshold,
    prompt_auto_approval_enabled: row.prompt_auto_approval_enabled,
    prompt_auto_approval_rollback_h: row.prompt_auto_approval_rollback_h,
    job_log_retention_days: row.job_log_retention_days,
    r2_archive_threshold_days: row.r2_archive_threshold_days,
  };
}

export async function updateSettingsCore(
  input: unknown,
  deps: SettingsDeps,
): Promise<ActionResult<void>> {
  const parsed = UpdateSettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', messages.settings.errors.validation, parsed.error.flatten());
  }

  const data = parsed.data;

  // Business rule: per-book warn must be less than pause
  if (
    data.cost_per_book_warn_jpy !== undefined &&
    data.cost_per_book_pause_jpy !== undefined &&
    data.cost_per_book_warn_jpy >= data.cost_per_book_pause_jpy
  ) {
    return fail('validation', messages.settings.errors.perBookWarnGtPause);
  }

  // Business rule: monthly thresholds must be in ascending order
  if (
    data.monthly_cost_yellow_jpy !== undefined &&
    data.monthly_cost_orange_jpy !== undefined &&
    data.monthly_cost_yellow_jpy >= data.monthly_cost_orange_jpy
  ) {
    return fail('validation', messages.settings.errors.monthlyThresholdOrder);
  }
  if (
    data.monthly_cost_orange_jpy !== undefined &&
    data.monthly_cost_red_jpy !== undefined &&
    data.monthly_cost_orange_jpy >= data.monthly_cost_red_jpy
  ) {
    return fail('validation', messages.settings.errors.monthlyThresholdOrder);
  }

  try {
    const before = await deps.appSettingsRepo.findUnique({ where: { id: 'singleton' } });

    const updateData: Record<string, unknown> = {};
    if (data.notification_email_to !== undefined) {
      updateData.notification_email_to = data.notification_email_to;
    }
    if (data.notification_kinds !== undefined) {
      updateData.notification_kinds_json = data.notification_kinds as Prisma.InputJsonValue;
    }
    if (data.cost_per_book_warn_jpy !== undefined) {
      updateData.cost_per_book_warn_jpy = data.cost_per_book_warn_jpy;
    }
    if (data.cost_per_book_pause_jpy !== undefined) {
      updateData.cost_per_book_pause_jpy = data.cost_per_book_pause_jpy;
    }
    if (data.monthly_cost_yellow_jpy !== undefined) {
      updateData.monthly_cost_yellow_jpy = data.monthly_cost_yellow_jpy;
    }
    if (data.monthly_cost_orange_jpy !== undefined) {
      updateData.monthly_cost_orange_jpy = data.monthly_cost_orange_jpy;
    }
    if (data.monthly_cost_red_jpy !== undefined) {
      updateData.monthly_cost_red_jpy = data.monthly_cost_red_jpy;
    }
    if (data.catalog_price_change_threshold !== undefined) {
      updateData.catalog_price_change_threshold = data.catalog_price_change_threshold;
    }
    if (data.prompt_auto_approval_enabled !== undefined) {
      updateData.prompt_auto_approval_enabled = data.prompt_auto_approval_enabled;
    }
    if (data.prompt_auto_approval_rollback_h !== undefined) {
      updateData.prompt_auto_approval_rollback_h = data.prompt_auto_approval_rollback_h;
    }
    if (data.sales_auto_fetch_enabled !== undefined) {
      updateData.sales_auto_fetch_enabled = data.sales_auto_fetch_enabled;
    }
    if (data.sales_auto_fetch_cron !== undefined) {
      updateData.sales_auto_fetch_cron = data.sales_auto_fetch_cron;
    }
    if (data.kdp_submit_timeout_minutes !== undefined) {
      updateData.kdp_submit_timeout_minutes = data.kdp_submit_timeout_minutes;
    }
    if (data.kdp_submit_retry_count !== undefined) {
      updateData.kdp_submit_retry_count = data.kdp_submit_retry_count;
    }
    if (data.job_log_retention_days !== undefined) {
      updateData.job_log_retention_days = data.job_log_retention_days;
    }
    if (data.r2_archive_threshold_days !== undefined) {
      updateData.r2_archive_threshold_days = data.r2_archive_threshold_days;
    }
    if (data.ai_disclosure_text !== undefined) {
      updateData.ai_disclosure_text = data.ai_disclosure_text;
    }

    const after = await deps.appSettingsRepo.update({
      where: { id: 'singleton' },
      data: updateData,
    });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'settings.update',
        target_kind: 'app_settings',
        target_id: 'singleton',
        before_json: (sanitizeForAudit(before) ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        after_json: sanitizeForAudit(after) as unknown as Prisma.InputJsonValue,
      },
    });

    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.settings.errors.unknown);
  }
}
