import { describe, expect, it } from 'vitest';

import {
  computeSpentByDivision,
  divisionTaskCounts,
  mapOrgTaskRow,
  type DbOrgTask,
} from '../../lib/org-view';

function db(over: Partial<DbOrgTask>): DbOrgTask {
  return {
    id: 't1',
    division: 'production',
    book_id: null,
    owner_role: 'editorial_mgr',
    assignee_role: 'writer',
    channel: null,
    account_ref: null,
    kind: 'write',
    title: 'タイトル',
    instruction: '指示',
    status: 'approved',
    priority: 'should',
    cost_jpy: null,
    created_at: new Date('2026-07-09T00:00:00Z'),
    book: null,
    ...over,
  };
}

describe('mapOrgTaskRow', () => {
  it('DB 行をシリアライズ可能な行へ変換する', () => {
    const row = mapOrgTaskRow(db({ book_id: 'b1', book: { title: '本A' }, cost_jpy: '12.5' }));
    expect(row.bookTitle).toBe('本A');
    expect(row.costJpy).toBe(12.5);
    expect(row.createdAt).toBe('2026-07-09T00:00:00.000Z');
  });

  it('cost_jpy が null / 不正なら null', () => {
    expect(mapOrgTaskRow(db({ cost_jpy: null })).costJpy).toBeNull();
    expect(mapOrgTaskRow(db({ cost_jpy: 'x' })).costJpy).toBeNull();
  });
});

describe('computeSpentByDivision', () => {
  it('本部別に cost を合算する', () => {
    const rows = [
      mapOrgTaskRow(db({ division: 'production', cost_jpy: 100 })),
      mapOrgTaskRow(db({ division: 'production', cost_jpy: 50 })),
      mapOrgTaskRow(db({ division: 'promotion', cost_jpy: 20 })),
      mapOrgTaskRow(db({ division: 'unknown', cost_jpy: 999 })), // 未知本部は無視
    ];
    const spent = computeSpentByDivision(rows);
    expect(spent.production).toBe(150);
    expect(spent.promotion).toBe(20);
    expect((spent as Record<string, number>).unknown).toBeUndefined();
  });
});

describe('divisionTaskCounts', () => {
  it('進行中/要人手/完了を数える', () => {
    const rows = [
      mapOrgTaskRow(db({ division: 'promotion', status: 'approved' })),
      mapOrgTaskRow(db({ division: 'promotion', status: 'needs_human' })),
      mapOrgTaskRow(db({ division: 'promotion', status: 'done' })),
      mapOrgTaskRow(db({ division: 'promotion', status: 'canceled' })),
    ];
    const c = divisionTaskCounts(rows).promotion;
    expect(c.total).toBe(4);
    expect(c.open).toBe(1); // approved
    expect(c.human).toBe(1);
    expect(c.done).toBe(1);
    // canceled は open にも done にも入らない
  });
});

describe('summarizeResult / mapOrgTaskRow result', () => {
  it('分析結果は summary を要約に使う', () => {
    const row = mapOrgTaskRow(db({ result_json: { summary: '先月比+20%' } }));
    expect(row.resultSummary).toBe('先月比+20%');
  });

  it('メタデータ草案は draft.title を要約に使う', () => {
    const row = mapOrgTaskRow(db({ result_json: { draft: { title: 'すごい本' } } }));
    expect(row.resultSummary).toContain('すごい本');
  });

  it('制作起動アクションを人が読める文にする', () => {
    const t = mapOrgTaskRow(db({ result_json: { action: 'theme_generate_enqueued', count: 5 } }));
    expect(t.resultSummary).toContain('テーマ生成');
    const k = mapOrgTaskRow(db({ result_json: { action: 'book_kickoff_enqueued' } }));
    expect(k.resultSummary).toContain('制作を起動');
  });

  it('blocked の error を行に載せる', () => {
    const row = mapOrgTaskRow(db({ status: 'blocked', error: 'theme_id が必要' }));
    expect(row.error).toBe('theme_id が必要');
    expect(row.resultSummary).toBeNull();
  });

  it('P3 販促/運用の起動アクションを人が読める文にする', () => {
    expect(mapOrgTaskRow(db({ result_json: { action: 'promotion_generate_enqueued' } })).resultSummary).toContain('販促プラン');
    expect(mapOrgTaskRow(db({ result_json: { action: 'promotion_dispatch_enqueued' } })).resultSummary).toContain('配信');
    expect(
      mapOrgTaskRow(db({ result_json: { action: 'job_recovered', recovered_step: 'pipeline.book.editor' } })).resultSummary,
    ).toContain('editor');
  });

  it('P3 コスト会計レポートは report.summary を要約に使う', () => {
    const row = mapOrgTaskRow(db({ result_json: { report: { summary: '制作コスト過多' }, aggregate: {} } }));
    expect(row.resultSummary).toBe('制作コスト過多');
  });
});
