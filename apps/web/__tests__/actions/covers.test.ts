/**
 * covers-core.ts のユニットテスト (T-05-09, F-019).
 *
 * 検証:
 *  - bulkAdoptCovers:
 *    - 入力 zod (空配列 / 上限超過)
 *    - 5 件一括採用: generated のみ更新 / status_not_generated を failed_items に収集
 *    - Cover.status='adopted' + 同 book の他 Cover は rejected
 *    - Job(kind='pipeline.book.export') INSERT (per book) + enqueueJob 呼出
 *    - audit_log 1 件 (action='covers.bulk_adopt')
 *    - enqueue 失敗時に failed_items.enqueue_failed を返す (部分成功)
 *  - regenerateCover:
 *    - job_id 返却
 *    - book 未存在で not_found
 *  - regenerateCoverText:
 *    - job_id 返却
 *    - book 未存在で not_found
 */
import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  bulkAdoptCoversCore,
  regenerateCoverCore,
  regenerateCoverTextCore,
  PIPELINE_BOOK_EXPORT_TASK_NAME,
  PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
  PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
  type CoversDeps,
  type CoverRow,
} from '../../lib/covers-core';

const FROZEN_NOW = new Date('2026-05-25T10:00:00.000Z');

function makeDeps(opts: {
  covers?: CoverRow[];
  bookExists?: boolean;
  enqueueImpl?: (taskName: string, payload: unknown) => Promise<string>;
}): {
  deps: CoversDeps;
  spies: {
    coverFindMany: ReturnType<typeof vi.fn>;
    coverUpdate: ReturnType<typeof vi.fn>;
    coverUpdateMany: ReturnType<typeof vi.fn>;
    bookFindUnique: ReturnType<typeof vi.fn>;
    jobCreate: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };
  coversStore: CoverRow[];
} {
  const coversStore: CoverRow[] = (opts.covers ?? []).map((r) => ({ ...r }));

  const coverFindMany = vi.fn(
    async (args: {
      where: { id?: { in: string[] }; book_id?: string; status?: string };
    }) => {
      return coversStore.filter((r) => {
        if (args.where.id && !args.where.id.in.includes(r.id)) return false;
        if (args.where.book_id !== undefined && r.book_id !== args.where.book_id) return false;
        if (args.where.status !== undefined && r.status !== args.where.status) return false;
        return true;
      }).map((r) => ({ id: r.id, book_id: r.book_id, status: r.status }));
    },
  );

  const coverUpdate = vi.fn(
    async (args: { where: { id: string }; data: { status: string } }) => {
      const row = coversStore.find((r) => r.id === args.where.id);
      if (row) row.status = args.data.status;
      return { id: args.where.id };
    },
  );

  const coverUpdateMany = vi.fn(
    async (args: {
      where: { book_id: string; id: { notIn: string[] }; status?: { not: string } };
      data: { status: string };
    }) => {
      let count = 0;
      const notIn = new Set(args.where.id.notIn);
      for (const r of coversStore) {
        if (r.book_id !== args.where.book_id) continue;
        if (notIn.has(r.id)) continue;
        if (args.where.status?.not && r.status === args.where.status.not) continue;
        r.status = args.data.status;
        count++;
      }
      return { count };
    },
  );

  const bookFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    if (opts.bookExists === false) return null;
    return { id: args.where.id };
  });

  let jobIdCounter = 0;
  const jobCreate = vi.fn(async () => {
    jobIdCounter += 1;
    return { id: `job_${jobIdCounter}` };
  });

  const auditCreate = vi.fn(async () => ({}));
  const enqueue = vi.fn(opts.enqueueImpl ?? (async () => 'graphile_job_999'));

  const runTransaction: CoversDeps['runTransaction'] = async (fn) =>
    fn({
      coverRepo: {
        findMany: coverFindMany,
        update: coverUpdate,
        updateMany: coverUpdateMany,
      } as unknown as CoversDeps['coverRepo'],
      jobRepo: { create: jobCreate } as unknown as CoversDeps['jobRepo'],
      auditLogRepo: { create: auditCreate } as unknown as CoversDeps['auditLogRepo'],
    });

  return {
    deps: {
      coverRepo: {
        findMany: coverFindMany,
        update: coverUpdate,
        updateMany: coverUpdateMany,
      } as unknown as CoversDeps['coverRepo'],
      bookRepo: { findUnique: bookFindUnique } as unknown as CoversDeps['bookRepo'],
      jobRepo: { create: jobCreate } as unknown as CoversDeps['jobRepo'],
      auditLogRepo: { create: auditCreate } as unknown as CoversDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
      runTransaction,
      enqueueJob: enqueue,
      now: () => FROZEN_NOW,
    },
    spies: {
      coverFindMany,
      coverUpdate,
      coverUpdateMany,
      bookFindUnique,
      jobCreate,
      auditCreate,
      enqueue,
    },
    coversStore,
  };
}

function coverStub(id: string, bookId: string, status = 'generated'): CoverRow {
  return { id, book_id: bookId, status };
}

// ---------------------------------------------------------------------------
// bulkAdoptCoversCore - input validation
// ---------------------------------------------------------------------------

describe('bulkAdoptCoversCore - input validation', () => {
  it('cover_ids empty array fails validation', async () => {
    const { deps, spies } = makeDeps({});
    const r = await bulkAdoptCoversCore({ cover_ids: [] }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
    expect(spies.coverFindMany).not.toHaveBeenCalled();
  });

  it('cover_ids 101 items fails validation', async () => {
    const { deps } = makeDeps({});
    const ids = Array.from({ length: 101 }, (_, i) => `c_${i}`);
    const r = await bulkAdoptCoversCore({ cover_ids: ids }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('missing cover_ids fails validation', async () => {
    const { deps } = makeDeps({});
    const r = await bulkAdoptCoversCore({}, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// bulkAdoptCoversCore - 5 items bulk adopt
// ---------------------------------------------------------------------------

describe('bulkAdoptCoversCore - 5 items bulk adopt', () => {
  it('adopts 5 covers across 2 books, rejects others, enqueues export per book', async () => {
    const covers = [
      // Book A: 3 generated covers, adopt 2
      coverStub('c_1', 'book_A'),
      coverStub('c_2', 'book_A'),
      coverStub('c_3', 'book_A'),
      // Book B: 4 generated covers, adopt 3
      coverStub('c_4', 'book_B'),
      coverStub('c_5', 'book_B'),
      coverStub('c_6', 'book_B'),
      coverStub('c_7', 'book_B'),
    ];

    const { deps, spies, coversStore } = makeDeps({ covers });
    const adoptIds = ['c_1', 'c_2', 'c_4', 'c_5', 'c_6'];
    const r = await bulkAdoptCoversCore({ cover_ids: adoptIds }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.data.adopted).toBe(5);
    expect(r.data.enqueued_book_ids).toHaveLength(2);
    expect(r.data.enqueued_book_ids).toContain('book_A');
    expect(r.data.enqueued_book_ids).toContain('book_B');
    expect(r.data.failed_items).toHaveLength(0);

    // Verify cover statuses in store
    const adopted = coversStore.filter((c) => c.status === 'adopted');
    expect(adopted.map((c) => c.id).sort()).toEqual(['c_1', 'c_2', 'c_4', 'c_5', 'c_6']);

    const rejected = coversStore.filter((c) => c.status === 'rejected');
    expect(rejected.map((c) => c.id).sort()).toEqual(['c_3', 'c_7']);

    // Verify coverUpdate called 5 times (one per adopted cover)
    expect(spies.coverUpdate).toHaveBeenCalledTimes(5);

    // Verify coverUpdateMany called 2 times (once per book)
    expect(spies.coverUpdateMany).toHaveBeenCalledTimes(2);

    // Verify export Job created per book (2 books)
    expect(spies.jobCreate).toHaveBeenCalledTimes(2);

    // Verify enqueue called per book (2 books)
    expect(spies.enqueue).toHaveBeenCalledTimes(2);
    for (const call of spies.enqueue.mock.calls) {
      expect(call[0]).toBe(PIPELINE_BOOK_EXPORT_TASK_NAME);
    }

    // Verify audit_log 1 call
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]![0];
    expect(auditArg.data.action).toBe('covers.bulk_adopt');
    expect(auditArg.data.target_kind).toBe('cover');
  });

  it('collects failed_items for non-generated covers', async () => {
    const covers = [
      coverStub('c_1', 'book_A'),
      { id: 'c_2', book_id: 'book_A', status: 'adopted' }, // already adopted
    ];

    const { deps } = makeDeps({ covers });
    const r = await bulkAdoptCoversCore({ cover_ids: ['c_1', 'c_2'] }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.data.adopted).toBe(1);
    expect(r.data.failed_items).toHaveLength(1);
    expect(r.data.failed_items[0]!.cover_id).toBe('c_2');
    expect(r.data.failed_items[0]!.reason).toBe('status_not_generated');
  });

  it('returns not_found when all covers are not eligible', async () => {
    const covers = [
      { id: 'c_1', book_id: 'book_A', status: 'adopted' },
    ];

    const { deps } = makeDeps({ covers });
    const r = await bulkAdoptCoversCore({ cover_ids: ['c_1'] }, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });

  it('collects enqueue failure as partial success', async () => {
    const covers = [coverStub('c_1', 'book_A')];
    const { deps } = makeDeps({
      covers,
      enqueueImpl: async () => {
        throw new Error('connection refused');
      },
    });

    const r = await bulkAdoptCoversCore({ cover_ids: ['c_1'] }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.data.adopted).toBe(1);
    expect(r.data.enqueued_book_ids).toHaveLength(0);
    expect(r.data.failed_items).toHaveLength(1);
    expect(r.data.failed_items[0]!.cover_id).toBe('c_1');
    expect(r.data.failed_items[0]!.reason).toBe('enqueue_failed');
  });
});

// ---------------------------------------------------------------------------
// regenerateCoverCore
// ---------------------------------------------------------------------------

describe('regenerateCoverCore', () => {
  it('returns job_id on success', async () => {
    const { deps, spies } = makeDeps({ bookExists: true });
    const r = await regenerateCoverCore({ book_id: 'book_1' }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.data.job_id).toBe('job_1');
    expect(spies.jobCreate).toHaveBeenCalledTimes(1);
    const jobArg = spies.jobCreate.mock.calls[0]![0];
    expect(jobArg.data.kind).toBe(PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME);

    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    expect(spies.enqueue.mock.calls[0]![0]).toBe(PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME);

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    expect(spies.auditCreate.mock.calls[0]![0].data.action).toBe('covers.regenerate_image');
  });

  it('passes count and style_tweak to payload', async () => {
    const { deps, spies } = makeDeps({ bookExists: true });
    const r = await regenerateCoverCore(
      { book_id: 'book_1', count: 5, style_tweak: 'dark theme' },
      deps,
    );

    expect(isOk(r)).toBe(true);
    const enqueuePayload = spies.enqueue.mock.calls[0]![1] as Record<string, unknown>;
    expect(enqueuePayload.count).toBe(5);
    expect(enqueuePayload.style_tweak).toBe('dark theme');
  });

  it('defaults count to 3', async () => {
    const { deps, spies } = makeDeps({ bookExists: true });
    await regenerateCoverCore({ book_id: 'book_1' }, deps);

    const jobArg = spies.jobCreate.mock.calls[0]![0];
    const payload = jobArg.data.payload_json as Record<string, unknown>;
    expect(payload.count).toBe(3);
  });

  it('returns not_found when book does not exist', async () => {
    const { deps } = makeDeps({ bookExists: false });
    const r = await regenerateCoverCore({ book_id: 'no_book' }, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });

  it('fails validation for missing book_id', async () => {
    const { deps } = makeDeps({});
    const r = await regenerateCoverCore({}, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('returns validation error when enqueue fails', async () => {
    const { deps } = makeDeps({
      bookExists: true,
      enqueueImpl: async () => {
        throw new Error('queue down');
      },
    });
    const r = await regenerateCoverCore({ book_id: 'book_1' }, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// regenerateCoverTextCore
// ---------------------------------------------------------------------------

describe('regenerateCoverTextCore', () => {
  it('returns job_id on success', async () => {
    const { deps, spies } = makeDeps({ bookExists: true });
    const r = await regenerateCoverTextCore({ book_id: 'book_1' }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.data.job_id).toBe('job_1');
    expect(spies.jobCreate).toHaveBeenCalledTimes(1);
    const jobArg = spies.jobCreate.mock.calls[0]![0];
    expect(jobArg.data.kind).toBe(PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME);

    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    expect(spies.enqueue.mock.calls[0]![0]).toBe(PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME);

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    expect(spies.auditCreate.mock.calls[0]![0].data.action).toBe('covers.regenerate_text');
  });

  it('returns not_found when book does not exist', async () => {
    const { deps } = makeDeps({ bookExists: false });
    const r = await regenerateCoverTextCore({ book_id: 'no_book' }, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });

  it('fails validation for missing book_id', async () => {
    const { deps } = makeDeps({});
    const r = await regenerateCoverTextCore({}, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('returns validation error when enqueue fails', async () => {
    const { deps } = makeDeps({
      bookExists: true,
      enqueueImpl: async () => {
        throw new Error('queue down');
      },
    });
    const r = await regenerateCoverTextCore({ book_id: 'book_1' }, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});
