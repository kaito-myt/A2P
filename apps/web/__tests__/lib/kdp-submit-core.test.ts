/**
 * kdp-submit-core.ts unit tests (T-08-09, F-041).
 *
 * Checks:
 *  1. validation (book_ids 空/超過/型不正)
 *  2. submitToKdpCore — 入稿可能な書籍はキューに登録される
 *  3. submitToKdpCore — 各ブロック条件 (must コメント残 / 出版済み / 状態不可 / メタデータ未生成 / 存在しない)
 *  4. submitToKdpCore — queued/blocked 混在時も正しく分類される
 *  5. submitToKdpCore — audit_log を記録する (queue 成功時・全滅時とも)
 *  6. unqueueFromKdpCore — キュー解除 + audit_log
 */
import { describe, expect, it, vi } from 'vitest';
import { isFail, isOk } from '@a2p/contracts';

import {
  submitToKdpCore,
  unqueueFromKdpCore,
  submitToKdpInputSchema,
  type KdpSubmitDeps,
  type KdpSubmitBookRow,
} from '../../lib/kdp-submit-core';

const FROZEN_NOW = new Date('2026-07-24T03:00:00.000Z');

function makeBook(overrides: Partial<KdpSubmitBookRow> = {}): KdpSubmitBookRow {
  return {
    id: 'book_1',
    status: 'done',
    publish_status: 'unlisted',
    kdpMetadata: { id: 'meta_1' },
    ...overrides,
  };
}

function makeDeps(opts: {
  books?: KdpSubmitBookRow[];
  blockingBookIds?: string[];
} = {}): {
  deps: KdpSubmitDeps;
  spies: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    revisionFindMany: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
  };
} {
  const books = opts.books ?? [makeBook()];
  const blockingBookIds = opts.blockingBookIds ?? [];

  const findMany = vi.fn(async () => books);
  const updateMany = vi.fn(async () => ({ count: books.length }));
  const revisionFindMany = vi.fn(async () => blockingBookIds.map((book_id) => ({ book_id })));
  const auditCreate = vi.fn(async () => ({}));

  return {
    deps: {
      bookRepo: { findMany, updateMany },
      revisionCommentRepo: { findMany: revisionFindMany },
      auditLogRepo: { create: auditCreate },
      session: { user: { id: 'u_1', username: 'operator' } },
      now: () => FROZEN_NOW,
    },
    spies: { findMany, updateMany, revisionFindMany, auditCreate },
  };
}

// ---------------------------------------------------------------------------
// Test 1: validation
// ---------------------------------------------------------------------------

describe('submitToKdpInputSchema', () => {
  it('book_ids 1..20 件を受け付ける', () => {
    expect(submitToKdpInputSchema.safeParse({ book_ids: ['a'] }).success).toBe(true);
    expect(submitToKdpInputSchema.safeParse({ book_ids: [] }).success).toBe(false);
    expect(
      submitToKdpInputSchema.safeParse({ book_ids: Array.from({ length: 21 }, (_, i) => `b${i}`) })
        .success,
    ).toBe(false);
  });
});

describe('submitToKdpCore — validation', () => {
  it('book_ids が空のとき validation fail', async () => {
    const { deps } = makeDeps();
    const result = await submitToKdpCore({ book_ids: [] }, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('null 入力のとき validation fail', async () => {
    const { deps } = makeDeps();
    const result = await submitToKdpCore(null, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Test 2: queue success
// ---------------------------------------------------------------------------

describe('submitToKdpCore — queue', () => {
  it('入稿可能な書籍を kdp_publish_queued=true でキューに登録する', async () => {
    const { deps, spies } = makeDeps();
    const result = await submitToKdpCore({ book_ids: ['book_1'] }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.queued).toEqual([{ book_id: 'book_1' }]);
      expect(result.data.blocked).toHaveLength(0);
    }
    expect(spies.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['book_1'] } },
      data: { kdp_publish_queued: true, kdp_publish_queued_at: FROZEN_NOW },
    });
  });

  it('needs_human_review でもキューに登録できる', async () => {
    const { deps } = makeDeps({ books: [makeBook({ status: 'needs_human_review' })] });
    const result = await submitToKdpCore({ book_ids: ['book_1'] }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.data.queued).toEqual([{ book_id: 'book_1' }]);
  });
});

// ---------------------------------------------------------------------------
// Test 3: blocked conditions
// ---------------------------------------------------------------------------

describe('submitToKdpCore — blocked', () => {
  it('must コメントが残っている書籍は blocked', async () => {
    const { deps, spies } = makeDeps({ blockingBookIds: ['book_1'] });
    const result = await submitToKdpCore({ book_ids: ['book_1'] }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.queued).toHaveLength(0);
      expect(result.data.blocked).toEqual([{ book_id: 'book_1', reason: expect.any(String) }]);
    }
    expect(spies.updateMany).not.toHaveBeenCalled();
  });

  it('publish_status=published の書籍は blocked', async () => {
    const { deps } = makeDeps({ books: [makeBook({ publish_status: 'published' })] });
    const result = await submitToKdpCore({ book_ids: ['book_1'] }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.data.blocked).toHaveLength(1);
  });

  it('status が done/needs_human_review 以外は blocked', async () => {
    const { deps } = makeDeps({ books: [makeBook({ status: 'running' })] });
    const result = await submitToKdpCore({ book_ids: ['book_1'] }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.data.blocked).toHaveLength(1);
  });

  it('kdpMetadata が null の書籍は blocked', async () => {
    const { deps } = makeDeps({ books: [makeBook({ kdpMetadata: null })] });
    const result = await submitToKdpCore({ book_ids: ['book_1'] }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.data.blocked).toHaveLength(1);
  });

  it('存在しない book_id は blocked', async () => {
    const { deps } = makeDeps({ books: [] });
    const result = await submitToKdpCore({ book_ids: ['book_missing'] }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.blocked).toEqual([{ book_id: 'book_missing', reason: expect.any(String) }]);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: mixed queued/blocked
// ---------------------------------------------------------------------------

describe('submitToKdpCore — mixed', () => {
  it('複数書籍のうち一部だけ queued、残りは blocked に分類される', async () => {
    const { deps, spies } = makeDeps({
      books: [makeBook({ id: 'book_1' }), makeBook({ id: 'book_2', kdpMetadata: null })],
    });
    const result = await submitToKdpCore({ book_ids: ['book_1', 'book_2'] }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.queued).toEqual([{ book_id: 'book_1' }]);
      expect(result.data.blocked).toEqual([{ book_id: 'book_2', reason: expect.any(String) }]);
    }
    expect(spies.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['book_1'] } },
      data: expect.objectContaining({ kdp_publish_queued: true }),
    });
  });
});

// ---------------------------------------------------------------------------
// Test 5: audit log
// ---------------------------------------------------------------------------

describe('submitToKdpCore — audit log', () => {
  it('成功時に kdp.queue の audit_log を記録する', async () => {
    const { deps, spies } = makeDeps();
    await submitToKdpCore({ book_ids: ['book_1'] }, deps);
    expect(spies.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor_id: 'u_1',
        action: 'kdp.queue',
        target_kind: 'book',
      }),
    });
  });

  it('全件 blocked のときも audit_log を記録する', async () => {
    const { deps, spies } = makeDeps({ blockingBookIds: ['book_1'] });
    await submitToKdpCore({ book_ids: ['book_1'] }, deps);
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test 6: unqueueFromKdpCore
// ---------------------------------------------------------------------------

describe('unqueueFromKdpCore', () => {
  it('不正入力は validation fail', async () => {
    const { deps } = makeDeps();
    const result = await unqueueFromKdpCore({ book_ids: [] }, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('kdp_publish_queued=false でキューから外す', async () => {
    const { deps, spies } = makeDeps();
    const result = await unqueueFromKdpCore({ book_ids: ['book_1'] }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.data.unqueued).toEqual([{ book_id: 'book_1' }]);
    expect(spies.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['book_1'] } },
      data: { kdp_publish_queued: false, kdp_publish_queued_at: null },
    });
    expect(spies.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'kdp.unqueue' }),
      }),
    );
  });
});
