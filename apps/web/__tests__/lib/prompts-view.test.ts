/**
 * prompts-view.ts ユニットテスト (T-11-08)
 *
 * テストケース:
 *  1. listActivePrompts — active なプロンプトのみ Date を ISO 文字列に正規化して返す
 *  2. listActivePrompts — 0 件のとき空配列を返す
 *  3. getPromptVersionHistory — role×genre でフィルタし版を返す
 *  4. getAbDistributionViewData — 設定ありのとき current を返す
 *  5. getAbDistributionViewData — 設定なしのとき current=null を返す
 *  6. getAbDistributionViewData — ab_distribution_json が空配列のとき current=null を返す
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import {
  listActivePrompts,
  getPromptVersionHistory,
  getAbDistributionViewData,
} from '../../lib/prompts-view';

// ---------------------------------------------------------------------------
// Prisma モック
// ---------------------------------------------------------------------------

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    prompt: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    appSettings: {
      findUnique: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------------------

const RAW_DATE = new Date('2025-01-15T09:00:00.000Z');
const RAW_ACTIVATED = new Date('2025-01-16T00:00:00.000Z');

const ACTIVE_PROMPT = {
  id: 'p-1',
  role: 'writer',
  genre: 'practical',
  version: 5,
  status: 'active',
  created_by: 'human',
  activated_at: RAW_ACTIVATED,
  archived_at: null,
  created_at: RAW_DATE,
};

const ARCHIVED_PROMPT = {
  id: 'p-0',
  role: 'writer',
  genre: 'practical',
  version: 4,
  status: 'archived',
  created_by: 'optimizer',
  activated_at: new Date('2025-01-10T00:00:00.000Z'),
  archived_at: RAW_ACTIVATED,
  created_at: new Date('2025-01-10T00:00:00.000Z'),
};

const AB_CONFIG = {
  role: 'writer',
  genre: 'practical',
  baseline_id: 'p-0',
  candidate_id: 'p-1',
  ratio_candidate: 0.5,
};

// ---------------------------------------------------------------------------
// listActivePrompts
// ---------------------------------------------------------------------------

describe('listActivePrompts', () => {
  it('Date を ISO8601 文字列に正規化して返す', async () => {
    const prisma = makePrisma();
    (prisma.prompt.findMany as Mock).mockResolvedValue([ACTIVE_PROMPT]);

    const result = await listActivePrompts(prisma as never);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('p-1');
    expect(result[0]!.created_at).toBe(RAW_DATE.toISOString());
    expect(result[0]!.activated_at).toBe(RAW_ACTIVATED.toISOString());
    expect(result[0]!.archived_at).toBeNull();
    expect(result[0]!.role).toBe('writer');
    expect(result[0]!.version).toBe(5);
  });

  it('0 件のとき空配列を返す', async () => {
    const prisma = makePrisma();
    (prisma.prompt.findMany as Mock).mockResolvedValue([]);

    const result = await listActivePrompts(prisma as never);

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getPromptVersionHistory
// ---------------------------------------------------------------------------

describe('getPromptVersionHistory', () => {
  it('role×genre に一致する全バージョンを返す', async () => {
    const prisma = makePrisma();
    (prisma.prompt.findMany as Mock).mockResolvedValue([ACTIVE_PROMPT, ARCHIVED_PROMPT]);

    const result = await getPromptVersionHistory('writer', 'practical', prisma as never);

    expect(result).toHaveLength(2);
    expect(result[0]!.version).toBe(5);
    expect(result[0]!.status).toBe('active');
    expect(result[1]!.version).toBe(4);
    expect(result[1]!.status).toBe('archived');
    // Date 正規化
    expect(result[0]!.activated_at).toBe(RAW_ACTIVATED.toISOString());
    expect(result[1]!.archived_at).toBe(RAW_ACTIVATED.toISOString());
  });

  it('対象なしのとき空配列を返す', async () => {
    const prisma = makePrisma();
    (prisma.prompt.findMany as Mock).mockResolvedValue([]);

    const result = await getPromptVersionHistory('editor', null, prisma as never);

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getAbDistributionViewData
// ---------------------------------------------------------------------------

describe('getAbDistributionViewData', () => {
  it('設定ありのとき current を返す', async () => {
    const prisma = makePrisma();
    (prisma.appSettings.findUnique as Mock).mockResolvedValue({
      ab_distribution_json: [AB_CONFIG],
    });
    (prisma.prompt.findMany as Mock).mockResolvedValue([ACTIVE_PROMPT, ARCHIVED_PROMPT]);

    const result = await getAbDistributionViewData('writer', 'practical', prisma as never);

    expect(result.current).not.toBeNull();
    expect(result.current!.baseline_id).toBe('p-0');
    expect(result.current!.ratio_candidate).toBe(0.5);
    expect(result.candidates).toHaveLength(2);
  });

  it('設定なしのとき current=null を返す', async () => {
    const prisma = makePrisma();
    (prisma.appSettings.findUnique as Mock).mockResolvedValue(null);
    (prisma.prompt.findMany as Mock).mockResolvedValue([ACTIVE_PROMPT]);

    const result = await getAbDistributionViewData('writer', 'practical', prisma as never);

    expect(result.current).toBeNull();
    expect(result.candidates).toHaveLength(1);
  });

  it('ab_distribution_json が空配列のとき current=null を返す', async () => {
    const prisma = makePrisma();
    (prisma.appSettings.findUnique as Mock).mockResolvedValue({
      ab_distribution_json: [],
    });
    (prisma.prompt.findMany as Mock).mockResolvedValue([]);

    const result = await getAbDistributionViewData('writer', 'practical', prisma as never);

    expect(result.current).toBeNull();
    expect(result.candidates).toHaveLength(0);
  });

  it('別の role×genre は current にマッチしない', async () => {
    const prisma = makePrisma();
    (prisma.appSettings.findUnique as Mock).mockResolvedValue({
      ab_distribution_json: [
        { ...AB_CONFIG, role: 'editor', genre: 'business' },
      ],
    });
    (prisma.prompt.findMany as Mock).mockResolvedValue([]);

    const result = await getAbDistributionViewData('writer', 'practical', prisma as never);

    expect(result.current).toBeNull();
  });
});
