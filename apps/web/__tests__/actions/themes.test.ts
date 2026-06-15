/**
 * themes-core.ts のユニットテスト (T-03-06 / T-03-07, F-001 / F-017).
 *
 * 検証:
 *  - generateThemes: zod 検証 / Account 存在チェック / Job INSERT / enqueueJob /
 *    audit_log INSERT / theme_session_id の発行
 *  - bulkDecideThemes: 入力検証 / pending のみ updateMany / audit_log
 *  - acceptThemesAndStageBatch: pending を accepted に / redirect_to 組み立て /
 *    rejected 混在で validation
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  acceptThemesAndStageBatchCore,
  bulkDecideThemesCore,
  generateThemesCore,
  PIPELINE_THEME_GENERATE_TASK_NAME,
  type ThemeCandidateRepo,
  type ThemesDeps,
} from '../../lib/themes-core';

const FROZEN_NOW = new Date('2026-05-23T10:00:00.000Z');
const FROZEN_SESSION_ID = 'tses_test_uuid_0001';

function makeDeps(opts: {
  /** 渡されたら findUnique がこの行を返す。null なら未存在扱い。 */
  account?: { id: string; status: string } | null;
  /** enqueueJob 実装上書き (例外注入用)。 */
  enqueueImpl?: (taskName: string, payload: unknown) => Promise<string>;
  /** jobRepo.create 実装上書き (例外注入用)。 */
  jobCreateImpl?: (args: { data: unknown }) => Promise<{ id: string }>;
  /** auditLog.create 実装上書き (例外注入用)。 */
  auditCreateImpl?: (args: { data: unknown }) => Promise<unknown>;
} = {}): {
  deps: ThemesDeps;
  spies: {
    accountFindUnique: ReturnType<typeof vi.fn>;
    jobCreate: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
    genId: ReturnType<typeof vi.fn>;
  };
} {
  const accountFindUnique = vi.fn(
    async ({ where }: { where: { id: string } }) => {
      if (opts.account === null) return null;
      if (opts.account && opts.account.id === where.id) {
        return { id: opts.account.id, status: opts.account.status };
      }
      // 未指定時は default account を返す
      if (opts.account === undefined) return { id: where.id, status: 'active' };
      return null;
    },
  );

  let jobIdCounter = 0;
  const jobCreate = vi.fn(
    opts.jobCreateImpl ?? (async () => {
      jobIdCounter += 1;
      return { id: `job_${jobIdCounter}` };
    }),
  );

  const auditCreate = vi.fn(opts.auditCreateImpl ?? (async () => ({})));
  const enqueue = vi.fn(opts.enqueueImpl ?? (async () => 'graphile_job_42'));
  const genId = vi.fn(() => FROZEN_SESSION_ID);

  return {
    deps: {
      accountRepo: {
        findUnique: accountFindUnique,
      } as unknown as ThemesDeps['accountRepo'],
      jobRepo: { create: jobCreate } as unknown as ThemesDeps['jobRepo'],
      auditLogRepo: { create: auditCreate } as unknown as ThemesDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
      enqueueJob: enqueue,
      genId,
      now: () => FROZEN_NOW,
    },
    spies: { accountFindUnique, jobCreate, auditCreate, enqueue, genId },
  };
}

// ---------------------------------------------------------------------------
// generateThemesCore: 入力 zod 検証
// ---------------------------------------------------------------------------

describe('generateThemesCore — input validation', () => {
  it('accountId 欠落で validation', async () => {
    const { deps } = makeDeps();
    const r = await generateThemesCore(
      { genre: 'business', keywordOrBrief: '副業' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('keywordOrBrief 空文字で validation', async () => {
    const { deps } = makeDeps();
    const r = await generateThemesCore(
      { accountId: 'acc_1', genre: 'business', keywordOrBrief: '' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('count > 30 で validation', async () => {
    const { deps } = makeDeps();
    const r = await generateThemesCore(
      { accountId: 'acc_1', genre: 'business', keywordOrBrief: '副業', count: 31 },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('count 未指定で既定 10 が適用される (Job.payload_json で確認)', async () => {
    const { deps, spies } = makeDeps();
    const r = await generateThemesCore(
      { accountId: 'acc_1', genre: 'business', keywordOrBrief: '副業' },
      deps,
    );
    expect(isOk(r)).toBe(true);
    const jobArg = spies.jobCreate.mock.calls[0]?.[0];
    expect(jobArg.data.payload_json.count).toBe(10);
  });

  it('genre は null 許容 (全ジャンル既定)', async () => {
    const { deps, spies } = makeDeps();
    const r = await generateThemesCore(
      { accountId: 'acc_1', genre: null, keywordOrBrief: '副業' },
      deps,
    );
    expect(isOk(r)).toBe(true);
    const jobArg = spies.jobCreate.mock.calls[0]?.[0];
    expect(jobArg.data.payload_json.genre).toBeNull();
  });

  it('excludeTitlesRecent > 500 件で validation', async () => {
    const { deps } = makeDeps();
    const titles = Array.from({ length: 501 }, (_, i) => `t${i}`);
    const r = await generateThemesCore(
      {
        accountId: 'acc_1',
        genre: 'business',
        keywordOrBrief: '副業',
        excludeTitlesRecent: titles,
      },
      deps,
    );
    expect(isFail(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateThemesCore: happy path
// ---------------------------------------------------------------------------

describe('generateThemesCore — happy path', () => {
  it('Job INSERT → enqueueJob → audit_log の順に走り session_id/job_id を返す', async () => {
    const { deps, spies } = makeDeps({
      account: { id: 'acc_1', status: 'active' },
    });
    const r = await generateThemesCore(
      {
        accountId: 'acc_1',
        genre: 'business',
        keywordOrBrief: '副業で月 10 万を稼ぐ',
        count: 12,
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.session_id).toBe(FROZEN_SESSION_ID);
      expect(r.data.job_id).toBe('job_1');
    }

    // Account 存在チェック (FK 違反前)
    expect(spies.accountFindUnique).toHaveBeenCalledWith({
      where: { id: 'acc_1' },
      select: { id: true, status: true },
    });

    // Job 行 INSERT (kind=pipeline.theme.generate, book_id=null, payload に全パラメタ)
    expect(spies.jobCreate).toHaveBeenCalledTimes(1);
    const jobArg = spies.jobCreate.mock.calls[0]?.[0];
    expect(jobArg.data.kind).toBe(PIPELINE_THEME_GENERATE_TASK_NAME);
    // book_id を渡さなければ DB schema 上 NULL になる (Job.book_id は optional)
    expect(jobArg.data.book_id).toBeUndefined();
    expect(jobArg.data.status).toBe('queued');
    expect(jobArg.data.payload_json).toMatchObject({
      theme_session_id: FROZEN_SESSION_ID,
      account_id: 'acc_1',
      genre: 'business',
      keyword_or_brief: '副業で月 10 万を稼ぐ',
      count: 12,
    });

    // graphile-worker enqueue は最小 payload (theme_session_id + job_id) のみ
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    const [taskName, enqPayload] = spies.enqueue.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(taskName).toBe(PIPELINE_THEME_GENERATE_TASK_NAME);
    expect(enqPayload).toEqual({
      theme_session_id: FROZEN_SESSION_ID,
      job_id: 'job_1',
    });

    // audit_log
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0];
    expect(auditArg.data.action).toBe('theme_session.generate');
    expect(auditArg.data.target_kind).toBe('theme_session');
    expect(auditArg.data.target_id).toBe(FROZEN_SESSION_ID);
    expect(auditArg.data.actor_id).toBe('u_1');
    expect(auditArg.data.before_json).toBe(Prisma.JsonNull);
    expect(auditArg.data.after_json).toMatchObject({
      theme_session_id: FROZEN_SESSION_ID,
      job_id: 'job_1',
      account_id: 'acc_1',
      genre: 'business',
      count: 12,
    });
  });

  it('excludeTitlesRecent 明示指定は payload に乗る', async () => {
    const { deps, spies } = makeDeps();
    const titles = ['副業ガイド', '時短術 100'];
    const r = await generateThemesCore(
      {
        accountId: 'acc_1',
        genre: 'practical',
        keywordOrBrief: '副業',
        excludeTitlesRecent: titles,
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    const jobArg = spies.jobCreate.mock.calls[0]?.[0];
    expect(jobArg.data.payload_json.exclude_titles_recent).toEqual(titles);
  });

  it('genId が呼ばれ、毎回 unique な theme_session_id を生成できる', async () => {
    const { deps, spies } = makeDeps();
    // 同 deps で 2 回呼んでも genId が 2 回呼ばれること
    await generateThemesCore(
      { accountId: 'acc_1', genre: 'business', keywordOrBrief: 'k1' },
      deps,
    );
    await generateThemesCore(
      { accountId: 'acc_1', genre: 'business', keywordOrBrief: 'k2' },
      deps,
    );
    expect(spies.genId).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// generateThemesCore: error paths
// ---------------------------------------------------------------------------

describe('generateThemesCore — error paths', () => {
  it('Account 未存在で not_found を返し DB は触らない', async () => {
    const { deps, spies } = makeDeps({ account: null });
    const r = await generateThemesCore(
      { accountId: 'acc_missing', genre: 'business', keywordOrBrief: '副業' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
    expect(spies.jobCreate).not.toHaveBeenCalled();
    expect(spies.enqueue).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('jobRepo.create 失敗で fail / enqueueJob と audit_log は呼ばれない', async () => {
    const { deps, spies } = makeDeps({
      jobCreateImpl: async () => {
        throw new Error('db boom');
      },
    });
    const r = await generateThemesCore(
      { accountId: 'acc_1', genre: 'business', keywordOrBrief: '副業' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    expect(spies.enqueue).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('enqueueJob 失敗で fail / Job INSERT は走っているが audit_log は呼ばれない', async () => {
    const { deps, spies } = makeDeps({
      enqueueImpl: async () => {
        throw new Error('graphile down');
      },
    });
    const r = await generateThemesCore(
      { accountId: 'acc_1', genre: 'business', keywordOrBrief: '副業' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    // Job 行は INSERT 済 (graphile-worker.jobs と内部 Job の二重 enqueue は別途回収する想定)
    expect(spies.jobCreate).toHaveBeenCalledTimes(1);
    // enqueue が失敗したので audit_log は走らない
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('A2PError は toActionResult で code/message を保つ', async () => {
    const { deps } = makeDeps({ account: null });
    const r = await generateThemesCore(
      { accountId: 'acc_missing', genre: 'business', keywordOrBrief: '副業' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) {
      expect(r.error.code).toBe('not_found');
      // userMessage が messages.themes.errors.accountNotFound にマップされている
      expect(r.error.message).toContain('アカウント');
    }
  });
});

// ---------------------------------------------------------------------------
// bulkDecideThemesCore / acceptThemesAndStageBatchCore 用 deps factory
// ---------------------------------------------------------------------------

type ThemeRowStub = {
  id: string;
  account_id: string;
  theme_session_id: string;
  status: 'pending' | 'accepted' | 'rejected';
  title: string;
};

function makeBulkDeps(opts: {
  rows: ThemeRowStub[];
  /** updateMany 例外注入 */
  updateThrows?: Error;
}): {
  deps: ThemesDeps;
  spies: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
  };
  store: ThemeRowStub[];
} {
  const store: ThemeRowStub[] = opts.rows.map((r) => ({ ...r }));

  const findMany = vi.fn(
    async (args: {
      where: { id: { in: string[] }; status?: string | { in: string[] } };
    }) => {
      const ids = new Set(args.where.id.in);
      const statusFilter = args.where.status;
      return store
        .filter((r) => {
          if (!ids.has(r.id)) return false;
          if (statusFilter === undefined) return true;
          if (typeof statusFilter === 'string') return r.status === statusFilter;
          return statusFilter.in.includes(r.status);
        })
        .map((r) => ({
          id: r.id,
          account_id: r.account_id,
          theme_session_id: r.theme_session_id,
          status: r.status,
          title: r.title,
        }));
    },
  );

  const updateMany = vi.fn(
    async (args: {
      where: { id: { in: string[] }; status?: string };
      data: { status: string; decided_at: Date };
    }) => {
      if (opts.updateThrows) throw opts.updateThrows;
      const ids = new Set(args.where.id.in);
      let count = 0;
      for (const r of store) {
        if (!ids.has(r.id)) continue;
        if (args.where.status !== undefined && r.status !== args.where.status) continue;
        r.status = args.data.status as ThemeRowStub['status'];
        count++;
      }
      return { count };
    },
  );

  const auditCreate = vi.fn(async () => ({}));

  const themeCandidateRepo: ThemeCandidateRepo = {
    findMany,
    updateMany,
  };

  // 即時実行 runTransaction (in-memory state を tx で共有)
  const runTransaction: NonNullable<ThemesDeps['runTransaction']> = async (fn) =>
    fn({
      themeCandidateRepo,
      auditLogRepo: { create: auditCreate } as ThemesDeps['auditLogRepo'],
    });

  return {
    deps: {
      accountRepo: { findUnique: vi.fn() } as unknown as ThemesDeps['accountRepo'],
      jobRepo: { create: vi.fn() } as unknown as ThemesDeps['jobRepo'],
      auditLogRepo: { create: auditCreate } as unknown as ThemesDeps['auditLogRepo'],
      themeCandidateRepo,
      runTransaction,
      session: { user: { id: 'u_1', username: 'operator' } },
      enqueueJob: vi.fn(),
      now: () => FROZEN_NOW,
    },
    spies: { findMany, updateMany, auditCreate },
    store,
  };
}

function rowStub(
  id: string,
  status: ThemeRowStub['status'] = 'pending',
  overrides: Partial<ThemeRowStub> = {},
): ThemeRowStub {
  return {
    id,
    account_id: 'acc_1',
    theme_session_id: 'tses_1',
    status,
    title: `Title ${id}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// bulkDecideThemesCore
// ---------------------------------------------------------------------------

describe('bulkDecideThemesCore — input validation', () => {
  it('theme_ids 空配列で validation', async () => {
    const { deps, spies } = makeBulkDeps({ rows: [] });
    const r = await bulkDecideThemesCore({ theme_ids: [], decision: 'accept' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.findMany).not.toHaveBeenCalled();
  });

  it('theme_ids 101 件で validation', async () => {
    const { deps } = makeBulkDeps({ rows: [] });
    const ids = Array.from({ length: 101 }, (_, i) => `t_${i}`);
    const r = await bulkDecideThemesCore({ theme_ids: ids, decision: 'accept' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('decision が enum 外で validation', async () => {
    const { deps } = makeBulkDeps({ rows: [] });
    const r = await bulkDecideThemesCore(
      { theme_ids: ['t_1'], decision: 'maybe' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

describe('bulkDecideThemesCore — accept happy path', () => {
  it('pending 5 件 accept → updateMany で 5 件 / audit_log 1 件 (action=themes.bulk_decide)', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => rowStub(`t_${i}`, 'pending'));
    const { deps, spies, store } = makeBulkDeps({ rows });
    const r = await bulkDecideThemesCore(
      { theme_ids: rows.map((r) => r.id), decision: 'accept' },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.updated).toBe(5);

    // store の status が全て accepted に
    for (const s of store) expect(s.status).toBe('accepted');

    expect(spies.updateMany).toHaveBeenCalledTimes(1);
    const updateArg = spies.updateMany.mock.calls[0]?.[0] as {
      where: { status: string; id: { in: string[] } };
      data: { status: string; decided_at: Date };
    };
    expect(updateArg.where.status).toBe('pending');
    expect(updateArg.data.status).toBe('accepted');
    expect(updateArg.data.decided_at).toEqual(FROZEN_NOW);
    expect(updateArg.where.id.in).toHaveLength(5);

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe('themes.bulk_decide');
    expect(auditArg.data.target_kind).toBe('theme_candidate');
    expect(auditArg.data.target_id).toBe('bulk');
    expect(auditArg.data.actor_id).toBe('u_1');
    const after = auditArg.data.after_json as Record<string, unknown>;
    expect(after.decision).toBe('accept');
    expect(after.new_status).toBe('accepted');
    expect(after.updated_count).toBe(5);
  });

  it('reject + reject_reason は updateMany の data.rejected_reason に乗る', async () => {
    const rows = [rowStub('t_1', 'pending'), rowStub('t_2', 'pending')];
    const { deps, spies } = makeBulkDeps({ rows });
    const r = await bulkDecideThemesCore(
      { theme_ids: ['t_1', 't_2'], decision: 'reject', reject_reason: '重複あり' },
      deps,
    );
    expect(isOk(r)).toBe(true);
    const updateArg = spies.updateMany.mock.calls[0]?.[0] as {
      data: { status: string; rejected_reason?: string };
    };
    expect(updateArg.data.status).toBe('rejected');
    expect(updateArg.data.rejected_reason).toBe('重複あり');

    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as {
      data: { after_json: Record<string, unknown> };
    };
    expect(auditArg.data.after_json.rejected_reason).toBe('重複あり');
  });
});

describe('bulkDecideThemesCore — mixed status / partial update', () => {
  it('pending 3 + accepted 1 + rejected 1 混在 → pending 3 件のみ更新', async () => {
    const rows = [
      rowStub('t_1', 'pending'),
      rowStub('t_2', 'pending'),
      rowStub('t_3', 'pending'),
      rowStub('t_acc', 'accepted'),
      rowStub('t_rej', 'rejected'),
    ];
    const { deps, spies, store } = makeBulkDeps({ rows });
    const r = await bulkDecideThemesCore(
      {
        theme_ids: ['t_1', 't_2', 't_3', 't_acc', 't_rej'],
        decision: 'accept',
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.updated).toBe(3);

    // accepted/rejected はそのまま
    expect(store.find((r) => r.id === 't_acc')!.status).toBe('accepted');
    expect(store.find((r) => r.id === 't_rej')!.status).toBe('rejected');

    // updateMany には pending 3 件のみの id が渡る
    const updateArg = spies.updateMany.mock.calls[0]?.[0] as {
      where: { id: { in: string[] } };
    };
    expect(updateArg.where.id.in.sort()).toEqual(['t_1', 't_2', 't_3']);
  });

  it('全件 accepted 済みなら no_pending として validation エラー / updateMany 走らない', async () => {
    const rows = [rowStub('t_1', 'accepted'), rowStub('t_2', 'accepted')];
    const { deps, spies } = makeBulkDeps({ rows });
    const r = await bulkDecideThemesCore(
      { theme_ids: ['t_1', 't_2'], decision: 'accept' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.updateMany).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });
});

describe('bulkDecideThemesCore — config / error paths', () => {
  it('themeCandidateRepo 未注入で config エラー', async () => {
    const r = await bulkDecideThemesCore(
      { theme_ids: ['t_1'], decision: 'accept' },
      {
        accountRepo: { findUnique: vi.fn() } as unknown as ThemesDeps['accountRepo'],
        jobRepo: { create: vi.fn() } as unknown as ThemesDeps['jobRepo'],
        auditLogRepo: { create: vi.fn() } as unknown as ThemesDeps['auditLogRepo'],
        session: { user: { id: 'u_1', username: 'operator' } },
        enqueueJob: vi.fn(),
      },
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('config');
  });

  it('updateMany が throw すれば unknown を返す / audit 走らない', async () => {
    const rows = [rowStub('t_1', 'pending')];
    const { deps, spies } = makeBulkDeps({
      rows,
      updateThrows: new Error('db boom'),
    });
    const r = await bulkDecideThemesCore(
      { theme_ids: ['t_1'], decision: 'accept' },
      deps,
    );
    expect(isFail(r)).toBe(true);
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// acceptThemesAndStageBatchCore
// ---------------------------------------------------------------------------

describe('acceptThemesAndStageBatchCore — happy path', () => {
  it('pending → accepted 遷移 + redirect_to が /batches/new?theme_ids=...', async () => {
    const rows = [
      rowStub('t_1', 'pending'),
      rowStub('t_2', 'pending'),
      rowStub('t_3', 'pending'),
    ];
    const { deps, spies, store } = makeBulkDeps({ rows });
    const r = await acceptThemesAndStageBatchCore(
      { theme_ids: ['t_1', 't_2', 't_3'] },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.staged_count).toBe(3);
      expect(r.data.redirect_to).toMatch(/^\/batches\/new\?theme_ids=/);
      const url = new URL(`http://x${r.data.redirect_to}`);
      const ids = (url.searchParams.get('theme_ids') ?? '').split(',').sort();
      expect(ids).toEqual(['t_1', 't_2', 't_3']);
    }
    for (const s of store) expect(s.status).toBe('accepted');

    // audit_log は action='themes.stage_batch' 1 件
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe('themes.stage_batch');
    expect(auditArg.data.target_kind).toBe('theme_candidate');
  });

  it('既に accepted 済みのテーマだけでも redirect_to は返す (updateMany はスキップ)', async () => {
    const rows = [rowStub('t_a', 'accepted'), rowStub('t_b', 'accepted')];
    const { deps, spies } = makeBulkDeps({ rows });
    const r = await acceptThemesAndStageBatchCore(
      { theme_ids: ['t_a', 't_b'] },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.staged_count).toBe(2);
      expect(r.data.redirect_to).toContain('t_a');
      expect(r.data.redirect_to).toContain('t_b');
    }
    // pending が無いので updateMany は呼ばれない
    expect(spies.updateMany).not.toHaveBeenCalled();
    // audit_log は走る
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
  });

  it('pending + accepted 混在 → pending のみ accept 遷移、total_staged は全件', async () => {
    const rows = [
      rowStub('t_p1', 'pending'),
      rowStub('t_p2', 'pending'),
      rowStub('t_a', 'accepted'),
    ];
    const { deps, store } = makeBulkDeps({ rows });
    const r = await acceptThemesAndStageBatchCore(
      { theme_ids: ['t_p1', 't_p2', 't_a'] },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.staged_count).toBe(3);
    expect(store.find((s) => s.id === 't_p1')!.status).toBe('accepted');
    expect(store.find((s) => s.id === 't_p2')!.status).toBe('accepted');
    expect(store.find((s) => s.id === 't_a')!.status).toBe('accepted');
  });
});

describe('acceptThemesAndStageBatchCore — error paths', () => {
  it('rejected 混在で validation / 更新も audit も走らない', async () => {
    const rows = [rowStub('t_p', 'pending'), rowStub('t_r', 'rejected')];
    const { deps, spies, store } = makeBulkDeps({ rows });
    const r = await acceptThemesAndStageBatchCore(
      { theme_ids: ['t_p', 't_r'] },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    // store は変更されない
    expect(store.find((s) => s.id === 't_p')!.status).toBe('pending');
    expect(spies.updateMany).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });

  it('theme_ids 全件が DB に存在しない → not_found', async () => {
    const { deps } = makeBulkDeps({ rows: [] });
    const r = await acceptThemesAndStageBatchCore(
      { theme_ids: ['t_missing'] },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });

  it('zod: theme_ids 空で validation', async () => {
    const { deps } = makeBulkDeps({ rows: [] });
    const r = await acceptThemesAndStageBatchCore({ theme_ids: [] }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// Prisma import 警告抑止 (型チェッカ用、未使用判定対策)
void Prisma;
