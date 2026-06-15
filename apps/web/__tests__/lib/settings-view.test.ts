/**
 * settings-view.ts unit tests (T-07-09, S-027).
 *
 * Checks:
 *  - serializeSettingsPage normalizes Decimal / Json / Date fields
 *  - ApiCredential status resolution: db > env > unset
 *  - key_mask propagated, key_enc never exposed
 *  - last_test_result_json deserialized correctly
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  serializeSettingsPage,
  type ApiCredentialStatusRow,
} from '../../lib/settings-view';

const BASE_SETTINGS = {
  notification_email_to: 'admin@example.com',
  notification_kinds_json: { cost_per_book_warn: true, job_failed: false },
  cost_per_book_warn_jpy: 500,
  cost_per_book_pause_jpy: 750,
  monthly_cost_yellow_jpy: 40000,
  monthly_cost_orange_jpy: 47500,
  monthly_cost_red_jpy: 50000,
  catalog_price_change_threshold: { toString: () => '0.10', valueOf: () => 0.10 }, // Decimal-like
  prompt_auto_approval_enabled: false,
  prompt_auto_approval_rollback_h: 24,
  sales_auto_fetch_enabled: false,
  sales_auto_fetch_cron: '0 17 * * *',
  kdp_submit_timeout_minutes: 10,
  kdp_submit_retry_count: 2,
  job_log_retention_days: 90,
  r2_archive_threshold_days: 365,
  ai_disclosure_text: 'AI disclosure.',
};

const EMPTY_CREDENTIALS: Array<{
  provider: string;
  key_mask: string;
  last_tested_at: Date | null;
  last_test_result_json: unknown;
}> = [];

describe('serializeSettingsPage — basic fields', () => {
  it('propagates string/int fields correctly', () => {
    const data = serializeSettingsPage(BASE_SETTINGS as any, EMPTY_CREDENTIALS);
    expect(data.notification_email_to).toBe('admin@example.com');
    expect(data.cost_per_book_warn_jpy).toBe(500);
    expect(data.job_log_retention_days).toBe(90);
    expect(data.r2_archive_threshold_days).toBe(365);
    expect(data.ai_disclosure_text).toBe('AI disclosure.');
  });

  it('converts Decimal-like catalog_price_change_threshold to number', () => {
    const data = serializeSettingsPage(BASE_SETTINGS as any, EMPTY_CREDENTIALS);
    expect(typeof data.catalog_price_change_threshold).toBe('number');
    expect(data.catalog_price_change_threshold).toBeCloseTo(0.10);
  });

  it('deserializes notification_kinds_json to plain record', () => {
    const data = serializeSettingsPage(BASE_SETTINGS as any, EMPTY_CREDENTIALS);
    expect(data.notification_kinds).toEqual({ cost_per_book_warn: true, job_failed: false });
  });

  it('handles null/missing notification_kinds_json gracefully', () => {
    const settings = { ...BASE_SETTINGS, notification_kinds_json: null };
    const data = serializeSettingsPage(settings as any, EMPTY_CREDENTIALS);
    expect(data.notification_kinds).toEqual({});
  });
});

describe('serializeSettingsPage — API credential status', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.TAVILY_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('provider with DB row shows status=db and key_mask', () => {
    const creds = [
      {
        provider: 'anthropic',
        key_mask: 'sk-ant-••••',
        last_tested_at: null,
        last_test_result_json: null,
      },
    ];
    const data = serializeSettingsPage(BASE_SETTINGS as any, creds);
    const anthropic = data.apiCredentials.find((r) => r.provider === 'anthropic')!;
    expect(anthropic.status).toBe('db');
    expect(anthropic.key_mask).toBe('sk-ant-••••');
  });

  it('provider with env var but no DB row shows status=env', () => {
    process.env.OPENAI_API_KEY = 'sk-env-key';
    const data = serializeSettingsPage(BASE_SETTINGS as any, EMPTY_CREDENTIALS);
    const openai = data.apiCredentials.find((r) => r.provider === 'openai')!;
    expect(openai.status).toBe('env');
    expect(openai.key_mask).toBeNull();
  });

  it('provider with neither DB nor env shows status=unset', () => {
    const data = serializeSettingsPage(BASE_SETTINGS as any, EMPTY_CREDENTIALS);
    const tavily = data.apiCredentials.find((r) => r.provider === 'tavily')!;
    expect(tavily.status).toBe('unset');
    expect(tavily.key_mask).toBeNull();
  });

  it('DB status takes priority over env var', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env-anthropic';
    const creds = [
      { provider: 'anthropic', key_mask: 'sk-ant-db', last_tested_at: null, last_test_result_json: null },
    ];
    const data = serializeSettingsPage(BASE_SETTINGS as any, creds);
    const anthropic = data.apiCredentials.find((r) => r.provider === 'anthropic')!;
    expect(anthropic.status).toBe('db');
  });

  it('key_enc is never present in returned data', () => {
    const creds = [
      {
        provider: 'anthropic',
        key_mask: 'sk-ant-••••',
        last_tested_at: null,
        last_test_result_json: null,
        key_enc: 'ENC_SHOULD_NOT_APPEAR', // simulating accidental inclusion
      } as any,
    ];
    const data = serializeSettingsPage(BASE_SETTINGS as any, creds);
    for (const row of data.apiCredentials) {
      expect(row).not.toHaveProperty('key_enc');
    }
  });

  it('last_test_result_json deserialized: ok=true + latency_ms', () => {
    const creds = [
      {
        provider: 'google',
        key_mask: 'AIza-••••',
        last_tested_at: new Date('2026-06-01T10:00:00Z'),
        last_test_result_json: { ok: true, latency_ms: 45, message: 'OK' },
      },
    ];
    const data = serializeSettingsPage(BASE_SETTINGS as any, creds);
    const google = data.apiCredentials.find((r) => r.provider === 'google')!;
    expect(google.last_test_ok).toBe(true);
    expect(google.last_test_latency_ms).toBe(45);
    expect(google.last_tested_at).toBe('2026-06-01T10:00:00.000Z');
  });

  it('last_test_result_json deserialized: ok=false', () => {
    const creds = [
      {
        provider: 'openai',
        key_mask: 'sk-••••',
        last_tested_at: new Date('2026-06-02T08:00:00Z'),
        last_test_result_json: { ok: false, message: 'Invalid key', http_status: 401 },
      },
    ];
    const data = serializeSettingsPage(BASE_SETTINGS as any, creds);
    const openai = data.apiCredentials.find((r) => r.provider === 'openai')!;
    expect(openai.last_test_ok).toBe(false);
    expect(openai.last_tested_at).toBe('2026-06-02T08:00:00.000Z');
  });

  it('returns all 4 providers', () => {
    const data = serializeSettingsPage(BASE_SETTINGS as any, EMPTY_CREDENTIALS);
    const providers = data.apiCredentials.map((r) => r.provider);
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
    expect(providers).toContain('google');
    expect(providers).toContain('tavily');
    expect(providers).toHaveLength(4);
  });
});
