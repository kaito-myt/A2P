/**
 * prompt-proposals-core.ts ユニットテスト (T-11-04)
 *
 * テストケース:
 *  1. approve — 新 Prompt が active / 旧 Prompt が archived / proposal が approved / AuditLog 1 行
 *  2. reject — proposal が rejected / audit_log に prompt.reject
 *  3. edit_and_approve — edited_body で新 Prompt が active
 *  4. edit_and_approve で edited_body 省略 → validation fail
 *  5. pending 以外の proposal → conflict fail
 *  6. proposal 未存在 → not_found fail
 *  7. rollback 猶予内 — active が旧版に戻り / audit_log に prompt.rollback
 *  8. rollback 猶予外 — fail('conflict', ...)
 *  9. rollback 対象が auto_approved でない → conflict fail
 * 10. invalid input → validation fail
 * 11. runTransaction はコールバックを 1 回だけ実行する (approve 経路)
 * 12. runTransaction 内で途中 throw → 後続操作が走らず例外が伝播する
 */
import { describe, expect, it, vi } from 'vitest';
import { isFail, isOk } from '@a2p/contracts';

import {
  decideProposalCore,
  rollbackAutoApprovedCore,
  type DecideProposalDeps,
  type PromptProposalRow,
  type PromptRow,
  type RunTransactionFn,
} from '../../lib/prompt-proposals-core';

const FROZEN_NOW = new Date('2026-06-14T10:00:00.000Z');
const BEFORE_NOW = new Date('2026-06-14T09:00:00.000Z');
const AFTER_NOW = new Date('2026-06-14T11:00:00.000Z');

const BASE_PROPOSAL: PromptProposalRow = {
  id: 'pp_1',
  source_prompt_id: 'p_0',
  role: 'writer',
  genre: 'practical',
  proposed_body: 'proposed prompt body',
  status: 'pending',
  rollback_until: null,
};

const ACTIVE_PROMPT: PromptRow = {
  id: 'p_1',
  role: 'writer',
  genre: 'practical',
  version: 3,
  status: 'active',
};

const PREV_PROMPT: PromptRow = {
  id: 'p_0',
  role: 'writer',
  genre: 'practical',
  version: 2,
  status: 'archived',
};

function makeNewPrompt(id = 'p_new'): PromptRow {
  return { id, role: 'writer', genre: 'practical', version: 4, status: 'active' };
}

/**
 * テスト用 runTransaction: コールバックを即時実行し、同じ spy repos を渡す。
 * これにより tx.proposalRepo / tx.promptRepo / tx.auditLogRepo の呼び出しが
 * スパイでキャプチャされる。
 */
function makeRunTransaction(txRepos: {
  proposalRepo: DecideProposalDeps['proposalRepo'];
  promptRepo: DecideProposalDeps['promptRepo'];
  auditLogRepo: DecideProposalDeps['auditLogRepo'];
}): { runTransaction: RunTransactionFn; callCount: () => number } {
  let count = 0;
  const runTransaction: RunTransactionFn = async (fn) => {
    count++;
    return fn(txRepos);
  };
  return { runTransaction, callCount: () => count };
}

function makeDeps(opts: {
  proposal?: PromptProposalRow | null;
  activePrompt?: PromptRow | null;
  previousPrompt?: PromptRow | null;
} = {}): {
  deps: DecideProposalDeps;
  spies: {
    proposalFindById: ReturnType<typeof vi.fn>;
    proposalUpdate: ReturnType<typeof vi.fn>;
    promptFindActive: ReturnType<typeof vi.fn>;
    promptFindPrev: ReturnType<typeof vi.fn>;
    promptUpdate: ReturnType<typeof vi.fn>;
    promptCreate: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    txCallCount: () => number;
  };
} {
  const proposal = opts.proposal !== undefined ? opts.proposal : BASE_PROPOSAL;
  const active = opts.activePrompt !== undefined ? opts.activePrompt : ACTIVE_PROMPT;
  const prev = opts.previousPrompt !== undefined ? opts.previousPrompt : PREV_PROMPT;

  const proposalFindById = vi.fn(async () => proposal);
  const proposalUpdate = vi.fn(async ({ data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    ...BASE_PROPOSAL,
    ...data,
  } as PromptProposalRow));

  const promptFindActive = vi.fn(async () => active);
  const promptFindPrev = vi.fn(async () => prev);
  const promptUpdate = vi.fn(async ({ data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    ...ACTIVE_PROMPT,
    ...data,
  } as PromptRow));
  const promptCreate = vi.fn(async () => makeNewPrompt());
  const auditCreate = vi.fn(async () => ({}));

  const txRepos = {
    proposalRepo: { findById: proposalFindById, update: proposalUpdate },
    promptRepo: {
      findActiveByRoleGenre: promptFindActive,
      findPreviousVersion: promptFindPrev,
      update: promptUpdate,
      create: promptCreate,
    },
    auditLogRepo: { create: auditCreate },
  };

  const { runTransaction, callCount } = makeRunTransaction(txRepos);

  const deps: DecideProposalDeps = {
    // outer repos used for pre-check reads (findById before tx)
    proposalRepo: { findById: proposalFindById, update: proposalUpdate },
    promptRepo: {
      findActiveByRoleGenre: promptFindActive,
      findPreviousVersion: promptFindPrev,
      update: promptUpdate,
      create: promptCreate,
    },
    auditLogRepo: { create: auditCreate },
    session: { user: { id: 'u_1', username: 'operator' } },
    runTransaction,
    now: FROZEN_NOW,
  };

  return {
    deps,
    spies: {
      proposalFindById,
      proposalUpdate,
      promptFindActive,
      promptFindPrev,
      promptUpdate,
      promptCreate,
      auditCreate,
      txCallCount: callCount,
    },
  };
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

describe('decideProposalCore — approve', () => {
  it('新 Prompt が active / 旧 Prompt が archived / proposal が approved / AuditLog 1 行', async () => {
    const { deps, spies } = makeDeps();
    const result = await decideProposalCore(
      { proposal_id: 'pp_1', decision: 'approve' },
      deps,
    );

    expect(isOk(result)).toBe(true);

    // 旧 active を archived に
    const archivedCall = spies.promptUpdate.mock.calls.find(
      ([arg]) => arg.where.id === ACTIVE_PROMPT.id,
    );
    expect(archivedCall).toBeDefined();
    expect(archivedCall?.[0].data.status).toBe('archived');
    expect(archivedCall?.[0].data.archived_at).toEqual(FROZEN_NOW);

    // 新 Prompt を INSERT
    expect(spies.promptCreate).toHaveBeenCalledTimes(1);
    const createArg = spies.promptCreate.mock.calls[0]?.[0];
    expect(createArg.data.status).toBe('active');
    expect(createArg.data.body).toBe(BASE_PROPOSAL.proposed_body);
    expect(createArg.data.version).toBe(ACTIVE_PROMPT.version + 1);
    expect(createArg.data.created_by).toBe('optimizer:pp_1');
    expect(createArg.data.activated_at).toEqual(FROZEN_NOW);

    // proposal を approved に
    const proposalUpdateArg = spies.proposalUpdate.mock.calls[0]?.[0];
    expect(proposalUpdateArg.data.status).toBe('approved');
    expect(proposalUpdateArg.data.decided_by).toBe('u_1');
    expect(proposalUpdateArg.data.decided_at).toEqual(FROZEN_NOW);

    // AuditLog 1 行
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    expect(auditArg.data.action).toBe('prompt.approve');
    expect(auditArg.data.target_kind).toBe('prompt_proposal');
    expect(auditArg.data.target_id).toBe('pp_1');
    expect(auditArg.data.actor_id).toBe('u_1');

    // 戻り値に new_prompt_id が含まれる
    if (isOk(result)) {
      expect(result.data.new_prompt_id).toBe('p_new');
    }
  });
});

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

describe('decideProposalCore — reject', () => {
  it('proposal が rejected / audit_log に prompt.reject', async () => {
    const { deps, spies } = makeDeps();
    const result = await decideProposalCore(
      { proposal_id: 'pp_1', decision: 'reject', rejection_note: '品質不足' },
      deps,
    );

    expect(isOk(result)).toBe(true);

    // prompt は変更されない
    expect(spies.promptCreate).not.toHaveBeenCalled();
    expect(spies.promptUpdate).not.toHaveBeenCalled();

    const proposalUpdateArg = spies.proposalUpdate.mock.calls[0]?.[0];
    expect(proposalUpdateArg.data.status).toBe('rejected');
    expect(proposalUpdateArg.data.rejection_note).toBe('品質不足');

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    expect(auditArg.data.action).toBe('prompt.reject');

    // reject 時は new_prompt_id なし
    if (isOk(result)) {
      expect(result.data.new_prompt_id).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// edit_and_approve
// ---------------------------------------------------------------------------

describe('decideProposalCore — edit_and_approve', () => {
  it('edited_body で新 Prompt が active になる', async () => {
    const { deps, spies } = makeDeps();
    const result = await decideProposalCore(
      { proposal_id: 'pp_1', decision: 'edit_and_approve', edited_body: '修正後プロンプト' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    const createArg = spies.promptCreate.mock.calls[0]?.[0];
    expect(createArg.data.body).toBe('修正後プロンプト');

    if (isOk(result)) {
      expect(result.data.new_prompt_id).toBe('p_new');
    }
  });

  it('edited_body 省略 → validation fail', async () => {
    const { deps } = makeDeps();
    const result = await decideProposalCore(
      { proposal_id: 'pp_1', decision: 'edit_and_approve' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// エラーケース
// ---------------------------------------------------------------------------

describe('decideProposalCore — error cases', () => {
  it('proposal が pending 以外 → conflict fail', async () => {
    const { deps } = makeDeps({
      proposal: { ...BASE_PROPOSAL, status: 'approved' },
    });
    const result = await decideProposalCore(
      { proposal_id: 'pp_1', decision: 'approve' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('conflict');
  });

  it('proposal 未存在 → not_found fail', async () => {
    const { deps } = makeDeps({ proposal: null });
    const result = await decideProposalCore(
      { proposal_id: 'pp_not_exist', decision: 'approve' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('not_found');
  });

  it('invalid input → validation fail', async () => {
    const { deps } = makeDeps();
    const result = await decideProposalCore({ decision: 'invalid_decision' }, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// rollbackAutoApprovedCore
// ---------------------------------------------------------------------------

describe('rollbackAutoApprovedCore — 猶予内', () => {
  it('active が旧版に戻り / audit_log に prompt.rollback', async () => {
    const autoApprovedProposal: PromptProposalRow = {
      ...BASE_PROPOSAL,
      status: 'auto_approved',
      rollback_until: AFTER_NOW, // now より後 → 猶予内
    };
    const { deps, spies } = makeDeps({ proposal: autoApprovedProposal });

    const result = await rollbackAutoApprovedCore(
      { proposal_id: 'pp_1' },
      deps,
    );

    expect(isOk(result)).toBe(true);

    // 現 active を archived に
    const archivedCall = spies.promptUpdate.mock.calls.find(
      ([arg]) => arg.where.id === ACTIVE_PROMPT.id && arg.data.status === 'archived',
    );
    expect(archivedCall).toBeDefined();

    // 旧版を active 復元
    const restoredCall = spies.promptUpdate.mock.calls.find(
      ([arg]) => arg.where.id === PREV_PROMPT.id && arg.data.status === 'active',
    );
    expect(restoredCall).toBeDefined();

    // proposal を rejected に
    const proposalUpdateArg = spies.proposalUpdate.mock.calls[0]?.[0];
    expect(proposalUpdateArg.data.status).toBe('rejected');
    expect(proposalUpdateArg.data.rejection_note).toBe('ロールバック');

    // AuditLog
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    expect(auditArg.data.action).toBe('prompt.rollback');
    expect(auditArg.data.actor_id).toBe('u_1');
  });
});

describe('rollbackAutoApprovedCore — 猶予外', () => {
  it('rollback_until < now → conflict fail', async () => {
    const expiredProposal: PromptProposalRow = {
      ...BASE_PROPOSAL,
      status: 'auto_approved',
      rollback_until: BEFORE_NOW, // now より前 → 猶予切れ
    };
    const { deps } = makeDeps({ proposal: expiredProposal });

    const result = await rollbackAutoApprovedCore(
      { proposal_id: 'pp_1' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('conflict');
  });

  it('proposal が auto_approved でない → conflict fail', async () => {
    const nonAutoProposal: PromptProposalRow = {
      ...BASE_PROPOSAL,
      status: 'approved',
      rollback_until: AFTER_NOW,
    };
    const { deps } = makeDeps({ proposal: nonAutoProposal });

    const result = await rollbackAutoApprovedCore(
      { proposal_id: 'pp_1' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('conflict');
  });
});

// ---------------------------------------------------------------------------
// トランザクション境界テスト (修正 2)
// ---------------------------------------------------------------------------

describe('runTransaction — 境界テスト', () => {
  it('approve 経路: runTransaction コールバックがちょうど 1 回実行される', async () => {
    const { deps, spies } = makeDeps();
    await decideProposalCore({ proposal_id: 'pp_1', decision: 'approve' }, deps);

    // runTransaction が 1 回だけ呼ばれたことをコールカウントで確認
    expect(spies.txCallCount()).toBe(1);
    // そのコールバック内で promptCreate が実行されている
    expect(spies.promptCreate).toHaveBeenCalledTimes(1);
  });

  it('approve 経路: tx 内で promptCreate が throw した場合、auditCreate は実行されない', async () => {
    const { deps, spies } = makeDeps();

    // promptCreate が throw するよう差し替え
    spies.promptCreate.mockRejectedValueOnce(new Error('DB constraint violation'));

    const result = await decideProposalCore(
      { proposal_id: 'pp_1', decision: 'approve' },
      deps,
    );

    // 全体がエラーになる
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('unknown');

    // promptCreate の後に来る auditCreate は呼ばれていない
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });
});
