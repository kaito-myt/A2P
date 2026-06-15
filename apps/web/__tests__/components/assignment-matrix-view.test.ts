/**
 * model-assignments-view.ts (buildAssignmentMatrix / groupCatalogByProvider /
 * genreSlotToDbValue) のユニットテスト (T-02-11).
 *
 * 検証:
 *  - genreSlotToDbValue: default → null / その他 → そのまま
 *  - dbGenreToSlot: null → default / 未知値 → null
 *  - buildAssignmentMatrix: 7 役 × 4 列のマトリクスを返す。
 *    - active 行のみ反映 (archived は無視)
 *    - 未知 genre/role は無視
 *    - catalog 突合: 単価ラベルが埋まる / 未突合は catalogMissing=true
 *  - groupCatalogByProvider: provider ごとにグルーピング + model 順ソート
 */
import { describe, expect, it } from 'vitest';

import {
  MATRIX_GENRE_SLOTS,
  MATRIX_ROLES,
  buildAssignmentMatrix,
  buildSidePaneRows,
  dbGenreToSlot,
  genreSlotToDbValue,
  groupCatalogByProvider,
  type AssignmentRowSerialized,
  type CatalogRowSerialized,
} from '../../lib/model-assignments-view';

function asg(
  overrides: Partial<AssignmentRowSerialized> & { role: string; genre: string | null },
): AssignmentRowSerialized {
  return {
    id: 'a_x',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    status: 'active',
    activated_at: '2026-05-01T00:00:00.000Z',
    archived_at: null,
    created_by: 'system',
    ...overrides,
  };
}

function cat(p: string, m: string, input = '15', output = '75'): CatalogRowSerialized {
  return {
    id: `mc_${p}_${m}`,
    provider: p,
    model: m,
    input_price_per_mtok_usd: input,
    output_price_per_mtok_usd: output,
    fx_rate_usd_jpy: '150.0000',
  };
}

describe('genreSlotToDbValue / dbGenreToSlot', () => {
  it('default ⇔ null', () => {
    expect(genreSlotToDbValue('default')).toBeNull();
    expect(dbGenreToSlot(null)).toBe('default');
  });

  it('practical / business / self_help はそのまま往復する', () => {
    for (const g of ['practical', 'business', 'self_help'] as const) {
      expect(genreSlotToDbValue(g)).toBe(g);
      expect(dbGenreToSlot(g)).toBe(g);
    }
  });

  it('dbGenreToSlot 未知値 → null (= マトリクス外)', () => {
    expect(dbGenreToSlot('mystery')).toBeNull();
  });
});

describe('buildAssignmentMatrix', () => {
  it('空入力 → 7 × 4 の空セル', () => {
    const cells = buildAssignmentMatrix([], []);
    expect(cells.length).toBe(MATRIX_ROLES.length);
    for (const row of cells) {
      expect(row.length).toBe(MATRIX_GENRE_SLOTS.length);
      for (const c of row) {
        expect(c.assignment).toBeNull();
        expect(c.inputPriceLabel).toBeNull();
        expect(c.outputPriceLabel).toBeNull();
        expect(c.catalogMissing).toBe(false);
      }
    }
  });

  it('active 1 行 + catalog 1 件 → 該当セルに provider/model + 単価が入る', () => {
    const cells = buildAssignmentMatrix(
      [asg({ id: 'a1', role: 'writer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7' })],
      [cat('anthropic', 'claude-opus-4-7', '15', '75')],
    );
    // writer 行 = index 0、default 列 = index 0
    const writerIdx = MATRIX_ROLES.indexOf('writer');
    const defaultIdx = MATRIX_GENRE_SLOTS.indexOf('default');
    const cell = cells[writerIdx]![defaultIdx]!;
    expect(cell.assignment?.id).toBe('a1');
    expect(cell.assignment?.provider).toBe('anthropic');
    expect(cell.assignment?.model).toBe('claude-opus-4-7');
    expect(cell.inputPriceLabel).toBe('$15.0000');
    expect(cell.outputPriceLabel).toBe('$75.0000');
    expect(cell.catalogMissing).toBe(false);
  });

  it('catalog にマッチする行が無い → catalogMissing=true, 単価ラベル null', () => {
    const cells = buildAssignmentMatrix(
      [asg({ id: 'a1', role: 'writer', genre: 'business', provider: 'anthropic', model: 'phantom-model' })],
      [cat('anthropic', 'claude-opus-4-7')],
    );
    const writerIdx = MATRIX_ROLES.indexOf('writer');
    const businessIdx = MATRIX_GENRE_SLOTS.indexOf('business');
    const cell = cells[writerIdx]![businessIdx]!;
    expect(cell.assignment?.model).toBe('phantom-model');
    expect(cell.catalogMissing).toBe(true);
    expect(cell.inputPriceLabel).toBeNull();
  });

  it('archived 行はマトリクスに出ない', () => {
    const cells = buildAssignmentMatrix(
      [
        asg({ id: 'a_old', role: 'writer', genre: null, status: 'archived' }),
        asg({ id: 'a_new', role: 'editor', genre: null, model: 'editor-model' }),
      ],
      [cat('anthropic', 'editor-model')],
    );
    const writerIdx = MATRIX_ROLES.indexOf('writer');
    const editorIdx = MATRIX_ROLES.indexOf('editor');
    const defaultIdx = MATRIX_GENRE_SLOTS.indexOf('default');
    expect(cells[writerIdx]![defaultIdx]!.assignment).toBeNull();
    expect(cells[editorIdx]![defaultIdx]!.assignment?.id).toBe('a_new');
  });

  it('未知の role はマトリクスに反映されない', () => {
    const cells = buildAssignmentMatrix(
      [asg({ id: 'a_x', role: 'designer', genre: null })],
      [],
    );
    for (const row of cells) {
      for (const c of row) {
        expect(c.assignment).toBeNull();
      }
    }
  });

  it('未知の genre はマトリクスに反映されない', () => {
    const cells = buildAssignmentMatrix(
      [asg({ id: 'a_x', role: 'writer', genre: 'mystery' as unknown as string })],
      [],
    );
    const writerIdx = MATRIX_ROLES.indexOf('writer');
    for (const c of cells[writerIdx]!) {
      expect(c.assignment).toBeNull();
    }
  });

  it('7 役 × 4 列 = 28 セル分の配列構造を保証する (UI が依存)', () => {
    const cells = buildAssignmentMatrix([], []);
    expect(cells.length).toBe(7);
    for (const row of cells) expect(row.length).toBe(4);
  });
});

describe('groupCatalogByProvider', () => {
  it('provider ごとにグルーピングして model 名でソートする', () => {
    const rows = [
      cat('anthropic', 'claude-opus-4-7'),
      cat('openai', 'gpt-5'),
      cat('anthropic', 'claude-sonnet-4-6'),
      cat('openai', 'gpt-image-1'),
      cat('google', 'gemini-2.0'),
    ];
    const grouped = groupCatalogByProvider(rows);
    expect(Array.from(grouped.keys()).sort()).toEqual(['anthropic', 'google', 'openai']);
    expect(grouped.get('anthropic')?.map((r) => r.model)).toEqual([
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
    expect(grouped.get('openai')?.map((r) => r.model)).toEqual(['gpt-5', 'gpt-image-1']);
  });

  it('空入力 → 空 Map', () => {
    expect(groupCatalogByProvider([]).size).toBe(0);
  });
});

describe('buildSidePaneRows', () => {
  it('provider asc, model asc で並び替え、入出力単価を $X.XXXX で整形する', () => {
    const rows = buildSidePaneRows([
      cat('openai', 'gpt-5', '5', '15'),
      cat('anthropic', 'claude-sonnet-4-6', '3', '15'),
      cat('anthropic', 'claude-opus-4-7', '15', '75'),
    ]);
    expect(rows.map((r) => `${r.provider}/${r.model}`)).toEqual([
      'anthropic/claude-opus-4-7',
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-5',
    ]);
    expect(rows[0]!.inputPriceLabel).toBe('$15.0000');
    expect(rows[0]!.outputPriceLabel).toBe('$75.0000');
    expect(rows[2]!.inputPriceLabel).toBe('$5.0000');
  });

  it('空入力 → 空配列', () => {
    expect(buildSidePaneRows([])).toEqual([]);
  });

  it('元配列を破壊的にソートしない', () => {
    const input = [
      cat('openai', 'gpt-5'),
      cat('anthropic', 'claude-opus-4-7'),
    ];
    const before = input.map((r) => r.id);
    buildSidePaneRows(input);
    expect(input.map((r) => r.id)).toEqual(before);
  });
});
