/**
 * ab-distribution-core.ts のユニットテスト (T-11-06)
 *
 * DB は mock で注入。startAbDistributionCore の upsert 動作と
 * selectPromptId の rand / ratio 境界を検証する。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  startAbDistributionCore,
  selectPromptId,
  normalizeAbGenre,
  type AbDistributionDeps,
  type AppSettingsAbRow,
} from '@/lib/ab-distribution-core';

// ---------------------------------------------------------------------------
// テスト用ファクトリ
// ---------------------------------------------------------------------------

function makeSession(): AbDistributionDeps['session'] {
  return {
    user: {
      id: 'user_1',
      username: 'test_user',
    },
    expires: '2099-01-01T00:00:00Z',
  };
}

interface BuildDepsArgs {
  existingJson?: unknown;
  /** update の捕捉用。 */
  onUpdate?: (args: { where: { id: string }; data: Record<string, unknown> }) => void;
}

function buildDeps(args: BuildDepsArgs = {}): {
  deps: AbDistributionDeps;
  updateCalls: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  auditCreateCalls: Array<{ data: Record<string, unknown> }>;
} {
  const updateCalls: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const auditCreateCalls: Array<{ data: Record<string, unknown> }> = [];

  const deps: AbDistributionDeps = {
    appSettingsRepo: {
      findUnique: vi.fn(async () => {
        if (args.existingJson !== undefined) {
          return { id: 'singleton', ab_distribution_json: args.existingJson } as AppSettingsAbRow;
        }
        return null;
      }),
      update: vi.fn(async (a) => {
        updateCalls.push(a as { where: { id: string }; data: Record<string, unknown> });
        args.onUpdate?.(a as { where: { id: string }; data: Record<string, unknown> });
        return { id: 'singleton', ab_distribution_json: null } as AppSettingsAbRow;
      }),
    },
    auditLogRepo: {
      create: vi.fn(async (a) => {
        auditCreateCalls.push(a as { data: Record<string, unknown> });
      }),
    },
    session: makeSession(),
  };

  return { deps, updateCalls, auditCreateCalls };
}

// ---------------------------------------------------------------------------
// startAbDistributionCore
// ---------------------------------------------------------------------------

describe('startAbDistributionCore', () => {
  it('初回登録: ab_distribution_json に新エントリが追加される', async () => {
    const { deps, updateCalls } = buildDeps({ existingJson: null });

    const result = await startAbDistributionCore(
      {
        role: 'writer',
        genre: 'business',
        baseline_id: 'p_baseline',
        candidate_id: 'p_candidate',
        ratio_candidate: 0.4,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateCalls).toHaveLength(1);
    const written = updateCalls[0]?.data['ab_distribution_json'] as unknown[];
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      role: 'writer',
      genre: 'business',
      baseline_id: 'p_baseline',
      candidate_id: 'p_candidate',
      ratio_candidate: 0.4,
    });
  });

  it('同 role×genre のアップサート: 既存エントリを上書きする', async () => {
    const existing = [
      {
        role: 'writer',
        genre: 'business',
        baseline_id: 'old_baseline',
        candidate_id: 'old_candidate',
        ratio_candidate: 0.3,
      },
      {
        role: 'editor',
        genre: 'business',
        baseline_id: 'e_baseline',
        candidate_id: 'e_candidate',
        ratio_candidate: 0.5,
      },
    ];
    const { deps, updateCalls } = buildDeps({ existingJson: existing });

    const result = await startAbDistributionCore(
      {
        role: 'writer',
        genre: 'business',
        baseline_id: 'new_baseline',
        candidate_id: 'new_candidate',
        ratio_candidate: 0.6,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    const written = updateCalls[0]?.data['ab_distribution_json'] as unknown[];
    // エントリ数は変わらない (上書き)
    expect(written).toHaveLength(2);
    const writerEntry = written.find(
      (e) => (e as Record<string, unknown>)['role'] === 'writer',
    ) as Record<string, unknown>;
    expect(writerEntry['baseline_id']).toBe('new_baseline');
    expect(writerEntry['candidate_id']).toBe('new_candidate');
    expect(writerEntry['ratio_candidate']).toBe(0.6);
    // editor は変化なし
    const editorEntry = written.find(
      (e) => (e as Record<string, unknown>)['role'] === 'editor',
    ) as Record<string, unknown>;
    expect(editorEntry['baseline_id']).toBe('e_baseline');
  });

  it('バリデーションエラー: ratio_candidate > 1', async () => {
    const { deps } = buildDeps();

    const result = await startAbDistributionCore(
      {
        role: 'writer',
        genre: 'business',
        baseline_id: 'p_baseline',
        candidate_id: 'p_candidate',
        ratio_candidate: 1.5,
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
  });

  it('バリデーションエラー: role が空文字', async () => {
    const { deps } = buildDeps();

    const result = await startAbDistributionCore(
      {
        role: '',
        genre: 'business',
        baseline_id: 'p_baseline',
        candidate_id: 'p_candidate',
        ratio_candidate: 0.5,
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
  });

  it('audit_log に before/after が記録される', async () => {
    const existing = [
      {
        role: 'writer',
        genre: 'business',
        baseline_id: 'old_baseline',
        candidate_id: 'old_candidate',
        ratio_candidate: 0.3,
      },
    ];
    const { deps, auditCreateCalls } = buildDeps({ existingJson: existing });

    await startAbDistributionCore(
      {
        role: 'writer',
        genre: 'business',
        baseline_id: 'new_baseline',
        candidate_id: 'new_candidate',
        ratio_candidate: 0.5,
      },
      deps,
    );

    expect(auditCreateCalls).toHaveLength(1);
    const auditData = auditCreateCalls[0]?.data as Record<string, unknown>;
    expect(auditData['action']).toBe('settings.update');
    expect(auditData['target_kind']).toBe('ab_distribution');
    expect(auditData['actor_id']).toBe('user_1');
  });
});

// ---------------------------------------------------------------------------
// selectPromptId
// ---------------------------------------------------------------------------

describe('selectPromptId', () => {
  const config = [
    {
      role: 'writer',
      genre: 'business',
      baseline_id: 'p_baseline',
      candidate_id: 'p_candidate',
      ratio_candidate: 0.5,
    },
  ];

  function makeRepo(json: unknown) {
    return {
      findUnique: vi.fn(async () => ({
        id: 'singleton',
        ab_distribution_json: json,
      })),
      update: vi.fn(async () => ({ id: 'singleton', ab_distribution_json: null })),
    };
  }

  it('rand=0.0 < ratio_candidate(0.5) → candidate', async () => {
    const repo = makeRepo(config);
    const result = await selectPromptId('writer', 'business', 0.0, { appSettingsRepo: repo });
    expect(result).toBe('p_candidate');
  });

  it('rand=0.4 < ratio_candidate(0.5) → candidate', async () => {
    const repo = makeRepo(config);
    const result = await selectPromptId('writer', 'business', 0.4, { appSettingsRepo: repo });
    expect(result).toBe('p_candidate');
  });

  it('rand=0.5 >= ratio_candidate(0.5) → baseline (境界値: 等値は baseline)', async () => {
    const repo = makeRepo(config);
    const result = await selectPromptId('writer', 'business', 0.5, { appSettingsRepo: repo });
    expect(result).toBe('p_baseline');
  });

  it('rand=0.6 >= ratio_candidate(0.5) → baseline', async () => {
    const repo = makeRepo(config);
    const result = await selectPromptId('writer', 'business', 0.6, { appSettingsRepo: repo });
    expect(result).toBe('p_baseline');
  });

  it('rand=0.9 >= ratio_candidate(0.5) → baseline', async () => {
    const repo = makeRepo(config);
    const result = await selectPromptId('writer', 'business', 0.9, { appSettingsRepo: repo });
    expect(result).toBe('p_baseline');
  });

  it('設定なし role は null を返す', async () => {
    const repo = makeRepo(config);
    const result = await selectPromptId('editor', 'business', 0.3, { appSettingsRepo: repo });
    expect(result).toBeNull();
  });

  it('ab_distribution_json が null/undefined → null', async () => {
    const repo = makeRepo(null);
    const result = await selectPromptId('writer', 'business', 0.3, { appSettingsRepo: repo });
    expect(result).toBeNull();
  });

  it('ratio_candidate=0.0: rand=0.0 → baseline (全量 baseline)', async () => {
    const repo = makeRepo([
      { ...config[0], ratio_candidate: 0.0 },
    ]);
    const result = await selectPromptId('writer', 'business', 0.0, { appSettingsRepo: repo });
    expect(result).toBe('p_baseline');
  });

  it('ratio_candidate=1.0: rand=0.99 → candidate (全量 candidate)', async () => {
    const repo = makeRepo([
      { ...config[0], ratio_candidate: 1.0 },
    ]);
    const result = await selectPromptId('writer', 'business', 0.99, { appSettingsRepo: repo });
    expect(result).toBe('p_candidate');
  });
});

// ---------------------------------------------------------------------------
// normalizeAbGenre — genre=null 往復一致テスト
// ---------------------------------------------------------------------------

describe('normalizeAbGenre', () => {
  it('null → "default"', () => {
    expect(normalizeAbGenre(null)).toBe('default');
  });

  it('具体ジャンルはそのまま', () => {
    expect(normalizeAbGenre('business')).toBe('business');
    expect(normalizeAbGenre('practical')).toBe('practical');
  });
});

describe('genre=null 往復一致: startAbDistributionCore→selectPromptId', () => {
  /**
   * UI で genre=null を 'default' に正規化して保存 → selectPromptId(null) で同一キーを照合できる
   * という往復を検証する。
   */
  function makeRepo(json: unknown) {
    return {
      findUnique: vi.fn(async () => ({
        id: 'singleton',
        ab_distribution_json: json,
      })),
      update: vi.fn(async () => ({ id: 'singleton', ab_distribution_json: null })),
    };
  }

  it('genre=null で保存されたエントリを genre=null で照合できる', async () => {
    // normalizeAbGenre(null) = 'default' で保存されたエントリ
    const storedJson = [
      {
        role: 'writer',
        genre: 'default', // normalizeAbGenre(null) の結果
        baseline_id: 'p_baseline_default',
        candidate_id: 'p_candidate_default',
        ratio_candidate: 0.5,
      },
    ];
    const repo = makeRepo(storedJson);

    // genre=null で照合 → 'default' に正規化されて一致する
    const result = await selectPromptId('writer', null, 0.3, { appSettingsRepo: repo });
    expect(result).toBe('p_candidate_default'); // 0.3 < 0.5 → candidate
  });

  it('startAbDistributionCore が genre=null 正規化キーで保存し selectPromptId(null) で取得できる', async () => {
    const updateCalls: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
    const { deps } = buildDeps({
      existingJson: null,
      onUpdate: (a) => updateCalls.push(a),
    });

    // UI フォームは normalizeAbGenre(null) = 'default' を genre として渡す
    const saveResult = await startAbDistributionCore(
      {
        role: 'editor',
        genre: 'default',
        baseline_id: 'base_1',
        candidate_id: 'cand_1',
        ratio_candidate: 0.6,
      },
      deps,
    );
    expect(saveResult.ok).toBe(true);

    const savedJson = updateCalls[0]?.data['ab_distribution_json'];
    const repo = makeRepo(savedJson);

    // genre=null で照合 → 'default' に正規化されてヒットする
    const result = await selectPromptId('editor', null, 0.6, { appSettingsRepo: repo });
    // 0.6 >= 0.6 → baseline
    expect(result).toBe('base_1');
  });
});
