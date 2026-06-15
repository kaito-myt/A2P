/**
 * outlines-core.ts のユニットテスト (T-04-07, F-018).
 *
 * 検証:
 *  - bulkApproveOutlines:
 *    - 入力 zod (空配列 / 上限超過)
 *    - pending_review のみ更新 / status_not_pending_review を failed_items に収集
 *    - Outline.status='approved' + approved_at 設定 / Book.status='running'
 *    - Job(kind='pipeline.book.writer.chapters.dispatch') INSERT + enqueueJob 呼出
 *    - audit_log 1 件 (action='outlines.bulk_approve')
 *    - enqueue 失敗時に failed_items.enqueue_failed を返す (部分成功)
 *  - bulkRejectOutlines:
 *    - reject_note 必須 (zod)
 *    - 重複 outline_id 検出
 *    - Outline.status='rejected' + reject_note 設定
 *    - Job(kind='pipeline.book.writer.outline', payload に reject_note) + enqueue
 *    - audit_log 1 件 (action='outlines.bulk_reject')
 *  - 未認証ケースは SA ラッパ層 (`app/actions/outlines.ts`) で getSessionOrThrow が
 *    AuthError を投げる経路を持つため、core 単体テストでは「session 必須型である」
 *    ことを TS で担保し、AuthError 文言の検証は assertAuthenticatedSession 既存テストで
 *    カバー済み (auth-helpers.test.ts)。
 */
import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  bulkApproveOutlinesCore,
  bulkRejectOutlinesCore,
  PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
  PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
  type OutlinesDeps,
} from '../../lib/outlines-core';

const FROZEN_NOW = new Date('2026-05-25T10:00:00.000Z');

type OutlineRowStub = {
  id: string;
  book_id: string;
  status: 'draft' | 'pending_review' | 'approved' | 'rejected';
  approved_at: Date | null;
  reject_note: string | null;
};

type BookRowStub = {
  id: string;
  status: string;
};

function makeDeps(opts: {
  outlines?: OutlineRowStub[];
  books?: BookRowStub[];
  /** enqueueJob 上書き (失敗注入用)。 */
  enqueueImpl?: (taskName: string, payload: unknown) => Promise<string>;
  /** jobRepo.create 上書き (失敗注入用、tx 内)。 */
  jobCreateImpl?: () => Promise<{ id: string }>;
}): {
  deps: OutlinesDeps;
  spies: {
    outlineFindMany: ReturnType<typeof vi.fn>;
    outlineUpdate: ReturnType<typeof vi.fn>;
    bookUpdate: ReturnType<typeof vi.fn>;
    jobCreate: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };
  outlinesStore: OutlineRowStub[];
  booksStore: BookRowStub[];
} {
  const outlinesStore: OutlineRowStub[] = (opts.outlines ?? []).map((r) => ({ ...r }));
  const booksStore: BookRowStub[] = (
    opts.books ??
    outlinesStore.map((o) => ({ id: o.book_id, status: 'queued' }))
  ).map((b) => ({ ...b }));

  const outlineFindMany = vi.fn(
    async (args: {
      where: { id: { in: string[] }; status?: string };
    }) => {
      const ids = new Set(args.where.id.in);
      return outlinesStore
        .filter((r) => {
          if (!ids.has(r.id)) return false;
          if (args.where.status !== undefined && r.status !== args.where.status) {
            return false;
          }
          return true;
        })
        .map((r) => ({ id: r.id, book_id: r.book_id, status: r.status }));
    },
  );

  const outlineUpdate = vi.fn(
    async (args: {
      where: { id: string };
      data: { status?: string; approved_at?: Date | null; reject_note?: string | null };
    }) => {
      const row = outlinesStore.find((r) => r.id === args.where.id);
      if (!row) throw new Error(`outline not found: ${args.where.id}`);
      if (args.data.status !== undefined) row.status = args.data.status as OutlineRowStub['status'];
      if (args.data.approved_at !== undefined) row.approved_at = args.data.approved_at;
      if (args.data.reject_note !== undefined) row.reject_note = args.data.reject_note;
      return { id: row.id };
    },
  );

  const bookUpdate = vi.fn(
    async (args: { where: { id: string }; data: { status: string } }) => {
      const b = booksStore.find((r) => r.id === args.where.id);
      if (!b) throw new Error(`book not found: ${args.where.id}`);
      b.status = args.data.status;
      return { id: b.id };
    },
  );

  let jobIdCounter = 0;
  const jobCreate = vi.fn(
    opts.jobCreateImpl ??
      (async () => {
        jobIdCounter += 1;
        return { id: `job_${jobIdCounter}` };
      }),
  );

  const auditCreate = vi.fn(async () => ({}));
  const enqueue = vi.fn(opts.enqueueImpl ?? (async () => 'graphile_job_999'));

  const runTransaction: OutlinesDeps['runTransaction'] = async (fn) =>
    fn({
      outlineRepo: { findMany: outlineFindMany, update: outlineUpdate } as unknown as OutlinesDeps['outlineRepo'],
      bookRepo: { update: bookUpdate } as unknown as OutlinesDeps['bookRepo'],
      jobRepo: { create: jobCreate } as unknown as OutlinesDeps['jobRepo'],
      auditLogRepo: { create: auditCreate } as unknown as OutlinesDeps['auditLogRepo'],
    });

  return {
    deps: {
      outlineRepo: {
        findMany: outlineFindMany,
        update: outlineUpdate,
      } as unknown as OutlinesDeps['outlineRepo'],
      bookRepo: { update: bookUpdate } as unknown as OutlinesDeps['bookRepo'],
      jobRepo: { create: jobCreate } as unknown as OutlinesDeps['jobRepo'],
      auditLogRepo: { create: auditCreate } as unknown as OutlinesDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
      runTransaction,
      enqueueJob: enqueue,
      now: () => FROZEN_NOW,
    },
    spies: {
      outlineFindMany,
      outlineUpdate,
      bookUpdate,
      jobCreate,
      auditCreate,
      enqueue,
    },
    outlinesStore,
    booksStore,
  };
}

function outlineStub(
  id: string,
  status: OutlineRowStub['status'] = 'pending_review',
  overrides: Partial<OutlineRowStub> = {},
): OutlineRowStub {
  return {
    id,
    book_id: `book_${id}`,
    status,
    approved_at: null,
    reject_note: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// bulkApproveOutlinesCore — 入力検証
// ---------------------------------------------------------------------------

describe('bulkApproveOutlinesCore — input validation', () => {
  it('outline_ids 空配列で validation', async () => {
    const { deps, spies } = makeDeps({});
    const r = await bulkApproveOutlinesCore({ outline_ids: [] }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.outlineFindMany).not.toHaveBeenCalled();
  });

  it('outline_ids 101 件で validation', async () => {
    const { deps } = makeDeps({});
    const ids = Array.from({ length: 101 }, (_, i) => `o_${i}`);
    const r = await bulkApproveOutlinesCore({ outline_ids: ids }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('outline_ids が array でないで validation', async () => {
    const { deps } = makeDeps({});
    const r = await bulkApproveOutlinesCore({ outline_ids: 'o_1' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('outline_ids 要素が空文字で validation', async () => {
    const { deps } = makeDeps({});
    const r = await bulkApproveOutlinesCore({ outline_ids: [''] }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// bulkApproveOutlinesCore — happy path
// ---------------------------------------------------------------------------

describe('bulkApproveOutlinesCore — happy path', () => {
  it('pending_review 5 件 → approved 遷移 + Book.status=running + dispatch enqueue × 5', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => outlineStub(`o_${i}`));
    const { deps, spies, outlinesStore, booksStore } = makeDeps({ outlines: rows });

    const r = await bulkApproveOutlinesCore(
      { outline_ids: rows.map((r) => r.id) },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.approved).toBe(5);
      expect(r.data.enqueued_outline_ids.sort()).toEqual(rows.map((r) => r.id).sort());
      expect(r.data.failed_items).toEqual([]);
    }

    // Outline.status, approved_at
    for (const o of outlinesStore) {
      expect(o.status).toBe('approved');
      expect(o.approved_at).toEqual(FROZEN_NOW);
      expect(o.reject_note).toBeNull();
    }
    // Book.status='running'
    for (const b of booksStore) expect(b.status).toBe('running');

    // Job INSERT × 5
    expect(spies.jobCreate).toHaveBeenCalledTimes(5);
    const jobArgs = spies.jobCreate.mock.calls.map((c) => c[0] as { data: { kind: string; book_id: string; status: string; payload_json: Record<string, unknown> } });
    for (const a of jobArgs) {
      expect(a.data.kind).toBe(PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME);
      expect(a.data.status).toBe('queued');
      expect(a.data.payload_json.book_id).toBeTypeOf('string');
      expect(a.data.payload_json.outline_id).toBeTypeOf('string');
    }

    // enqueueJob × 5、payload に book_id / outline_id / job_id
    expect(spies.enqueue).toHaveBeenCalledTimes(5);
    const enqCalls = spies.enqueue.mock.calls;
    for (const [taskName, payload] of enqCalls as Array<[string, Record<string, unknown>]>) {
      expect(taskName).toBe(PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME);
      expect(payload.book_id).toBeTypeOf('string');
      expect(payload.outline_id).toBeTypeOf('string');
      expect(payload.job_id).toMatch(/^job_/);
    }

    // audit_log
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('outlines.bulk_approve');
    expect(auditArg.data.target_kind).toBe('outline');
    expect(auditArg.data.target_id).toBe('bulk');
    expect(auditArg.data.actor_id).toBe('u_1');
    const after = auditArg.data.after_json as { approved_count: number; jobs: unknown[] };
    expect(after.approved_count).toBe(5);
    expect(Array.isArray(after.jobs)).toBe(true);
    expect(after.jobs).toHaveLength(5);
  });

  it('approved 済み混在 → pending_review のみ更新、混在分は status_not_pending_review として failed_items に', async () => {
    const rows = [
      outlineStub('o_1', 'pending_review'),
      outlineStub('o_2', 'pending_review'),
      outlineStub('o_already', 'approved'),
      outlineStub('o_rejected', 'rejected'),
    ];
    const { deps, spies, outlinesStore } = makeDeps({ outlines: rows });

    const r = await bulkApproveOutlinesCore(
      { outline_ids: ['o_1', 'o_2', 'o_already', 'o_rejected', 'o_missing'] },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.approved).toBe(2);
      expect(r.data.enqueued_outline_ids.sort()).toEqual(['o_1', 'o_2']);
      const failedIds = r.data.failed_items.map((f) => f.outline_id).sort();
      expect(failedIds).toEqual(['o_already', 'o_missing', 'o_rejected']);
      for (const f of r.data.failed_items) {
        expect(f.reason).toBe('status_not_pending_review');
      }
    }
    // 既存 approved/rejected は変更されない
    expect(outlinesStore.find((r) => r.id === 'o_already')!.status).toBe('approved');
    expect(outlinesStore.find((r) => r.id === 'o_rejected')!.status).toBe('rejected');

    // jobCreate / enqueue は pending_review 2 件分のみ
    expect(spies.jobCreate).toHaveBeenCalledTimes(2);
    expect(spies.enqueue).toHaveBeenCalledTimes(2);
  });

  it('全件 approved 済み (eligible 0) で not_found / DB 触らない', async () => {
    const rows = [outlineStub('o_1', 'approved'), outlineStub('o_2', 'approved')];
    const { deps, spies } = makeDeps({ outlines: rows });
    const r = await bulkApproveOutlinesCore(
      { outline_ids: ['o_1', 'o_2'] },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
    expect(spies.outlineUpdate).not.toHaveBeenCalled();
    expect(spies.bookUpdate).not.toHaveBeenCalled();
    expect(spies.jobCreate).not.toHaveBeenCalled();
    expect(spies.enqueue).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bulkApproveOutlinesCore — partial enqueue failure
// ---------------------------------------------------------------------------

describe('bulkApproveOutlinesCore — enqueue failure', () => {
  it('enqueueJob が 1 件目だけ失敗 → DB 状態は確定 + failed_items.enqueue_failed', async () => {
    const rows = [outlineStub('o_1'), outlineStub('o_2')];
    let callCount = 0;
    const { deps, outlinesStore } = makeDeps({
      outlines: rows,
      enqueueImpl: async () => {
        callCount += 1;
        if (callCount === 1) throw new Error('graphile-worker down');
        return 'g_job_2';
      },
    });
    const r = await bulkApproveOutlinesCore(
      { outline_ids: ['o_1', 'o_2'] },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // DB は両方 approved に遷移済み (tx 内)
      expect(r.data.approved).toBe(2);
      // enqueue 成功は 1 件、失敗は failed_items.enqueue_failed
      expect(r.data.enqueued_outline_ids).toEqual(['o_2']);
      expect(r.data.failed_items).toHaveLength(1);
      expect(r.data.failed_items[0]!.reason).toBe('enqueue_failed');
      expect(r.data.failed_items[0]!.outline_id).toBe('o_1');
    }
    // outline status は両方 approved 済み (tx commit 済み)
    for (const o of outlinesStore) expect(o.status).toBe('approved');
  });

  it('jobRepo.create が throw すると tx 全体が unknown を返す / audit は走らない / enqueue 0', async () => {
    const rows = [outlineStub('o_1'), outlineStub('o_2')];
    const { deps, spies } = makeDeps({
      outlines: rows,
      jobCreateImpl: async () => {
        throw new Error('db boom');
      },
    });
    const r = await bulkApproveOutlinesCore(
      { outline_ids: ['o_1', 'o_2'] },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('unknown');
    expect(spies.enqueue).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bulkRejectOutlinesCore — 入力検証
// ---------------------------------------------------------------------------

describe('bulkRejectOutlinesCore — input validation', () => {
  it('items 空配列で validation', async () => {
    const { deps, spies } = makeDeps({});
    const r = await bulkRejectOutlinesCore({ items: [] }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.outlineFindMany).not.toHaveBeenCalled();
  });

  it('reject_note 空文字で validation', async () => {
    const { deps } = makeDeps({});
    const r = await bulkRejectOutlinesCore(
      { items: [{ outline_id: 'o_1', reject_note: '' }] },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('reject_note 2001 字で validation', async () => {
    const { deps } = makeDeps({});
    const long = 'あ'.repeat(2001);
    const r = await bulkRejectOutlinesCore(
      { items: [{ outline_id: 'o_1', reject_note: long }] },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('outline_id 重複で validation', async () => {
    const rows = [outlineStub('o_1')];
    const { deps, spies } = makeDeps({ outlines: rows });
    const r = await bulkRejectOutlinesCore(
      {
        items: [
          { outline_id: 'o_1', reject_note: 'comment A' },
          { outline_id: 'o_1', reject_note: 'comment B' },
        ],
      },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.jobCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bulkRejectOutlinesCore — happy path
// ---------------------------------------------------------------------------

describe('bulkRejectOutlinesCore — happy path', () => {
  it('pending_review 3 件 → rejected + reject_note 設定 + writer.outline 再 enqueue', async () => {
    const rows = [
      outlineStub('o_1'),
      outlineStub('o_2'),
      outlineStub('o_3'),
    ];
    const { deps, spies, outlinesStore } = makeDeps({ outlines: rows });

    const r = await bulkRejectOutlinesCore(
      {
        items: [
          { outline_id: 'o_1', reject_note: '第 1 章を抽象化' },
          { outline_id: 'o_2', reject_note: '構成を 8 章に圧縮' },
          { outline_id: 'o_3', reject_note: 'ターゲット読者を絞る' },
        ],
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.rejected).toBe(3);
      expect(r.data.enqueued_outline_ids.sort()).toEqual(['o_1', 'o_2', 'o_3']);
      expect(r.data.failed_items).toEqual([]);
    }

    // 各 outline に reject_note が保存され status=rejected
    for (const o of outlinesStore) {
      expect(o.status).toBe('rejected');
      expect(o.reject_note).not.toBeNull();
    }
    expect(outlinesStore.find((r) => r.id === 'o_1')!.reject_note).toBe('第 1 章を抽象化');
    expect(outlinesStore.find((r) => r.id === 'o_2')!.reject_note).toBe('構成を 8 章に圧縮');

    // Job INSERT × 3 (kind='pipeline.book.writer.outline'), payload.reject_note 一致
    expect(spies.jobCreate).toHaveBeenCalledTimes(3);
    const jobArgs = spies.jobCreate.mock.calls.map(
      (c) =>
        c[0] as {
          data: {
            kind: string;
            book_id: string;
            payload_json: { book_id: string; reject_note: string };
          };
        },
    );
    for (const a of jobArgs) {
      expect(a.data.kind).toBe(PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME);
      expect(a.data.payload_json.reject_note).toBeTypeOf('string');
      expect(a.data.payload_json.reject_note.length).toBeGreaterThan(0);
    }

    // enqueueJob × 3、payload.reject_note 一致
    expect(spies.enqueue).toHaveBeenCalledTimes(3);
    const noteByJobCall = new Map<string, string>();
    for (const [taskName, payload] of spies.enqueue.mock.calls as Array<
      [string, { book_id: string; reject_note: string; job_id: string }]
    >) {
      expect(taskName).toBe(PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME);
      expect(payload.book_id).toBeTypeOf('string');
      expect(payload.job_id).toMatch(/^job_/);
      noteByJobCall.set(payload.book_id, payload.reject_note);
    }
    expect(noteByJobCall.get('book_o_1')).toBe('第 1 章を抽象化');
    expect(noteByJobCall.get('book_o_2')).toBe('構成を 8 章に圧縮');
    expect(noteByJobCall.get('book_o_3')).toBe('ターゲット読者を絞る');

    // audit_log
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('outlines.bulk_reject');
    expect(auditArg.data.actor_id).toBe('u_1');
    const after = auditArg.data.after_json as { rejected_count: number; jobs: Array<{ reject_note_length: number }> };
    expect(after.rejected_count).toBe(3);
    expect(after.jobs).toHaveLength(3);
    // reject_note は監査 after_json に長さのみ
    for (const j of after.jobs) expect(j.reject_note_length).toBeGreaterThan(0);
  });

  it('pending_review + approved 混在 → pending_review のみ rejected 遷移、approved 分は failed_items', async () => {
    const rows = [outlineStub('o_pending'), outlineStub('o_approved', 'approved')];
    const { deps, spies, outlinesStore } = makeDeps({ outlines: rows });
    const r = await bulkRejectOutlinesCore(
      {
        items: [
          { outline_id: 'o_pending', reject_note: 'やり直し' },
          { outline_id: 'o_approved', reject_note: 'やり直し' },
        ],
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.rejected).toBe(1);
      expect(r.data.enqueued_outline_ids).toEqual(['o_pending']);
      expect(r.data.failed_items).toHaveLength(1);
      expect(r.data.failed_items[0]!.outline_id).toBe('o_approved');
      expect(r.data.failed_items[0]!.reason).toBe('status_not_pending_review');
    }
    expect(outlinesStore.find((r) => r.id === 'o_pending')!.status).toBe('rejected');
    expect(outlinesStore.find((r) => r.id === 'o_approved')!.status).toBe('approved');
    expect(spies.jobCreate).toHaveBeenCalledTimes(1);
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
  });

  it('全件 approved (eligible 0) → not_found / DB 触らない / audit 0', async () => {
    const rows = [outlineStub('o_1', 'approved')];
    const { deps, spies } = makeDeps({ outlines: rows });
    const r = await bulkRejectOutlinesCore(
      { items: [{ outline_id: 'o_1', reject_note: 'やり直し' }] },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
    expect(spies.jobCreate).not.toHaveBeenCalled();
    expect(spies.enqueue).not.toHaveBeenCalled();
    expect(spies.auditCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bulkRejectOutlinesCore — partial enqueue failure
// ---------------------------------------------------------------------------

describe('bulkRejectOutlinesCore — enqueue failure', () => {
  it('enqueueJob 失敗 → DB 状態は確定 + failed_items.enqueue_failed', async () => {
    const rows = [outlineStub('o_1'), outlineStub('o_2')];
    let callCount = 0;
    const { deps, outlinesStore } = makeDeps({
      outlines: rows,
      enqueueImpl: async () => {
        callCount += 1;
        if (callCount === 2) throw new Error('graphile-worker down');
        return 'g_job_1';
      },
    });
    const r = await bulkRejectOutlinesCore(
      {
        items: [
          { outline_id: 'o_1', reject_note: 'やり直し A' },
          { outline_id: 'o_2', reject_note: 'やり直し B' },
        ],
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.rejected).toBe(2);
      expect(r.data.enqueued_outline_ids).toEqual(['o_1']);
      expect(r.data.failed_items).toHaveLength(1);
      expect(r.data.failed_items[0]!.outline_id).toBe('o_2');
      expect(r.data.failed_items[0]!.reason).toBe('enqueue_failed');
    }
    for (const o of outlinesStore) expect(o.status).toBe('rejected');
  });
});

// Prisma import 警告抑止 (型チェッカ用、未使用判定対策)
void Prisma;
