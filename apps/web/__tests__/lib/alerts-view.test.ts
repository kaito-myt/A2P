/**
 * alerts-view.ts unit tests (T-07-08, S-028).
 *
 * Tests:
 *  1. serializeAlertRow normalizes dates/payload
 *  2. extractMessage pulls message from payload
 *  3. computeAlertsKpi counts unread/unresolved/total/kindCounts
 *  4. filterAlerts by kind/severity/status
 *  5. getKindLabel returns Japanese label
 *  6. getSeverityLabel returns Japanese label
 *  7. getAlertLink returns correct href per kind group
 *  8. getKindGroup categorizes kinds
 *  9. formatDateTime formats ISO strings
 */
import { describe, expect, it } from 'vitest';

import {
  serializeAlertRow,
  extractMessage,
  computeAlertsKpi,
  filterAlerts,
  getKindLabel,
  getSeverityLabel,
  getAlertLink,
  getAlertLinkLabel,
  getKindGroup,
  formatDateTime,
  type AlertRowSerialized,
} from '../../lib/alerts-view';

function makeRow(overrides: Partial<AlertRowSerialized> = {}): AlertRowSerialized {
  return {
    id: 'a1',
    kind: 'cost_per_book_warn',
    severity: 'warning',
    message: 'test alert',
    payload_json: {},
    read_at: null,
    resolved_at: null,
    created_at: '2026-05-25T10:00:00.000Z',
    ...overrides,
  };
}

describe('serializeAlertRow', () => {
  it('normalizes dates and extracts message from payload', () => {
    const raw = {
      id: 'alert1',
      kind: 'cost_per_book_warn',
      severity: 'warning',
      payload_json: { message: 'Book X cost exceeded ¥500' },
      read_at: new Date('2026-05-25T11:00:00.000Z'),
      resolved_at: null,
      created_at: new Date('2026-05-25T10:00:00.000Z'),
    };

    const result = serializeAlertRow(raw);
    expect(result.id).toBe('alert1');
    expect(result.kind).toBe('cost_per_book_warn');
    expect(result.severity).toBe('warning');
    expect(result.message).toBe('Book X cost exceeded ¥500');
    expect(result.read_at).toBe('2026-05-25T11:00:00.000Z');
    expect(result.resolved_at).toBeNull();
    expect(result.created_at).toBe('2026-05-25T10:00:00.000Z');
  });

  it('defaults severity to info for unknown values', () => {
    const raw = {
      id: 'alert2',
      kind: 'cost_per_book_warn',
      severity: 'unknown_severity',
      payload_json: { message: 'test' },
      read_at: null,
      resolved_at: null,
      created_at: new Date('2026-05-25T10:00:00.000Z'),
    };

    const result = serializeAlertRow(raw);
    expect(result.severity).toBe('info');
  });

  it('handles null/array payload_json gracefully', () => {
    const raw = {
      id: 'alert3',
      kind: 'job_failed_3times',
      severity: 'critical',
      payload_json: null,
      read_at: null,
      resolved_at: null,
      created_at: new Date('2026-05-25T10:00:00.000Z'),
    };

    const result = serializeAlertRow(raw);
    expect(result.payload_json).toEqual({});
  });
});

describe('extractMessage', () => {
  it('returns message field from payload', () => {
    expect(extractMessage({ message: 'hello' })).toBe('hello');
  });

  it('falls back to msg field', () => {
    expect(extractMessage({ msg: 'world' })).toBe('world');
  });

  it('returns dash for empty payload', () => {
    const result = extractMessage({});
    expect(result).toBe('—'); // em-dash from messages
  });
});

describe('computeAlertsKpi', () => {
  it('computes counts correctly', () => {
    const rows = [
      makeRow({ id: 'a1', kind: 'cost_per_book_warn', read_at: null, resolved_at: null }),
      makeRow({ id: 'a2', kind: 'cost_per_book_warn', read_at: '2026-05-25T11:00:00.000Z', resolved_at: null }),
      makeRow({ id: 'a3', kind: 'job_failed_3times', read_at: null, resolved_at: '2026-05-25T12:00:00.000Z' }),
      makeRow({ id: 'a4', kind: 'catalog_price_change', read_at: '2026-05-25T11:00:00.000Z', resolved_at: '2026-05-25T12:00:00.000Z' }),
    ];

    const kpi = computeAlertsKpi(rows);
    expect(kpi.unread).toBe(2);
    expect(kpi.unresolved).toBe(2);
    expect(kpi.total).toBe(4);
    expect(kpi.kindCounts).toEqual({
      cost_per_book_warn: 2,
      job_failed_3times: 1,
      catalog_price_change: 1,
    });
  });

  it('handles empty array', () => {
    const kpi = computeAlertsKpi([]);
    expect(kpi.unread).toBe(0);
    expect(kpi.unresolved).toBe(0);
    expect(kpi.total).toBe(0);
    expect(kpi.kindCounts).toEqual({});
  });
});

describe('filterAlerts', () => {
  const rows = [
    makeRow({ id: 'a1', kind: 'cost_per_book_warn', severity: 'warning', read_at: null, resolved_at: null }),
    makeRow({ id: 'a2', kind: 'job_failed_3times', severity: 'critical', read_at: '2026-05-25T11:00:00.000Z', resolved_at: null }),
    makeRow({ id: 'a3', kind: 'catalog_price_change', severity: 'warning', read_at: null, resolved_at: '2026-05-25T12:00:00.000Z' }),
    makeRow({ id: 'a4', kind: 'cost_per_book_pause', severity: 'critical', read_at: '2026-05-25T11:00:00.000Z', resolved_at: '2026-05-25T12:00:00.000Z' }),
  ];

  it('filters by kind', () => {
    const result = filterAlerts(rows, { kind: 'job_failed_3times' });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('a2');
  });

  it('filters by severity', () => {
    const result = filterAlerts(rows, { severity: 'critical' });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(['a2', 'a4']);
  });

  it('filters by status unread', () => {
    const result = filterAlerts(rows, { status: 'unread' });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(['a1', 'a3']);
  });

  it('filters by status read', () => {
    const result = filterAlerts(rows, { status: 'read' });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(['a2', 'a4']);
  });

  it('filters by status unresolved', () => {
    const result = filterAlerts(rows, { status: 'unresolved' });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
  });

  it('filters by status resolved', () => {
    const result = filterAlerts(rows, { status: 'resolved' });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(['a3', 'a4']);
  });

  it('combines filters', () => {
    const result = filterAlerts(rows, { severity: 'critical', status: 'read' });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(['a2', 'a4']);
  });

  it('returns all when no filter', () => {
    const result = filterAlerts(rows, {});
    expect(result).toHaveLength(4);
  });
});

describe('getKindLabel', () => {
  it('returns Japanese label for known kind', () => {
    expect(getKindLabel('cost_per_book_warn')).toBe('1 冊コスト警告');
    expect(getKindLabel('job_failed_3times')).toBe('ジョブ 3 連続失敗');
    expect(getKindLabel('catalog_price_change')).toBe('単価変動');
  });

  it('returns raw kind for unknown', () => {
    expect(getKindLabel('unknown_kind')).toBe('unknown_kind');
  });
});

describe('getSeverityLabel', () => {
  it('returns Japanese label for known severity', () => {
    expect(getSeverityLabel('critical')).toBe('重大');
    expect(getSeverityLabel('warning')).toBe('警告');
    expect(getSeverityLabel('info')).toBe('情報');
  });

  it('returns raw severity for unknown', () => {
    expect(getSeverityLabel('other')).toBe('other');
  });
});

describe('getKindGroup', () => {
  it('categorizes cost kinds', () => {
    expect(getKindGroup('cost_per_book_warn')).toBe('cost');
    expect(getKindGroup('cost_per_book_pause')).toBe('cost');
    expect(getKindGroup('monthly_cost_80')).toBe('cost');
    expect(getKindGroup('monthly_cost_95')).toBe('cost');
    expect(getKindGroup('monthly_cost_100')).toBe('cost');
  });

  it('categorizes catalog kinds', () => {
    expect(getKindGroup('catalog_price_change')).toBe('catalog');
    expect(getKindGroup('catalog_fetch_failed')).toBe('catalog');
    expect(getKindGroup('fx_fetch_failed')).toBe('catalog');
  });

  it('categorizes job kinds', () => {
    expect(getKindGroup('job_failed_3times')).toBe('job');
    expect(getKindGroup('revision_run_failed')).toBe('job');
  });

  it('returns other for unknown', () => {
    expect(getKindGroup('unknown')).toBe('other');
  });
});

describe('getAlertLink', () => {
  it('returns /cost for cost kinds', () => {
    expect(getAlertLink('cost_per_book_warn')).toBe('/cost');
    expect(getAlertLink('monthly_cost_80')).toBe('/cost');
  });

  it('returns /models/catalog for catalog kinds', () => {
    expect(getAlertLink('catalog_price_change')).toBe('/models/catalog');
  });

  it('returns /jobs for job kinds', () => {
    expect(getAlertLink('job_failed_3times')).toBe('/jobs');
  });

  it('returns /alerts for unknown kinds', () => {
    expect(getAlertLink('unknown')).toBe('/alerts');
  });
});

describe('getAlertLinkLabel', () => {
  it('returns label for cost kinds', () => {
    expect(getAlertLinkLabel('cost_per_book_warn')).toBe('コスト詳細');
  });

  it('returns label for catalog kinds', () => {
    expect(getAlertLinkLabel('catalog_price_change')).toBe('モデルカタログ');
  });

  it('returns label for job kinds', () => {
    expect(getAlertLinkLabel('job_failed_3times')).toBe('ジョブ詳細');
  });

  it('returns empty for unknown kinds', () => {
    expect(getAlertLinkLabel('unknown')).toBe('');
  });
});

describe('formatDateTime', () => {
  it('formats ISO date string', () => {
    const result = formatDateTime('2026-05-25T10:30:00.000Z');
    expect(result).toMatch(/2026-05-25/);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it('returns raw string for invalid date', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
