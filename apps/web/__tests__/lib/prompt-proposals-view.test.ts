/**
 * prompt-proposals-view ユニットテスト (T-11-07)
 *
 * Prisma クライアントをモックして serializeListItem / getAutoApprovalStatus の
 * Date 正規化と設定デフォルト値を検証する。
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import { listProposals, getProposalDetail, getAutoApprovalStatus } from '../../lib/prompt-proposals-view';

// ---------------------------------------------------------------------------
// Prisma モック
// ---------------------------------------------------------------------------

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    promptProposal: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    appSettings: {
      findFirst: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------------------

const RAW_DATE = new Date('2024-06-01T12:00:00.000Z');

const RAW_ROW = {
  id: 'proposal-1',
  role: 'writer',
  genre: 'practical',
  status: 'pending',
  rationale: '改訂意図',
  expected_effect_json: { score_delta: 5 },
  created_at: RAW_DATE,
  source_prompt_id: 'prompt-1',
  sourcePrompt: { version: 3, body: '旧プロンプト本文' },
  proposed_body: '新プロンプト本文',
  diff: '--- a\n+++ b\n@@ -1 +1 @@\n-旧\n+新',
  sample_output: 'サンプル出力',
  rollback_until: new Date('2024-06-02T12:00:00.000Z'),
};

// ---------------------------------------------------------------------------
// listProposals
// ---------------------------------------------------------------------------

describe('listProposals', () => {
  it('Date を ISO8601 文字列に正規化する', async () => {
    const prisma = makePrisma();
    (prisma.promptProposal.findMany as Mock).mockResolvedValue([RAW_ROW]);

    const result = await listProposals(prisma as never);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('proposal-1');
    expect(result[0]!.created_at).toBe(RAW_DATE.toISOString());
    expect(result[0]!.source_version).toBe(3);
    expect(result[0]!.genre).toBe('practical');
  });

  it('提案 0 件のとき空配列を返す', async () => {
    const prisma = makePrisma();
    (prisma.promptProposal.findMany as Mock).mockResolvedValue([]);

    const result = await listProposals(prisma as never);

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getProposalDetail
// ---------------------------------------------------------------------------

describe('getProposalDetail', () => {
  it('存在する提案の詳細を返す', async () => {
    const prisma = makePrisma();
    (prisma.promptProposal.findUnique as Mock).mockResolvedValue(RAW_ROW);

    const result = await getProposalDetail('proposal-1', prisma as never);

    expect(result).not.toBeNull();
    expect(result!.proposed_body).toBe('新プロンプト本文');
    expect(result!.diff).toBe(RAW_ROW.diff);
    expect(result!.sample_output).toBe('サンプル出力');
    expect(result!.source_prompt_body).toBe('旧プロンプト本文');
    expect(result!.rollback_until).toBe(new Date('2024-06-02T12:00:00.000Z').toISOString());
  });

  it('存在しない id のとき null を返す', async () => {
    const prisma = makePrisma();
    (prisma.promptProposal.findUnique as Mock).mockResolvedValue(null);

    const result = await getProposalDetail('no-such-id', prisma as never);

    expect(result).toBeNull();
  });

  it('rollback_until が null のとき null を返す', async () => {
    const prisma = makePrisma();
    (prisma.promptProposal.findUnique as Mock).mockResolvedValue({
      ...RAW_ROW,
      rollback_until: null,
    });

    const result = await getProposalDetail('proposal-1', prisma as never);

    expect(result!.rollback_until).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAutoApprovalStatus
// ---------------------------------------------------------------------------

describe('getAutoApprovalStatus', () => {
  it('設定が存在する場合はその値を返す', async () => {
    const prisma = makePrisma();
    (prisma.appSettings.findFirst as Mock).mockResolvedValue({
      prompt_auto_approval_enabled: true,
      prompt_auto_approval_rollback_h: 48,
    });

    const result = await getAutoApprovalStatus(prisma as never);

    expect(result.enabled).toBe(true);
    expect(result.rollback_h).toBe(48);
  });

  it('設定が存在しない場合はデフォルト値 (enabled=false, rollback_h=24) を返す', async () => {
    const prisma = makePrisma();
    (prisma.appSettings.findFirst as Mock).mockResolvedValue(null);

    const result = await getAutoApprovalStatus(prisma as never);

    expect(result.enabled).toBe(false);
    expect(result.rollback_h).toBe(24);
  });
});
