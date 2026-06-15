/**
 * rollbackRevisionRunCore のユニットテスト (T-06-11, F-050).
 *
 * 検証:
 *  - 章ロールバックで version 連番が正しい
 *  - コメントが pending に戻る
 *  - Book フラグが再計算される
 *  - 部分ロールバック (comment_ids 指定)
 *  - 非章コメント (cover, metadata 等) は Phase 1 placeholder (status reset のみ)
 *  - applied 以外のコメントは対象外
 *  - zod バリデーション
 */
import { describe, expect, it, vi } from 'vitest';

import { isFail, isOk } from '@a2p/contracts';

import {
  rollbackRevisionRunCore,
  type RollbackRevisionRunDeps,
  type RollbackCommentRow,
  type ChapterRevisionRow,
  type ChapterRow,
} from '../../lib/revision-runs-core';

const FROZEN_NOW = new Date('2026-05-25T10:00:00.000Z');

interface MakeDepsOpts {
  comments?: RollbackCommentRow[];
  chapters?: Map<string, ChapterRow>;
  revisions?: ChapterRevisionRow[];
  pendingCounts?: Map<string, number>;
  mustPendingCounts?: Map<string, number>;
}

function makeDeps(opts: MakeDepsOpts) {
  const commentsStore = (opts.comments ?? []).map((c) => ({ ...c }));
  const chaptersMap = opts.chapters ?? new Map<string, ChapterRow>();
  const revisionsStore = (opts.revisions ?? []).map((r) => ({ ...r }));
  const pendingCounts = opts.pendingCounts ?? new Map<string, number>();
  const mustPendingCounts = opts.mustPendingCounts ?? new Map<string, number>();

  const commentFindMany = vi.fn(
    async (args: {
      where: {
        run_id: string;
        id?: { in: string[] };
        status: string;
      };
    }) => {
      return commentsStore.filter((c) => {
        if (args.where.status !== undefined && c.status !== args.where.status)
          return false;
        if (args.where.id && !args.where.id.in.includes(c.id)) return false;
        return true;
      });
    },
  );

  const commentUpdateMany = vi.fn(async (args: {
    where: { id: { in: string[] } };
    data: { status: string; applied_at: null };
  }) => {
    for (const c of commentsStore) {
      if (args.where.id.in.includes(c.id)) {
        c.status = args.data.status;
      }
    }
    return { count: args.where.id.in.length };
  });

  const commentCount = vi.fn(
    async (args: {
      where: { book_id: string; status: string; priority?: string };
    }) => {
      if (args.where.priority === 'must') {
        return mustPendingCounts.get(args.where.book_id) ?? 0;
      }
      return pendingCounts.get(args.where.book_id) ?? 0;
    },
  );

  const chapterFindUnique = vi.fn(
    async (args: { where: { id: string } }) => {
      return chaptersMap.get(args.where.id) ?? null;
    },
  );

  const chapterUpdate = vi.fn(
    async (args: {
      where: { id: string };
      data: { body_md: string; version: number; char_count: number };
    }) => {
      const ch = chaptersMap.get(args.where.id);
      if (ch) {
        ch.body_md = args.data.body_md;
        ch.version = args.data.version;
      }
      return { id: args.where.id };
    },
  );

  const chapterRevisionFindFirst = vi.fn(
    async (args: {
      where: { chapter_id: string; version: { lt: number } };
    }) => {
      const matching = revisionsStore
        .filter(
          (r) =>
            r.chapter_id === args.where.chapter_id &&
            r.version < args.where.version.lt,
        )
        .sort((a, b) => b.version - a.version);
      return matching[0] ?? null;
    },
  );

  let revisionIdCounter = 0;
  const chapterRevisionCreate = vi.fn(async () => {
    revisionIdCounter++;
    return { id: `rev-${revisionIdCounter}` };
  });

  const bookUpdate = vi.fn(async (args: {
    where: { id: string };
    data: { has_pending_comments: boolean; has_blocking_comments: boolean };
  }) => {
    return { id: args.where.id };
  });

  const auditCreate = vi.fn(async () => ({}));

  const deps: RollbackRevisionRunDeps = {
    commentRepo: {
      findMany: commentFindMany,
      updateMany: commentUpdateMany,
      count: commentCount,
    },
    chapterRevisionRepo: {
      findFirst: chapterRevisionFindFirst,
      create: chapterRevisionCreate,
    },
    chapterRepo: {
      findUnique: chapterFindUnique,
      update: chapterUpdate,
    },
    bookRepo: {
      update: bookUpdate,
    },
    auditLogRepo: {
      create: auditCreate,
    },
    runTransaction: async (fn) =>
      fn({
        commentRepo: {
          findMany: commentFindMany,
          updateMany: commentUpdateMany,
          count: commentCount,
        },
        chapterRevisionRepo: {
          findFirst: chapterRevisionFindFirst,
          create: chapterRevisionCreate,
        },
        chapterRepo: {
          findUnique: chapterFindUnique,
          update: chapterUpdate,
        },
        bookRepo: {
          update: bookUpdate,
        },
        auditLogRepo: {
          create: auditCreate,
        },
      }),
    session: { user: { id: 'user-1', username: 'admin' } },
    now: () => FROZEN_NOW,
  };

  return {
    deps,
    spies: {
      commentFindMany,
      commentUpdateMany,
      commentCount,
      chapterFindUnique,
      chapterUpdate,
      chapterRevisionFindFirst,
      chapterRevisionCreate,
      bookUpdate,
      auditCreate,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rollbackRevisionRunCore', () => {
  // --- zod validation ---

  it('rejects missing revision_run_id', async () => {
    const { deps } = makeDeps({});
    const result = await rollbackRevisionRunCore({}, deps);
    expect(isFail(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
  });

  it('rejects empty revision_run_id', async () => {
    const { deps } = makeDeps({});
    const result = await rollbackRevisionRunCore(
      { revision_run_id: '' },
      deps,
    );
    expect(isFail(result)).toBe(true);
  });

  // --- no applied comments ---

  it('returns not_found when no applied comments exist', async () => {
    const comments: RollbackCommentRow[] = [
      {
        id: 'c1',
        book_id: 'book-A',
        target_kind: 'chapter',
        target_id: 'ch-1',
        status: 'pending',
        priority: 'must',
      },
    ];
    const { deps } = makeDeps({ comments });
    const result = await rollbackRevisionRunCore(
      { revision_run_id: 'run-1' },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });

  // --- chapter rollback: version sequence ---

  it('restores chapter body and increments version correctly', async () => {
    const comments: RollbackCommentRow[] = [
      {
        id: 'c1',
        book_id: 'book-A',
        target_kind: 'chapter',
        target_id: 'ch-1',
        status: 'applied',
        priority: 'should',
      },
    ];
    const chaptersMap = new Map<string, ChapterRow>();
    chaptersMap.set('ch-1', {
      id: 'ch-1',
      book_id: 'book-A',
      version: 3,
      body_md: 'current body v3',
    });

    const revisions: ChapterRevisionRow[] = [
      { id: 'rev-old-1', chapter_id: 'ch-1', version: 1, body_md: 'v1 body' },
      { id: 'rev-old-2', chapter_id: 'ch-1', version: 2, body_md: 'v2 body' },
    ];

    const pendingCounts = new Map([['book-A', 1]]);

    const { deps, spies } = makeDeps({
      comments,
      chapters: chaptersMap,
      revisions,
      pendingCounts,
    });
    const result = await rollbackRevisionRunCore(
      { revision_run_id: 'run-1' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.data.restored).toBe(1);
    }

    // Should save current body as revision before overwriting
    expect(spies.chapterRevisionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chapter_id: 'ch-1',
          book_id: 'book-A',
          version: 3,
          body_md: 'current body v3',
          reason: 'rollback:run-1',
        }),
      }),
    );

    // Chapter should be updated with v2 body and version=4
    expect(spies.chapterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ch-1' },
        data: expect.objectContaining({
          body_md: 'v2 body',
          version: 4,
          char_count: 'v2 body'.length,
        }),
      }),
    );
  });

  // --- comments reset to pending ---

  it('resets applied comments to pending with applied_at=null', async () => {
    const comments: RollbackCommentRow[] = [
      {
        id: 'c1',
        book_id: 'book-A',
        target_kind: 'chapter',
        target_id: 'ch-1',
        status: 'applied',
        priority: 'should',
      },
      {
        id: 'c2',
        book_id: 'book-A',
        target_kind: 'cover',
        target_id: 'cov-1',
        status: 'applied',
        priority: 'may',
      },
    ];
    const chaptersMap = new Map<string, ChapterRow>();
    chaptersMap.set('ch-1', {
      id: 'ch-1',
      book_id: 'book-A',
      version: 2,
      body_md: 'body v2',
    });

    const revisions: ChapterRevisionRow[] = [
      { id: 'rev-1', chapter_id: 'ch-1', version: 1, body_md: 'body v1' },
    ];

    const pendingCounts = new Map([['book-A', 2]]);

    const { deps, spies } = makeDeps({
      comments,
      chapters: chaptersMap,
      revisions,
      pendingCounts,
    });
    const result = await rollbackRevisionRunCore(
      { revision_run_id: 'run-1' },
      deps,
    );

    expect(isOk(result)).toBe(true);

    expect(spies.commentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['c1', 'c2'] } },
        data: { status: 'pending', applied_at: null },
      }),
    );
  });

  // --- book flag recalculation ---

  it('recalculates has_pending_comments and has_blocking_comments', async () => {
    const comments: RollbackCommentRow[] = [
      {
        id: 'c1',
        book_id: 'book-A',
        target_kind: 'cover',
        target_id: 'cov-1',
        status: 'applied',
        priority: 'must',
      },
    ];

    const pendingCounts = new Map([['book-A', 1]]);
    const mustPendingCounts = new Map([['book-A', 1]]);

    const { deps, spies } = makeDeps({
      comments,
      pendingCounts,
      mustPendingCounts,
    });
    const result = await rollbackRevisionRunCore(
      { revision_run_id: 'run-1' },
      deps,
    );

    expect(isOk(result)).toBe(true);

    expect(spies.bookUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'book-A' },
        data: {
          has_pending_comments: true,
          has_blocking_comments: true,
        },
      }),
    );
  });

  it('sets book flags to false when no pending comments remain', async () => {
    const comments: RollbackCommentRow[] = [
      {
        id: 'c1',
        book_id: 'book-A',
        target_kind: 'cover',
        target_id: 'cov-1',
        status: 'applied',
        priority: 'may',
      },
    ];

    const pendingCounts = new Map([['book-A', 0]]);
    const mustPendingCounts = new Map([['book-A', 0]]);

    const { deps, spies } = makeDeps({
      comments,
      pendingCounts,
      mustPendingCounts,
    });
    const result = await rollbackRevisionRunCore(
      { revision_run_id: 'run-1' },
      deps,
    );

    expect(isOk(result)).toBe(true);

    expect(spies.bookUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'book-A' },
        data: {
          has_pending_comments: false,
          has_blocking_comments: false,
        },
      }),
    );
  });

  // --- partial rollback (comment_ids specified) ---

  it('only rolls back specified comment_ids when provided', async () => {
    const comments: RollbackCommentRow[] = [
      {
        id: 'c1',
        book_id: 'book-A',
        target_kind: 'chapter',
        target_id: 'ch-1',
        status: 'applied',
        priority: 'should',
      },
      {
        id: 'c2',
        book_id: 'book-A',
        target_kind: 'chapter',
        target_id: 'ch-2',
        status: 'applied',
        priority: 'must',
      },
      {
        id: 'c3',
        book_id: 'book-B',
        target_kind: 'cover',
        target_id: 'cov-1',
        status: 'applied',
        priority: 'may',
      },
    ];

    const chaptersMap = new Map<string, ChapterRow>();
    chaptersMap.set('ch-1', {
      id: 'ch-1',
      book_id: 'book-A',
      version: 2,
      body_md: 'current ch1',
    });

    const revisions: ChapterRevisionRow[] = [
      { id: 'rev-1', chapter_id: 'ch-1', version: 1, body_md: 'old ch1' },
    ];

    const pendingCounts = new Map([['book-A', 1]]);

    const { deps, spies } = makeDeps({
      comments,
      chapters: chaptersMap,
      revisions,
      pendingCounts,
    });

    const result = await rollbackRevisionRunCore(
      { revision_run_id: 'run-1', comment_ids: ['c1'] },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.data.restored).toBe(1);
    }

    // Only c1 should be reset
    expect(spies.commentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['c1'] } },
        data: { status: 'pending', applied_at: null },
      }),
    );

    // Only ch-1 should be restored (c2 for ch-2 not included)
    expect(spies.chapterUpdate).toHaveBeenCalledTimes(1);
    expect(spies.chapterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ch-1' },
      }),
    );

    // Only book-A flags recalculated (c3 for book-B not included)
    expect(spies.bookUpdate).toHaveBeenCalledTimes(1);
    expect(spies.bookUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'book-A' },
      }),
    );
  });

  // --- non-chapter comments (Phase 1 placeholder) ---

  it('handles non-chapter comments by resetting status only', async () => {
    const comments: RollbackCommentRow[] = [
      {
        id: 'c1',
        book_id: 'book-A',
        target_kind: 'cover',
        target_id: 'cov-1',
        status: 'applied',
        priority: 'should',
      },
      {
        id: 'c2',
        book_id: 'book-A',
        target_kind: 'metadata',
        target_id: 'meta-1',
        status: 'applied',
        priority: 'may',
      },
      {
        id: 'c3',
        book_id: 'book-A',
        target_kind: 'theme',
        target_id: 'th-1',
        status: 'applied',
        priority: 'should',
      },
      {
        id: 'c4',
        book_id: 'book-A',
        target_kind: 'outline',
        target_id: 'ol-1',
        status: 'applied',
        priority: 'must',
      },
      {
        id: 'c5',
        book_id: 'book-A',
        target_kind: 'cover_text',
        target_id: 'ct-1',
        status: 'applied',
        priority: 'should',
      },
    ];

    const pendingCounts = new Map([['book-A', 5]]);
    const mustPendingCounts = new Map([['book-A', 1]]);

    const { deps, spies } = makeDeps({
      comments,
      pendingCounts,
      mustPendingCounts,
    });
    const result = await rollbackRevisionRunCore(
      { revision_run_id: 'run-1' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.data.restored).toBe(5);
    }

    // No chapter operations
    expect(spies.chapterFindUnique).not.toHaveBeenCalled();
    expect(spies.chapterRevisionFindFirst).not.toHaveBeenCalled();
    expect(spies.chapterRevisionCreate).not.toHaveBeenCalled();
    expect(spies.chapterUpdate).not.toHaveBeenCalled();

    // All 5 comments reset
    expect(spies.commentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['c1', 'c2', 'c3', 'c4', 'c5'] } },
      }),
    );
  });

  // --- not_applicable comments are excluded ---

  it('does not rollback not_applicable comments', async () => {
    const comments: RollbackCommentRow[] = [
      {
        id: 'c1',
        book_id: 'book-A',
        target_kind: 'chapter',
        target_id: 'ch-1',
        status: 'not_applicable',
        priority: 'should',
      },
    ];

    const { deps } = makeDeps({ comments });
    const result = await rollbackRevisionRunCore(
      { revision_run_id: 'run-1' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });

  // --- audit log ---

  it('records audit_log with action revision_run.rollback', async () => {
    const comments: RollbackCommentRow[] = [
      {
        id: 'c1',
        book_id: 'book-A',
        target_kind: 'cover',
        target_id: 'cov-1',
        status: 'applied',
        priority: 'may',
      },
    ];

    const pendingCounts = new Map([['book-A', 1]]);

    const { deps, spies } = makeDeps({ comments, pendingCounts });
    await rollbackRevisionRunCore(
      { revision_run_id: 'run-1' },
      deps,
    );

    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    expect(spies.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'revision_run.rollback',
          target_kind: 'revision_run',
          target_id: 'run-1',
        }),
      }),
    );
  });

  // --- multi-book rollback ---

  it('recalculates flags for each affected book', async () => {
    const comments: RollbackCommentRow[] = [
      {
        id: 'c1',
        book_id: 'book-A',
        target_kind: 'cover',
        target_id: 'cov-1',
        status: 'applied',
        priority: 'must',
      },
      {
        id: 'c2',
        book_id: 'book-B',
        target_kind: 'cover',
        target_id: 'cov-2',
        status: 'applied',
        priority: 'should',
      },
    ];

    const pendingCounts = new Map([
      ['book-A', 1],
      ['book-B', 1],
    ]);
    const mustPendingCounts = new Map([
      ['book-A', 1],
      ['book-B', 0],
    ]);

    const { deps, spies } = makeDeps({
      comments,
      pendingCounts,
      mustPendingCounts,
    });
    const result = await rollbackRevisionRunCore(
      { revision_run_id: 'run-1' },
      deps,
    );

    expect(isOk(result)).toBe(true);

    expect(spies.bookUpdate).toHaveBeenCalledTimes(2);

    const bookACalls = spies.bookUpdate.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (call: any[]) => call[0].where.id === 'book-A',
    );
    expect(bookACalls).toHaveLength(1);
    expect(bookACalls[0]![0].data).toEqual({
      has_pending_comments: true,
      has_blocking_comments: true,
    });

    const bookBCalls = spies.bookUpdate.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (call: any[]) => call[0].where.id === 'book-B',
    );
    expect(bookBCalls).toHaveLength(1);
    expect(bookBCalls[0]![0].data).toEqual({
      has_pending_comments: true,
      has_blocking_comments: false,
    });
  });
});
