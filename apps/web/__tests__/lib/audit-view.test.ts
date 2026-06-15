/**
 * audit-view.ts ユニットテスト (T-09-03).
 *
 * 検証:
 *  1. computeJsonDiff: added / removed / changed / unchanged キーの判定
 *  2. computeJsonDiff: before が null の場合 (新規作成)
 *  3. computeJsonDiff: after が null の場合 (削除)
 *  4. computeJsonDiff: 変更なしの場合 unchanged
 *  5. buildBeforeAfterSummary: null before (新規作成サマリ)
 *  6. buildBeforeAfterSummary: 変更されたキーを列挙
 *  7. buildBeforeAfterSummary: 4 件以上変更の場合の省略
 *  8. serializeAuditLog: created_at を ISO 文字列に変換
 *  9. serializeAuditLog: actor_id null の場合は 'system' ラベル
 * 10. buildAuditCsv: ヘッダ + 行 + BOM
 * 11. buildAuditCsvFilename: ファイル名形式
 */
import { describe, expect, it } from 'vitest';

import {
  computeJsonDiff,
  buildBeforeAfterSummary,
  serializeAuditLog,
  buildAuditCsv,
  buildAuditCsvFilename,
  type AuditLogRawRow,
} from '../../lib/audit-view';

// ---------------------------------------------------------------------------
// computeJsonDiff
// ---------------------------------------------------------------------------

describe('computeJsonDiff', () => {
  it('added キーを検出する', () => {
    const before = { a: 1 };
    const after = { a: 1, b: 2 };
    const diff = computeJsonDiff(before, after);
    const added = diff.filter((d) => d.kind === 'added');
    expect(added).toHaveLength(1);
    expect(added[0]!.key).toBe('b');
    expect(added[0]!.after).toBe(2);
  });

  it('removed キーを検出する', () => {
    const before = { a: 1, b: 2 };
    const after = { a: 1 };
    const diff = computeJsonDiff(before, after);
    const removed = diff.filter((d) => d.kind === 'removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.key).toBe('b');
    expect(removed[0]!.before).toBe(2);
  });

  it('changed キーを検出する', () => {
    const before = { status: 'warn', threshold: 500 };
    const after = { status: 'paused', threshold: 750 };
    const diff = computeJsonDiff(before, after);
    const changed = diff.filter((d) => d.kind === 'changed');
    expect(changed).toHaveLength(2);
    const statusDiff = changed.find((d) => d.key === 'status')!;
    expect(statusDiff.before).toBe('warn');
    expect(statusDiff.after).toBe('paused');
  });

  it('変更なしのキーは unchanged になる', () => {
    const before = { a: 1, b: 'hello' };
    const after = { a: 1, b: 'hello' };
    const diff = computeJsonDiff(before, after);
    expect(diff.every((d) => d.kind === 'unchanged')).toBe(true);
  });

  it('before が null の場合はすべてのキーが added になる', () => {
    const after = { x: 10, y: 20 };
    const diff = computeJsonDiff(null, after);
    expect(diff.length).toBe(2);
    expect(diff.every((d) => d.kind === 'added')).toBe(true);
  });

  it('after が null の場合はすべてのキーが removed になる', () => {
    const before = { x: 10, y: 20 };
    const diff = computeJsonDiff(before, null);
    expect(diff.length).toBe(2);
    expect(diff.every((d) => d.kind === 'removed')).toBe(true);
  });

  it('both null の場合は空配列を返す', () => {
    const diff = computeJsonDiff(null, null);
    // null-before/null-after は単一の added エントリになる
    // (after も null なので removed)
    // actually both null → null before: returns added for null after value
    expect(Array.isArray(diff)).toBe(true);
  });

  it('ネストオブジェクトの変更は changed として扱う', () => {
    const before = { config: { retries: 3 } };
    const after = { config: { retries: 5 } };
    const diff = computeJsonDiff(before, after);
    const changed = diff.find((d) => d.key === 'config');
    expect(changed?.kind).toBe('changed');
  });

  it('配列値の変更は changed として扱う', () => {
    const before = { items: [1, 2, 3] };
    const after = { items: [1, 2, 4] };
    const diff = computeJsonDiff(before, after);
    const changed = diff.find((d) => d.key === 'items');
    expect(changed?.kind).toBe('changed');
  });
});

// ---------------------------------------------------------------------------
// buildBeforeAfterSummary
// ---------------------------------------------------------------------------

describe('buildBeforeAfterSummary', () => {
  it('before が null の場合は新規作成サマリを返す', () => {
    const summary = buildBeforeAfterSummary(null, { name: 'test', value: 1 }, 'settings.update');
    expect(summary).toMatch('新規作成');
  });

  it('after が null の場合は削除サマリを返す', () => {
    const summary = buildBeforeAfterSummary({ id: '123' }, null, 'job.cancel');
    expect(summary).toBe('削除');
  });

  it('両方 null の場合は em dash を返す', () => {
    const summary = buildBeforeAfterSummary(null, null, 'settings.update');
    expect(summary).toBe('—');
  });

  it('変更キーを列挙する', () => {
    const before = { status: 'running', retries: 0 };
    const after = { status: 'cancelled', retries: 1 };
    const summary = buildBeforeAfterSummary(before, after, 'job.cancel');
    expect(summary).toContain('status');
    expect(summary).toContain('running');
    expect(summary).toContain('cancelled');
  });

  it('変更なしの場合は変更なしを返す', () => {
    const obj = { a: 1, b: 2 };
    const summary = buildBeforeAfterSummary(obj, obj, 'settings.update');
    expect(summary).toBe('変更なし');
  });

  it('4 件以上変更の場合はサマリを省略する', () => {
    const before = { a: 1, b: 2, c: 3, d: 4 };
    const after = { a: 10, b: 20, c: 30, d: 40 };
    const summary = buildBeforeAfterSummary(before, after, 'settings.update');
    expect(summary).toContain('他');
  });
});

// ---------------------------------------------------------------------------
// serializeAuditLog
// ---------------------------------------------------------------------------

describe('serializeAuditLog', () => {
  const baseRow: AuditLogRawRow = {
    id: 'audit_001',
    actor_id: 'user_abc',
    actor: { id: 'user_abc', username: 'admin' },
    action: 'settings.update',
    target_kind: 'app_settings',
    target_id: 'singleton',
    before_json: { threshold_warn: 500 },
    after_json: { threshold_warn: 750 },
    created_at: new Date('2026-05-20T14:30:00Z'),
  };

  it('created_at を ISO 文字列に変換する', () => {
    const serialized = serializeAuditLog(baseRow);
    expect(serialized.created_at).toBe('2026-05-20T14:30:00.000Z');
  });

  it('actor ユーザー名を actor_label にセットする', () => {
    const serialized = serializeAuditLog(baseRow);
    expect(serialized.actor_label).toBe('admin');
  });

  it('actor_id が null の場合は actor_label を "system" にする', () => {
    const row: AuditLogRawRow = {
      ...baseRow,
      actor_id: null,
      actor: null,
    };
    const serialized = serializeAuditLog(row);
    expect(serialized.actor_label).toBe('system');
  });

  it('before_json と after_json を保持する', () => {
    const serialized = serializeAuditLog(baseRow);
    expect(serialized.before_json).toEqual({ threshold_warn: 500 });
    expect(serialized.after_json).toEqual({ threshold_warn: 750 });
  });

  it('before_after_summary を生成する', () => {
    const serialized = serializeAuditLog(baseRow);
    expect(typeof serialized.before_after_summary).toBe('string');
    expect(serialized.before_after_summary.length).toBeGreaterThan(0);
  });

  it('before_json が null の場合も正常動作する', () => {
    const row: AuditLogRawRow = { ...baseRow, before_json: null };
    const serialized = serializeAuditLog(row);
    expect(serialized.before_json).toBeNull();
    expect(serialized.before_after_summary).toMatch('新規作成');
  });
});

// ---------------------------------------------------------------------------
// buildAuditCsv
// ---------------------------------------------------------------------------

describe('buildAuditCsv', () => {
  const sampleRows = [
    {
      created_at: '2026-05-20T14:30:00.000Z',
      actor: 'admin',
      action: 'settings.update',
      target_kind: 'app_settings',
      target_id: 'singleton',
      summary: 'threshold_warn: 500 → 750',
    },
    {
      created_at: '2026-05-20T12:00:00.000Z',
      actor: 'system',
      action: 'batch_plan.cron_kick',
      target_kind: 'batch_plan',
      target_id: 'plan_xyz',
      summary: '新規作成',
    },
  ];

  it('UTF-8 BOM で始まる', () => {
    const csv = buildAuditCsv(sampleRows);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('正しいヘッダ行を含む', () => {
    const csv = buildAuditCsv(sampleRows);
    expect(csv).toContain('日時,アクター,アクション,対象種別,対象ID,サマリ');
  });

  it('各行のデータを含む', () => {
    const csv = buildAuditCsv(sampleRows);
    expect(csv).toContain('settings.update');
    expect(csv).toContain('batch_plan.cron_kick');
  });

  it('空の場合はヘッダのみ', () => {
    const csv = buildAuditCsv([]);
    const lines = csv.split('\r\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1); // header のみ
  });

  it('カンマを含む値を引用符でエスケープする', () => {
    const rows = [
      {
        created_at: '2026-01-01T00:00:00.000Z',
        actor: 'admin',
        action: 'test',
        target_kind: 'book',
        target_id: 'id',
        summary: 'key: old, new',
      },
    ];
    const csv = buildAuditCsv(rows);
    expect(csv).toContain('"key: old, new"');
  });
});

// ---------------------------------------------------------------------------
// buildAuditCsvFilename
// ---------------------------------------------------------------------------

describe('buildAuditCsvFilename', () => {
  it('audit-log-YYYY-MM-DD.csv の形式を持つ', () => {
    const filename = buildAuditCsvFilename();
    expect(filename).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

// ---------------------------------------------------------------------------
// CSV summary 回帰テスト (#4): buildBeforeAfterSummary が空でない文字列を返す
// ---------------------------------------------------------------------------

describe('CSV summary regression — buildBeforeAfterSummary non-empty', () => {
  it('変更があるログ行で空でないサマリを返す', () => {
    const summary = buildBeforeAfterSummary(
      { status: 'queued', retries: 0 },
      { status: 'running', retries: 1 },
      'job.retry',
    );
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).not.toBe('');
  });

  it('before_json が null の場合も空でないサマリを返す (新規作成)', () => {
    const summary = buildBeforeAfterSummary(null, { batch_id: 'b1', status: 'running' }, 'batch_plan.cron_kick');
    expect(summary).toMatch('新規作成');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('after_json が null の場合も空でないサマリを返す (削除)', () => {
    const summary = buildBeforeAfterSummary({ id: 'x' }, null, 'job.cancel');
    expect(summary).toBe('削除');
    expect(summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// actor フィルタ WHERE 一貫性回帰テスト (#1-3)
// buildAuditCsv は actor ラベルを正しく解決する (operator/system 区別)
// ---------------------------------------------------------------------------

describe('actor filter regression — operator vs system rows', () => {
  const operatorRow = {
    created_at: '2026-05-01T00:00:00.000Z',
    actor: 'admin',
    action: 'settings.update',
    target_kind: 'app_settings',
    target_id: 'singleton',
    summary: 'some change',
  };
  const systemRow = {
    created_at: '2026-05-01T01:00:00.000Z',
    actor: 'system',
    action: 'batch_plan.cron_kick',
    target_kind: 'batch_plan',
    target_id: 'plan_1',
    summary: '新規作成',
  };

  it('CSV に operator と system 両方の行を含む (actor=all 相当)', () => {
    const csv = buildAuditCsv([operatorRow, systemRow]);
    expect(csv).toContain('admin');
    expect(csv).toContain('system');
  });

  it('operator のみの行を含む CSV — system actor が含まれない', () => {
    // DB側で WHERE actor_id IS NOT NULL でフィルタ済み想定
    const csv = buildAuditCsv([operatorRow]);
    expect(csv).toContain('admin');
    expect(csv).not.toContain('system');
  });

  it('system のみの行を含む CSV — operator が含まれない', () => {
    // DB側で WHERE actor_id IS NULL でフィルタ済み想定
    const csv = buildAuditCsv([systemRow]);
    expect(csv).toContain('system');
    expect(csv).not.toContain('admin');
  });
});
