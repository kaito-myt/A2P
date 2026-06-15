/**
 * auto-approval.ts のユニットテスト (T-11-05)
 *
 * 5 ケース:
 *   1. enabled=false → shouldAutoApprove:false (AppSettings フラグ OFF)
 *   2. eval_results が 4 件 → shouldAutoApprove:false (件数不足)
 *   3. eval_results スコアが途中で減少 → shouldAutoApprove:false (非単調)
 *   4. eval_results 5 件かつ単調増加 → shouldAutoApprove:true + rollback_until 検証
 *   5. 自動承認成立時、PromptProposal.status='auto_approved' & rollback_until 設定確認
 */
import { describe, expect, it } from 'vitest';

import {
  checkAutoApproval,
  performAutoApproval,
  type AutoApprovalDeps,
  type AutoApprovalPrisma,
  type AutoApprovalTransactionPrisma,
} from '../src/lib/auto-approval.js';

// ---------------------------------------------------------------------------
// テスト用固定時刻
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-06-15T00:00:00.000Z');
const ROLLBACK_H = 24;

// ---------------------------------------------------------------------------
// ファクトリ
// ---------------------------------------------------------------------------

interface EvalRow {
  score_total: number;
  prompt_version_ids_json: Record<string, string>;
  judged_at: Date;
}

interface BuildPrismaArgs {
  autoApprovalEnabled: boolean;
  rollbackH?: number;
  proposalExists?: boolean;
  proposalRole?: string;
  proposalGenre?: string | null;
  newPromptIds?: string[]; // created_by='optimizer:<proposalId>' の prompt id 一覧
  evalRows?: EvalRow[];
}

interface TransactionCapture {
  promptUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  promptCreates: Array<{ data: Record<string, unknown> }>;
  proposalUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  auditLogCreates: Array<{ data: Record<string, unknown> }>;
}

function buildPrisma(args: BuildPrismaArgs): {
  prisma: AutoApprovalPrisma;
  capture: TransactionCapture;
} {
  const capture: TransactionCapture = {
    promptUpdates: [],
    promptCreates: [],
    proposalUpdates: [],
    auditLogCreates: [],
  };

  // モック上での現 active prompt（transaction 内で参照される）
  let mockActivePromptVersion = 3;
  let mockActivePromptId = 'prompt-active-001';

  const prisma: AutoApprovalPrisma = {
    appSettings: {
      findUnique: async () => ({
        prompt_auto_approval_enabled: args.autoApprovalEnabled,
        prompt_auto_approval_rollback_h: args.rollbackH ?? ROLLBACK_H,
      }),
    },
    promptProposal: {
      findUnique: async ({ where }) => {
        if (!args.proposalExists) return null;
        return {
          source_prompt_id: 'source-prompt-001',
          role: args.proposalRole ?? 'writer',
          genre: args.proposalGenre ?? null,
          status: 'pending',
        };
      },
    },
    prompt: {
      findMany: async ({ where }) => {
        return (args.newPromptIds ?? []).map((id) => ({ id }));
      },
    },
    evalResult: {
      findMany: async () => {
        return args.evalRows ?? [];
      },
    },
    $transaction: async (fn) => {
      const tx: AutoApprovalTransactionPrisma = {
        prompt: {
          findFirst: async () => ({
            id: mockActivePromptId,
            version: mockActivePromptVersion,
          }),
          update: async ({ where, data }) => {
            capture.promptUpdates.push({ id: where.id, data });
            return {};
          },
          create: async ({ data }) => {
            capture.promptCreates.push({ data });
            return { id: 'new-prompt-created-001' };
          },
        },
        promptProposal: {
          update: async ({ where, data }) => {
            capture.proposalUpdates.push({ id: where.id, data });
            return {};
          },
        },
        auditLog: {
          create: async ({ data }) => {
            capture.auditLogCreates.push({ data });
            return {};
          },
        },
      };
      return fn(tx);
    },
  };

  return { prisma, capture };
}

function makeDeps(prisma: AutoApprovalPrisma): AutoApprovalDeps {
  return {
    prisma,
    now: () => FIXED_NOW,
  };
}

// ---------------------------------------------------------------------------
// ケース 1: enabled=false → false
// ---------------------------------------------------------------------------

describe('checkAutoApproval — enabled=false', () => {
  it('prompt_auto_approval_enabled=false のとき常に false を返す', async () => {
    const { prisma } = buildPrisma({
      autoApprovalEnabled: false,
      proposalExists: true,
      newPromptIds: ['prompt-new-001'],
      evalRows: [
        { score_total: 70, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-01') },
        { score_total: 72, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-02') },
        { score_total: 74, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-03') },
        { score_total: 76, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-04') },
        { score_total: 78, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-05') },
      ],
    });

    const result = await checkAutoApproval('proposal-001', makeDeps(prisma));

    expect(result).toEqual({ shouldAutoApprove: false });
  });
});

// ---------------------------------------------------------------------------
// ケース 2: eval_results が 4 件 → false
// ---------------------------------------------------------------------------

describe('checkAutoApproval — 件数不足 (4 件)', () => {
  it('eval_results が 4 件のとき shouldAutoApprove=false', async () => {
    const { prisma } = buildPrisma({
      autoApprovalEnabled: true,
      proposalExists: true,
      newPromptIds: ['prompt-new-001'],
      evalRows: [
        { score_total: 70, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-01') },
        { score_total: 72, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-02') },
        { score_total: 74, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-03') },
        { score_total: 76, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-04') },
      ],
    });

    const result = await checkAutoApproval('proposal-001', makeDeps(prisma));

    expect(result).toEqual({ shouldAutoApprove: false });
  });
});

// ---------------------------------------------------------------------------
// ケース 3: スコアが途中で減少 → false
// ---------------------------------------------------------------------------

describe('checkAutoApproval — スコア非単調 (途中で減少)', () => {
  it('score[3] < score[2] のとき shouldAutoApprove=false', async () => {
    const { prisma } = buildPrisma({
      autoApprovalEnabled: true,
      proposalExists: true,
      newPromptIds: ['prompt-new-001'],
      evalRows: [
        { score_total: 70, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-01') },
        { score_total: 72, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-02') },
        { score_total: 80, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-03') },
        { score_total: 75, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-04') }, // 減少
        { score_total: 78, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-05') },
      ],
    });

    const result = await checkAutoApproval('proposal-001', makeDeps(prisma));

    expect(result).toEqual({ shouldAutoApprove: false });
  });
});

// ---------------------------------------------------------------------------
// ケース 4: 5 件 + 単調増加 → shouldAutoApprove:true + rollback_until 検証
// ---------------------------------------------------------------------------

describe('checkAutoApproval — 5 件単調増加 → true', () => {
  it('shouldAutoApprove=true かつ rollback_until=now+rollback_h 時間', async () => {
    const { prisma } = buildPrisma({
      autoApprovalEnabled: true,
      rollbackH: ROLLBACK_H,
      proposalExists: true,
      newPromptIds: ['prompt-new-001'],
      evalRows: [
        { score_total: 70, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-01') },
        { score_total: 72, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-02') },
        { score_total: 74, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-03') },
        { score_total: 76, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-04') },
        { score_total: 78, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-05') },
      ],
    });

    const result = await checkAutoApproval('proposal-001', makeDeps(prisma));

    expect(result.shouldAutoApprove).toBe(true);

    // rollback_until = FIXED_NOW + 24 * 3600 * 1000 ms
    const expectedRollbackUntil = new Date(FIXED_NOW.getTime() + ROLLBACK_H * 3_600_000);
    expect(result.rollback_until).toEqual(expectedRollbackUntil);
    // 具体的に: 2026-06-16T00:00:00.000Z
    expect(result.rollback_until?.toISOString()).toBe('2026-06-16T00:00:00.000Z');
  });

  it('score[i+1] === score[i] (等しい場合も単調増加として扱う)', async () => {
    const { prisma } = buildPrisma({
      autoApprovalEnabled: true,
      proposalExists: true,
      newPromptIds: ['prompt-new-001'],
      evalRows: [
        { score_total: 70, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-01') },
        { score_total: 70, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-02') }, // 等しい
        { score_total: 72, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-03') },
        { score_total: 74, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-04') },
        { score_total: 76, prompt_version_ids_json: { writer: 'prompt-new-001' }, judged_at: new Date('2026-06-05') },
      ],
    });

    const result = await checkAutoApproval('proposal-001', makeDeps(prisma));

    expect(result.shouldAutoApprove).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ケース 5: performAutoApproval — PromptProposal.status='auto_approved' & rollback_until 設定
// ---------------------------------------------------------------------------

describe('performAutoApproval — DB 副作用検証', () => {
  it('自動承認成立時、PromptProposal.status=auto_approved かつ rollback_until が設定される', async () => {
    const { prisma, capture } = buildPrisma({
      autoApprovalEnabled: true,
      proposalExists: true,
    });

    const rollbackUntil = new Date(FIXED_NOW.getTime() + ROLLBACK_H * 3_600_000);

    await performAutoApproval(
      'proposal-001',
      {
        role: 'writer',
        genre: null,
        proposedBody: '改訂後プロンプト本文',
        rollbackUntil,
        now: FIXED_NOW,
      },
      prisma,
    );

    // PromptProposal が auto_approved に更新された
    const proposalUpdate = capture.proposalUpdates.find((u) => u.id === 'proposal-001');
    expect(proposalUpdate).toBeDefined();
    expect(proposalUpdate?.data.status).toBe('auto_approved');
    expect(proposalUpdate?.data.decided_by).toBe('auto');
    expect(proposalUpdate?.data.decided_at).toEqual(FIXED_NOW);
    expect(proposalUpdate?.data.rollback_until).toEqual(rollbackUntil);

    // 旧 active が archived に
    const archiveUpdate = capture.promptUpdates.find((u) => u.data.status === 'archived');
    expect(archiveUpdate).toBeDefined();
    expect(archiveUpdate?.data.archived_at).toEqual(FIXED_NOW);

    // 新版が INSERT された
    expect(capture.promptCreates).toHaveLength(1);
    expect(capture.promptCreates[0]?.data.status).toBe('active');
    expect(capture.promptCreates[0]?.data.created_by).toBe('optimizer:proposal-001');

    // AuditLog が挿入された
    expect(capture.auditLogCreates).toHaveLength(1);
    const auditData = capture.auditLogCreates[0]?.data;
    expect(auditData?.actor_id).toBeNull();
    expect(auditData?.action).toBe('prompt.approve');
    expect(auditData?.target_kind).toBe('prompt_proposal');
    expect(auditData?.target_id).toBe('proposal-001');
    // trigger='auto' で区別できること
    expect((auditData?.before_json as Record<string, unknown>)?.trigger).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// 追加: proposal が存在しない場合
// ---------------------------------------------------------------------------

describe('checkAutoApproval — proposal 不在', () => {
  it('proposal が見つからない場合 false を返す', async () => {
    const { prisma } = buildPrisma({
      autoApprovalEnabled: true,
      proposalExists: false,
    });

    const result = await checkAutoApproval('nonexistent-proposal', makeDeps(prisma));

    expect(result).toEqual({ shouldAutoApprove: false });
  });
});

// ---------------------------------------------------------------------------
// 追加: 新 prompt_version が未存在 (生成直後・0 冊時点)
// ---------------------------------------------------------------------------

describe('checkAutoApproval — 生成直後 (新 prompt_version なし)', () => {
  it('created_by=optimizer:<proposalId> の prompt が存在しない場合 false を返す', async () => {
    const { prisma } = buildPrisma({
      autoApprovalEnabled: true,
      proposalExists: true,
      newPromptIds: [], // 新版未作成
    });

    const result = await checkAutoApproval('proposal-001', makeDeps(prisma));

    expect(result).toEqual({ shouldAutoApprove: false });
  });
});
