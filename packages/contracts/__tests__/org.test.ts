import { describe, expect, it } from 'vitest';

import {
  CeoPlanOutputSchema,
  DIVISIONS,
  DIVISION_KINDS,
  DIVISION_MANAGER_ROLE,
  ManagerPlanOutputSchema,
  buildBudgetLines,
  groupByDivision,
  groupByStatus,
  isHumanKind,
  kindLabel,
  needsAttention,
} from '../src/org/index.js';

describe('org constants', () => {
  it('全本部にマネージャーロールと kind 定義がある', () => {
    for (const d of DIVISIONS) {
      expect(DIVISION_MANAGER_ROLE[d]).toBeTruthy();
      expect(DIVISION_KINDS[d].length).toBeGreaterThan(0);
    }
  });

  it('人手前提の kind を判定する', () => {
    expect(isHumanKind('create_account')).toBe(true);
    expect(isHumanKind('connect_account')).toBe(true);
    expect(isHumanKind('publish_kdp')).toBe(true);
    expect(isHumanKind('write')).toBe(false);
  });

  it('kindLabel は未知の kind をそのまま返す', () => {
    expect(kindLabel('write')).toBe('執筆');
    expect(kindLabel('unknown_kind')).toBe('unknown_kind');
  });

  it('needsAttention は提案/要人手/ブロックで true', () => {
    expect(needsAttention('needs_human')).toBe(true);
    expect(needsAttention('proposed')).toBe(true);
    expect(needsAttention('blocked')).toBe(true);
    expect(needsAttention('approved')).toBe(false);
    expect(needsAttention('done')).toBe(false);
  });
});

describe('CeoPlanOutputSchema', () => {
  it('最小の有効な CEO 出力をパースし既定値を埋める', () => {
    const parsed = CeoPlanOutputSchema.parse({
      title: '7月方針',
      period_label: '2026-07',
      body: { goals: ['在庫を3冊増やす'] },
      division_briefs: { production: '実用書を2冊企画' },
    });
    expect(parsed.body.focus_books).toEqual([]);
    expect(parsed.body.kpi).toEqual([]);
    expect(parsed.division_briefs.production).toContain('企画');
  });

  it('goals が空だと reject', () => {
    const r = CeoPlanOutputSchema.safeParse({
      title: 'x',
      period_label: '2026-07',
      body: { goals: [] },
      division_briefs: {},
    });
    expect(r.success).toBe(false);
  });
});

describe('ManagerPlanOutputSchema', () => {
  it('タスクドラフトの priority を既定 should にする', () => {
    const parsed = ManagerPlanOutputSchema.parse({
      tasks: [{ kind: 'write', title: '第1章執筆', instruction: '…', assignee_role: 'writer' }],
    });
    expect(parsed.tasks[0]!.priority).toBe('should');
  });

  it('tasks 省略で空配列', () => {
    const parsed = ManagerPlanOutputSchema.parse({});
    expect(parsed.tasks).toEqual([]);
  });
});

describe('view helpers', () => {
  const tasks = [
    { status: 'approved', division: 'production' },
    { status: 'needs_human', division: 'promotion' },
    { status: 'done', division: 'production' },
    { status: 'weird', division: 'unknown' },
  ];

  it('groupByStatus は未知 status を proposed に寄せる', () => {
    const g = groupByStatus(tasks);
    expect(g.approved).toHaveLength(1);
    expect(g.needs_human).toHaveLength(1);
    expect(g.done).toHaveLength(1);
    expect(g.proposed).toHaveLength(1); // weird
  });

  it('groupByDivision は既知本部だけ集める', () => {
    const g = groupByDivision(tasks);
    expect(g.production).toHaveLength(2);
    expect(g.promotion).toHaveLength(1);
    expect(g.analytics).toHaveLength(0);
  });

  it('buildBudgetLines は配分と実績から消化率を出す', () => {
    const lines = buildBudgetLines(
      { production: 1000, promotion: 0 },
      { production: 250, promotion: 100 },
    );
    const prod = lines.find((l) => l.division === 'production')!;
    expect(prod.allocated).toBe(1000);
    expect(prod.spent).toBe(250);
    expect(prod.ratio).toBeCloseTo(0.25);
    // 配分 0 は ratio null（ゼロ割回避）
    const promo = lines.find((l) => l.division === 'promotion')!;
    expect(promo.ratio).toBeNull();
    // 未配分本部は allocated null
    const fin = lines.find((l) => l.division === 'finance')!;
    expect(fin.allocated).toBeNull();
    expect(fin.spent).toBe(0);
  });
});
