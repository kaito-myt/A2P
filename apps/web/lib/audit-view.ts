/**
 * S-029 監査ログ (T-09-03, F-029/F-030/F-046) のビューヘルパ。
 *
 * RSC で Prisma 集計結果を受け取り、Client Component に渡すための
 * シリアライズ + JSON diff 計算 + CSV ビルドを行う純粋関数群。
 *
 * 仕様根拠: docs/04 S-029 / docs/05 §3 AuditLog / SP-09 T-09-03
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditLogSerialized {
  id: string;
  actor_id: string | null;
  actor_label: string;
  action: string;
  target_kind: string;
  target_id: string;
  before_json: unknown | null;
  after_json: unknown | null;
  before_after_summary: string;
  created_at: string;
}

// Raw DB row shape from Prisma select
export interface AuditLogRawRow {
  id: string;
  actor_id: string | null;
  actor?: { id: string; username: string } | null;
  action: string;
  target_kind: string;
  target_id: string;
  before_json: unknown | null;
  after_json: unknown | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// JSON diff types
// ---------------------------------------------------------------------------

export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DiffEntry {
  key: string;
  kind: DiffKind;
  before: unknown;
  after: unknown;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

export function serializeAuditLog(row: AuditLogRawRow): AuditLogSerialized {
  const actorLabel = row.actor?.username ?? row.actor_id ?? 'system';
  const summary = buildBeforeAfterSummary(row.before_json, row.after_json, row.action);

  return {
    id: row.id,
    actor_id: row.actor_id,
    actor_label: actorLabel,
    action: row.action,
    target_kind: row.target_kind,
    target_id: row.target_id,
    before_json: row.before_json,
    after_json: row.after_json,
    before_after_summary: summary,
    created_at: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// before → after summary (1 行テキスト)
// ---------------------------------------------------------------------------

/**
 * before_json / after_json から人間可読な 1 行サマリを生成する。
 * 変更されたキーを "key: oldVal → newVal" で列挙。
 * before_json が null の場合は「新規作成」、after_json が null の場合は「削除」。
 */
export function buildBeforeAfterSummary(
  beforeJson: unknown,
  afterJson: unknown,
  _action: string,
): string {
  if (beforeJson === null && afterJson === null) {
    return '—';
  }

  if (beforeJson === null) {
    // 新規作成
    if (afterJson !== null && typeof afterJson === 'object') {
      const keys = Object.keys(afterJson as Record<string, unknown>);
      if (keys.length === 0) return '新規作成';
      const sample = keys.slice(0, 2).join(', ');
      return `新規作成 (${sample}${keys.length > 2 ? '...' : ''})`;
    }
    return '新規作成';
  }

  if (afterJson === null) {
    return '削除';
  }

  if (typeof beforeJson !== 'object' || typeof afterJson !== 'object') {
    // Primitive change
    return `${String(beforeJson)} → ${String(afterJson)}`;
  }

  const diff = computeJsonDiff(beforeJson, afterJson);
  const changed = diff.filter((d) => d.kind !== 'unchanged');

  if (changed.length === 0) return '変更なし';

  const parts = changed.slice(0, 3).map((d) => {
    if (d.kind === 'added') return `+ ${d.key}`;
    if (d.kind === 'removed') return `- ${d.key}`;
    return `${d.key}: ${formatSummaryValue(d.before)} → ${formatSummaryValue(d.after)}`;
  });

  if (changed.length > 3) parts.push(`...他 ${changed.length - 3} 項目`);

  return parts.join(' / ');
}

function formatSummaryValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.length > 30 ? v.slice(0, 30) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return '{…}';
  return String(v);
}

// ---------------------------------------------------------------------------
// JSON diff computation (shallow + 1-level nested)
// ---------------------------------------------------------------------------

/**
 * before と after を shallow diff して DiffEntry[] を返す。
 * 配列や深いネストは "値が変わった" として changed 扱い。
 * before_json が null の場合、すべてのキーが added になる。
 */
export function computeJsonDiff(
  before: unknown,
  after: unknown,
): DiffEntry[] {
  if (before === null || before === undefined) {
    // before が null → after の全キーが added
    if (after !== null && after !== undefined && typeof after === 'object' && !Array.isArray(after)) {
      return Object.entries(after as Record<string, unknown>).map(([key, val]) => ({
        key,
        kind: 'added',
        before: undefined,
        after: val,
      }));
    }
    return [{ key: '(root)', kind: 'added', before: undefined, after }];
  }

  if (after === null || after === undefined) {
    // after が null → before の全キーが removed
    if (before !== null && before !== undefined && typeof before === 'object' && !Array.isArray(before)) {
      return Object.entries(before as Record<string, unknown>).map(([key, val]) => ({
        key,
        kind: 'removed',
        before: val,
        after: undefined,
      }));
    }
    return [{ key: '(root)', kind: 'removed', before, after: undefined }];
  }

  if (typeof before !== 'object' || Array.isArray(before) || typeof after !== 'object' || Array.isArray(after)) {
    // Primitive or array comparison
    const same = JSON.stringify(before) === JSON.stringify(after);
    return [{ key: '(root)', kind: same ? 'unchanged' : 'changed', before, after }];
  }

  const beforeObj = before as Record<string, unknown>;
  const afterObj = after as Record<string, unknown>;

  const allKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  const entries: DiffEntry[] = [];

  for (const key of allKeys) {
    const hasInBefore = Object.prototype.hasOwnProperty.call(beforeObj, key);
    const hasInAfter = Object.prototype.hasOwnProperty.call(afterObj, key);

    if (!hasInBefore) {
      entries.push({ key, kind: 'added', before: undefined, after: afterObj[key] });
    } else if (!hasInAfter) {
      entries.push({ key, kind: 'removed', before: beforeObj[key], after: undefined });
    } else {
      const bVal = beforeObj[key];
      const aVal = afterObj[key];
      const same = JSON.stringify(bVal) === JSON.stringify(aVal);
      entries.push({ key, kind: same ? 'unchanged' : 'changed', before: bVal, after: aVal });
    }
  }

  // Stable order: changed/added/removed first, then unchanged
  return entries.sort((a, b) => {
    const rank = (k: DiffKind) =>
      k === 'changed' ? 0 : k === 'added' ? 1 : k === 'removed' ? 2 : 3;
    return rank(a.kind) - rank(b.kind);
  });
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export interface AuditCsvRow {
  created_at: string;
  actor: string;
  action: string;
  target_kind: string;
  target_id: string;
  summary: string;
}

function escapeCsv(value: string): string {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildAuditCsv(rows: AuditCsvRow[]): string {
  const BOM = '﻿';
  const header = ['日時', 'アクター', 'アクション', '対象種別', '対象ID', 'サマリ'].join(',');
  const lines = rows.map((r) =>
    [
      escapeCsv(r.created_at),
      escapeCsv(r.actor),
      escapeCsv(r.action),
      escapeCsv(r.target_kind),
      escapeCsv(r.target_id),
      escapeCsv(r.summary),
    ].join(','),
  );
  return BOM + [header, ...lines].join('\r\n');
}

export function buildAuditCsvFilename(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  return `audit-log-${dateStr}.csv`;
}
