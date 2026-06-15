/**
 * S-028 アラート一覧 (T-07-08) のシリアライズ / ビューヘルパ。
 *
 * RSC で Prisma Alert を Client Component に渡す際の
 * Date / Json 正規化。comments-view / cost-dashboard-view と同パターン。
 *
 * 仕様根拠:
 *  - docs/04 S-028
 *  - docs/05 §4.3.17 markAlerts
 */

import { messages } from './messages';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertKind =
  | 'cost_per_book_warn'
  | 'cost_per_book_pause'
  | 'monthly_cost_80'
  | 'monthly_cost_95'
  | 'monthly_cost_100'
  | 'catalog_price_change'
  | 'job_failed_3times'
  | 'catalog_fetch_failed'
  | 'fx_fetch_failed'
  | 'revision_run_failed';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertKindGroup = 'cost' | 'catalog' | 'job' | 'other';

export interface AlertRowSerialized {
  id: string;
  kind: string;
  severity: string;
  message: string;
  payload_json: Record<string, unknown>;
  read_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Kind grouping
// ---------------------------------------------------------------------------

const KIND_TO_GROUP: Record<string, AlertKindGroup> = {
  cost_per_book_warn: 'cost',
  cost_per_book_pause: 'cost',
  monthly_cost_80: 'cost',
  monthly_cost_95: 'cost',
  monthly_cost_100: 'cost',
  catalog_price_change: 'catalog',
  catalog_fetch_failed: 'catalog',
  fx_fetch_failed: 'catalog',
  job_failed_3times: 'job',
  revision_run_failed: 'job',
};

export function getKindGroup(kind: string): AlertKindGroup {
  return KIND_TO_GROUP[kind] ?? 'other';
}

// ---------------------------------------------------------------------------
// Navigation link resolution
// ---------------------------------------------------------------------------

export function getAlertLink(kind: string): string {
  const group = getKindGroup(kind);
  switch (group) {
    case 'cost':
      return '/cost';
    case 'catalog':
      return '/models/catalog';
    case 'job':
      return '/jobs';
    default:
      return '/alerts';
  }
}

export function getAlertLinkLabel(kind: string): string {
  const m = messages.alerts.table;
  const group = getKindGroup(kind);
  switch (group) {
    case 'cost':
      return m.linkCost;
    case 'catalog':
      return m.linkCatalog;
    case 'job':
      return m.linkJobs;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Severity styling
// ---------------------------------------------------------------------------

export function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'bg-red-100 text-red-800 border-red-300';
    case 'warning':
      return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    case 'info':
    default:
      return 'bg-gray-100 text-gray-700 border-gray-300';
  }
}

// ---------------------------------------------------------------------------
// Kind icon (text-based)
// ---------------------------------------------------------------------------

export function getKindIcon(kind: string): string {
  const group = getKindGroup(kind);
  switch (group) {
    case 'cost':
      return '¥';
    case 'catalog':
      return 'Δ';
    case 'job':
      return '!';
    default:
      return '?';
  }
}

export function getKindIconColor(kind: string): string {
  const group = getKindGroup(kind);
  switch (group) {
    case 'cost':
      return 'bg-amber-100 text-amber-700 border-amber-300';
    case 'catalog':
      return 'bg-blue-100 text-blue-700 border-blue-300';
    case 'job':
      return 'bg-red-100 text-red-700 border-red-300';
    default:
      return 'bg-gray-100 text-gray-600 border-gray-300';
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set<string>([
  'cost_per_book_warn', 'cost_per_book_pause',
  'monthly_cost_80', 'monthly_cost_95', 'monthly_cost_100',
  'catalog_price_change', 'job_failed_3times',
  'catalog_fetch_failed', 'fx_fetch_failed', 'revision_run_failed',
]);

const VALID_SEVERITIES = new Set<string>(['info', 'warning', 'critical']);

interface RawAlertRow {
  id: string;
  kind: string;
  severity: string;
  payload_json: unknown;
  read_at: Date | null;
  resolved_at: Date | null;
  created_at: Date;
}

export function extractMessage(payload: Record<string, unknown>): string {
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.msg === 'string') return payload.msg;
  return messages.alerts.table.noMessage;
}

export function serializeAlertRow(raw: RawAlertRow): AlertRowSerialized {
  const kind = VALID_KINDS.has(raw.kind) ? raw.kind : raw.kind;
  const severity = VALID_SEVERITIES.has(raw.severity) ? raw.severity : 'info';
  const payload = (raw.payload_json && typeof raw.payload_json === 'object' && !Array.isArray(raw.payload_json))
    ? (raw.payload_json as Record<string, unknown>)
    : {};

  return {
    id: raw.id,
    kind,
    severity,
    message: extractMessage(payload),
    payload_json: payload,
    read_at: raw.read_at ? raw.read_at.toISOString() : null,
    resolved_at: raw.resolved_at ? raw.resolved_at.toISOString() : null,
    created_at: raw.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

export interface AlertsKpi {
  unread: number;
  unresolved: number;
  total: number;
  kindCounts: Record<string, number>;
}

export function computeAlertsKpi(rows: readonly AlertRowSerialized[]): AlertsKpi {
  const kindCounts: Record<string, number> = {};
  let unread = 0;
  let unresolved = 0;

  for (const r of rows) {
    if (!r.read_at) unread += 1;
    if (!r.resolved_at) unresolved += 1;
    kindCounts[r.kind] = (kindCounts[r.kind] ?? 0) + 1;
  }

  return {
    unread,
    unresolved,
    total: rows.length,
    kindCounts,
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export type AlertStatusFilter = 'unread' | 'read' | 'unresolved' | 'resolved';

export interface AlertsPageFilter {
  kind?: string;
  severity?: string;
  status?: AlertStatusFilter;
}

export function filterAlerts(
  rows: readonly AlertRowSerialized[],
  filter: AlertsPageFilter,
): AlertRowSerialized[] {
  return rows.filter((r) => {
    if (filter.kind && r.kind !== filter.kind) return false;
    if (filter.severity && r.severity !== filter.severity) return false;
    if (filter.status) {
      switch (filter.status) {
        case 'unread':
          if (r.read_at) return false;
          break;
        case 'read':
          if (!r.read_at) return false;
          break;
        case 'unresolved':
          if (r.resolved_at) return false;
          break;
        case 'resolved':
          if (!r.resolved_at) return false;
          break;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  } catch {
    return iso;
  }
}

export function getKindLabel(kind: string): string {
  return (messages.alerts.kindLabels as Record<string, string>)[kind] ?? kind;
}

export function getSeverityLabel(severity: string): string {
  return (messages.alerts.severityLabels as Record<string, string>)[severity] ?? severity;
}
