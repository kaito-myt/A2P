/**
 * settings-core.ts unit tests (T-07-09, S-027).
 *
 * Checks:
 *  1. Valid save persists AppSettings + writes audit_log row
 *  2. Invalid input (email, out-of-range) → validation fail
 *  3. API key plaintext never appears in audit_log payload
 *  4. Per-book warn >= pause → validation fail (cross-field)
 *  5. Monthly threshold ordering enforced
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  updateSettingsCore,
  type SettingsDeps,
  type AppSettingsRepo,
  type AuditLogRepo,
  type AppSettingsRow,
} from '../../lib/settings-core';

const FROZEN_NOW = new Date('2026-06-04T10:00:00.000Z');

const BASE_ROW: AppSettingsRow = {
  id: 'singleton',
  notification_email_to: 'old@example.com',
  notification_kinds_json: { cost_per_book_warn: true },
  cost_per_book_warn_jpy: 500,
  cost_per_book_pause_jpy: 750,
  monthly_cost_yellow_jpy: 40000,
  monthly_cost_orange_jpy: 47500,
  monthly_cost_red_jpy: 50000,
  catalog_price_change_threshold: 0.10,
  prompt_auto_approval_enabled: false,
  prompt_auto_approval_rollback_h: 24,
  sales_auto_fetch_enabled: false,
  sales_auto_fetch_cron: '0 17 * * *',
  kdp_submit_timeout_minutes: 10,
  kdp_submit_retry_count: 2,
  job_log_retention_days: 90,
  r2_archive_threshold_days: 365,
  ai_disclosure_text: 'disclosure',
};

function makeDeps(opts: {
  existing?: AppSettingsRow | null;
} = {}): {
  deps: SettingsDeps;
  spies: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
  };
} {
  const currentRow = opts.existing !== undefined ? opts.existing : BASE_ROW;

  const findUnique = vi.fn(async () => currentRow);
  const update = vi.fn(async ({ data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    ...BASE_ROW,
    ...data,
  } as AppSettingsRow));
  const auditCreate = vi.fn(async () => ({}));

  const appSettingsRepo: AppSettingsRepo = { findUnique, update };
  const auditLogRepo: AuditLogRepo = { create: auditCreate };

  return {
    deps: {
      appSettingsRepo,
      auditLogRepo,
      session: { user: { id: 'u_1', username: 'operator' } },
      now: FROZEN_NOW,
    },
    spies: { findUnique, update, auditCreate },
  };
}

// ---------------------------------------------------------------------------
// updateSettingsCore — valid save
// ---------------------------------------------------------------------------

describe('updateSettingsCore — valid save', () => {
  it('saves notification email and writes audit_log', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateSettingsCore(
      { notification_email_to: 'new@example.com' },
      deps,
    );
    expect(isOk(result)).toBe(true);
    expect(spies.update).toHaveBeenCalledTimes(1);
    const updateArg = spies.update.mock.calls[0]?.[0];
    expect(updateArg.where).toEqual({ id: 'singleton' });
    expect(updateArg.data.notification_email_to).toBe('new@example.com');

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    expect(auditArg.data.action).toBe('settings.update');
    expect(auditArg.data.target_kind).toBe('app_settings');
    expect(auditArg.data.actor_id).toBe('u_1');
  });

  it('saves threshold values', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateSettingsCore(
      {
        cost_per_book_warn_jpy: 400,
        cost_per_book_pause_jpy: 600,
      },
      deps,
    );
    expect(isOk(result)).toBe(true);
    const updateArg = spies.update.mock.calls[0]?.[0];
    expect(updateArg.data.cost_per_book_warn_jpy).toBe(400);
    expect(updateArg.data.cost_per_book_pause_jpy).toBe(600);
  });

  it('saves notification_kinds as notification_kinds_json', async () => {
    const { deps, spies } = makeDeps();
    const kinds = { cost_per_book_warn: false, job_failed: true };
    const result = await updateSettingsCore({ notification_kinds: kinds }, deps);
    expect(isOk(result)).toBe(true);
    const updateArg = spies.update.mock.calls[0]?.[0];
    expect(updateArg.data.notification_kinds_json).toEqual(kinds);
  });

  it('saves r2_archive_threshold_days', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateSettingsCore({ r2_archive_threshold_days: 180 }, deps);
    expect(isOk(result)).toBe(true);
    const updateArg = spies.update.mock.calls[0]?.[0];
    expect(updateArg.data.r2_archive_threshold_days).toBe(180);
  });
});

// ---------------------------------------------------------------------------
// updateSettingsCore — validation failures
// ---------------------------------------------------------------------------

describe('updateSettingsCore — validation failures', () => {
  it('invalid email fails with validation code', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateSettingsCore({ notification_email_to: 'not-an-email' }, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('job_log_retention_days out of range fails', async () => {
    const { deps } = makeDeps();
    const result = await updateSettingsCore({ job_log_retention_days: 3 }, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('r2_archive_threshold_days out of range fails', async () => {
    const { deps } = makeDeps();
    const result = await updateSettingsCore({ r2_archive_threshold_days: 10 }, deps);
    expect(isFail(result)).toBe(true);
  });

  it('warn >= pause triggers cross-field validation', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateSettingsCore(
      { cost_per_book_warn_jpy: 750, cost_per_book_pause_jpy: 750 },
      deps,
    );
    expect(isFail(result)).toBe(true);
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('monthly thresholds out of order triggers validation', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateSettingsCore(
      {
        monthly_cost_yellow_jpy: 50000,
        monthly_cost_orange_jpy: 40000,
        monthly_cost_red_jpy: 50000,
      },
      deps,
    );
    expect(isFail(result)).toBe(true);
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('empty object is valid (no-op partial update)', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateSettingsCore({}, deps);
    expect(isOk(result)).toBe(true);
    // update IS still called (with empty data), audit IS still written
    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// updateSettingsCore — audit_log must NOT contain API key plaintext
// ---------------------------------------------------------------------------

describe('updateSettingsCore — audit_log API key safety', () => {
  it('before_json in audit does not contain api key fields', async () => {
    const { deps, spies } = makeDeps();
    await updateSettingsCore({ notification_email_to: 'safe@example.com' }, deps);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    const beforeJson = auditArg?.data?.before_json;
    const afterJson = auditArg?.data?.after_json;

    // These fields must never appear in audit log — API keys are handled by api-credentials SA only
    const forbiddenFields = ['key', 'key_enc', 'api_key', 'anthropic_key', 'openai_key', 'google_key', 'tavily_key'];
    for (const field of forbiddenFields) {
      if (beforeJson && typeof beforeJson === 'object') {
        expect(beforeJson).not.toHaveProperty(field);
      }
      if (afterJson && typeof afterJson === 'object') {
        expect(afterJson).not.toHaveProperty(field);
      }
    }
  });

  it('any input containing an "api_key" field is silently ignored (not persisted)', async () => {
    const { deps, spies } = makeDeps();
    // updateSettingsCore input schema does NOT include api key fields
    // so sending one is a validation fail (extra keys are stripped by zod by default)
    const result = await updateSettingsCore(
      { notification_email_to: 'test@example.com', api_key: 'sk-ant-secret' } as unknown,
      deps,
    );
    // Should still succeed (zod strips unknown keys)
    expect(isOk(result)).toBe(true);
    const updateArg = spies.update.mock.calls[0]?.[0];
    // The api_key field must not be in the data written to DB
    expect(updateArg.data).not.toHaveProperty('api_key');
  });
});
