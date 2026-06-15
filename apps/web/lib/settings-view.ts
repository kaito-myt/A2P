/**
 * S-027 設定画面 (T-07-09) のシリアライズ / ビューヘルパ。
 *
 * RSC で Prisma AppSettings + ApiCredential を Client Component に渡す際の
 * Date / Decimal / Json 正規化。alerts-view / cost-dashboard-view と同パターン。
 *
 * API キーの平文は絶対に含めない。key_mask のみ返す。
 *
 * 仕様根拠:
 *  - docs/04 S-027
 *  - docs/05 §4.3.15 / §4.3.15a
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiCredentialStatus = 'db' | 'env' | 'unset';
export type ApiProvider = 'anthropic' | 'openai' | 'google' | 'tavily';

export const API_PROVIDERS: ApiProvider[] = ['anthropic', 'openai', 'google', 'tavily'];

/** env 変数名マップ */
const ENV_VAR_NAMES: Record<ApiProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  tavily: 'TAVILY_API_KEY',
};

export interface ApiCredentialStatusRow {
  provider: ApiProvider;
  status: ApiCredentialStatus;
  key_mask: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_latency_ms: number | null;
}

export interface SettingsPageData {
  notification_email_to: string;
  notification_kinds: Record<string, boolean>;
  cost_per_book_warn_jpy: number;
  cost_per_book_pause_jpy: number;
  monthly_cost_yellow_jpy: number;
  monthly_cost_orange_jpy: number;
  monthly_cost_red_jpy: number;
  catalog_price_change_threshold: number;
  prompt_auto_approval_enabled: boolean;
  prompt_auto_approval_rollback_h: number;
  sales_auto_fetch_enabled: boolean;
  sales_auto_fetch_cron: string;
  kdp_submit_timeout_minutes: number;
  kdp_submit_retry_count: number;
  job_log_retention_days: number;
  r2_archive_threshold_days: number;
  ai_disclosure_text: string;
  apiCredentials: ApiCredentialStatusRow[];
}

// ---------------------------------------------------------------------------
// Raw types (what Prisma returns)
// ---------------------------------------------------------------------------

interface RawAppSettings {
  notification_email_to: string;
  notification_kinds_json: unknown;
  cost_per_book_warn_jpy: number;
  cost_per_book_pause_jpy: number;
  monthly_cost_yellow_jpy: number;
  monthly_cost_orange_jpy: number;
  monthly_cost_red_jpy: number;
  catalog_price_change_threshold: unknown; // Decimal
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

interface RawApiCredential {
  provider: string;
  key_mask: string;
  last_tested_at: Date | null;
  last_test_result_json: unknown;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function extractLastTestResult(json: unknown): {
  ok: boolean | null;
  latency_ms: number | null;
} {
  if (!isPlainRecord(json)) return { ok: null, latency_ms: null };
  const ok = typeof json.ok === 'boolean' ? json.ok : null;
  const latency_ms = typeof json.latency_ms === 'number' ? json.latency_ms : null;
  return { ok, latency_ms };
}

/**
 * Determine the status of an API credential for a given provider.
 * Priority: DB row > env var > unset.
 */
function resolveCredentialStatus(
  provider: ApiProvider,
  dbRows: RawApiCredential[],
): ApiCredentialStatus {
  if (dbRows.some((r) => r.provider === provider)) return 'db';
  const envName = ENV_VAR_NAMES[provider];
  if (process.env[envName]) return 'env';
  return 'unset';
}

export function serializeSettingsPage(
  raw: RawAppSettings,
  rawCredentials: RawApiCredential[],
): SettingsPageData {
  const notificationKinds = isPlainRecord(raw.notification_kinds_json)
    ? Object.fromEntries(
        Object.entries(raw.notification_kinds_json).map(([k, v]) => [k, Boolean(v)]),
      )
    : {};

  const apiCredentials: ApiCredentialStatusRow[] = API_PROVIDERS.map((provider) => {
    const dbRow = rawCredentials.find((r) => r.provider === provider) ?? null;
    const status = resolveCredentialStatus(provider, rawCredentials);
    const testResult = extractLastTestResult(dbRow?.last_test_result_json);
    return {
      provider,
      status,
      key_mask: dbRow?.key_mask ?? null,
      last_tested_at: dbRow?.last_tested_at ? dbRow.last_tested_at.toISOString() : null,
      last_test_ok: testResult.ok,
      last_test_latency_ms: testResult.latency_ms,
    };
  });

  return {
    notification_email_to: raw.notification_email_to,
    notification_kinds: notificationKinds,
    cost_per_book_warn_jpy: raw.cost_per_book_warn_jpy,
    cost_per_book_pause_jpy: raw.cost_per_book_pause_jpy,
    monthly_cost_yellow_jpy: raw.monthly_cost_yellow_jpy,
    monthly_cost_orange_jpy: raw.monthly_cost_orange_jpy,
    monthly_cost_red_jpy: raw.monthly_cost_red_jpy,
    catalog_price_change_threshold: toNumber(raw.catalog_price_change_threshold),
    prompt_auto_approval_enabled: raw.prompt_auto_approval_enabled,
    prompt_auto_approval_rollback_h: raw.prompt_auto_approval_rollback_h,
    sales_auto_fetch_enabled: raw.sales_auto_fetch_enabled,
    sales_auto_fetch_cron: raw.sales_auto_fetch_cron,
    kdp_submit_timeout_minutes: raw.kdp_submit_timeout_minutes,
    kdp_submit_retry_count: raw.kdp_submit_retry_count,
    job_log_retention_days: raw.job_log_retention_days,
    r2_archive_threshold_days: raw.r2_archive_threshold_days,
    ai_disclosure_text: raw.ai_disclosure_text,
    apiCredentials,
  };
}
