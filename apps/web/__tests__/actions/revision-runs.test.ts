/**
 * revision-runs-core.ts のユニットテスト (T-06-07, F-050).
 *
 * 検証:
 *  - createRevisionRun:
 *    - 入力 zod (空配列 / 上限超過)
 *    - pending コメントのみ対象
 *    - BookLock 検査: ロック済み書籍のコメントは除外 → blocked_books に含まれる
 *    - 推定コスト計算: コメント数 x 80 円
 *    - 推定時間: コメント数 x 30 秒 (分に変換、最低 1 分)
 *    - RevisionRun INSERT (status=queued, book_ids_json, comment_ids_json)
 *    - 対象コメントの run_id 更新
 *    - 書籍ごとに 1 タスク enqueue (revision.book.apply)
 *    - audit_log 1 件 (action='revision_run.kick')
 *    - 全書籍ロック → ValidationError
 */
import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  createRevisionRunCore,
  REVISION_BOOK_APPLY_TASK_NAME,
  COST_PER_COMMENT_JPY,
  SECONDS_PER_COMMENT,
  type RevisionRunsDeps,
  type CommentRow,
  type BookLockRow,
} from '../../lib/revision-runs-core';

const FROZEN_NOW = new Date('2026-05-25T10:00:00.000Z');

function makeDeps(opts: {
  comments?: CommentRow[];
  locks?: BookLockRow[];
  enqueueImpl?: (taskName: string, payload: unknown) => Promise<string>;
}): {
  deps: RevisionRunsDeps;
  spies: {
    commentFindMany: ReturnType<typeof vi.fn>;
    commentUpdateMany: ReturnType<typeof vi.fn>;
    bookLockFindMany: ReturnType<typeof vi.fn>;
    revisionRunCreate: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };
} {
  const commentsStore = (opts.comments ?? []).map((c) => ({ ...c }));
  const locksStore = (opts.locks ?? []).map((l) => ({ ...l }));

  const commentFindMany = vi.fn(
    async (args: {
      where: {
        id?: { in: string[] };
        book_id?: { in: string[] };
        status?: string;
      };
    }) => {
      return commentsStore.filter((c) => {
        if (args.where.id && !args.where.id.in.includes(c.id)) return false;
        if (args.where.book_id && !args.where.book_id.in.includes(c.book_id)) return false;
        if (args.where.status !== undefined && c.status !== args.where.status) return false;
        return true;
      }).map((c) => ({ id: c.id, book_id: c.book_id, status: c.status }));
    },
  );

  const commentUpdateMany = vi.fn(async () => ({ count: 0 }));

  const bookLockFindMany = vi.fn(
    async (args: {
      where: {
        book_id: { in: string[] };
        expires_at: { gt: Date };
      };
    }) => {
      return locksStore.filter((l) => {
        if (!args.where.book_id.in.includes(l.book_id)) return false;
        if (l.expires_at <= args.where.expires_at.gt) return false;
        return true;
      });
    },
  );

  let runIdCounter = 0;
  const revisionRunCreate = vi.fn(async () => {
    runIdCounter++;
    return { id: `run-${runIdCounter}` };
  });

  const auditCreate = vi.fn(async () => ({}));

  const enqueue = vi.fn(
    opts.enqueueImpl ?? (async () => 'gw-job-1'),
  );

  const deps: RevisionRunsDeps = {
    commentRepo: {
      findMany: commentFindMany,
      updateMany: commentUpdateMany,
    },
    bookLockRepo: {
      findMany: bookLockFindMany,
    },
    revisionRunRepo: {
      create: revisionRunCreate,
    },
    auditLogRepo: {
      create: auditCreate,
    },
    jobRepo: {
      create: vi.fn(async () => ({ id: 'apply-job-1' })),
    },
    runTransaction: async (fn) =>
      fn({
        commentRepo: {
          findMany: commentFindMany,
          updateMany: commentUpdateMany,
        },
        revisionRunRepo: {
          create: revisionRunCreate,
        },
        auditLogRepo: {
          create: auditCreate,
        },
      }),
    session: { user: { id: 'user-1', username: 'admin' } },
    enqueueJob: enqueue,
    now: () => FROZEN_NOW,
  };

  return {
    deps,
    spies: {
      commentFindMany,
      commentUpdateMany,
      bookLockFindMany,
      revisionRunCreate,
      auditCreate,
      enqueue,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRevisionRunCore', () => {
  // --- zod validation ---

  it('rejects empty comment_ids', async () => {
    const { deps } = makeDeps({});
    const result = await createRevisionRunCore({ comment_ids: [] }, deps);
    expect(isFail(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
  });

  it('rejects missing comment_ids', async () => {
    const { deps } = makeDeps({});
    const result = await createRevisionRunCore({}, deps);
    expect(isFail(result)).toBe(true);
  });

  // --- blocked_books detection ---

  it('detects blocked books and excludes their comments', async () => {
    const comments: CommentRow[] = [
      { id: 'c1', book_id: 'book-A', status: 'pending' },
      { id: 'c2', book_id: 'book-B', status: 'pending' },
      { id: 'c3', book_id: 'book-A', status: 'pending' },
    ];
    const locks: BookLockRow[] = [
      {
        book_id: 'book-A',
        holder: 'pipeline:job-1',
        expires_at: new Date('2026-05-25T11:00:00.000Z'), // after FROZEN_NOW
      },
    ];

    const { deps, spies } = makeDeps({ comments, locks });
    const result = await createRevisionRunCore(
      { comment_ids: ['c1', 'c2', 'c3'], scope: 'selected' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.data.blocked_books).toEqual(['book-A']);
      expect(result.data.run_id).toBe('run-1');
    }

    // Only book-B comments should be in the run
    expect(spies.commentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['c2'] } },
      }),
    );

    // Only 1 enqueue call (book-B)
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    // payload は worker タスク (run_id / book_id / comment_ids / job_id) に一致させる。
    // job_id は事前に作成した app Job 行の id (FK)。
    expect(spies.enqueue).toHaveBeenCalledWith(
      REVISION_BOOK_APPLY_TASK_NAME,
      expect.objectContaining({
        run_id: 'run-1',
        book_id: 'book-B',
        comment_ids: ['c2'],
        job_id: 'apply-job-1',
      }),
    );
  });

  it('returns error when all books are locked', async () => {
    const comments: CommentRow[] = [
      { id: 'c1', book_id: 'book-A', status: 'pending' },
    ];
    const locks: BookLockRow[] = [
      {
        book_id: 'book-A',
        holder: 'pipeline:job-1',
        expires_at: new Date('2026-05-25T11:00:00.000Z'),
      },
    ];

    const { deps } = makeDeps({ comments, locks });
    const result = await createRevisionRunCore(
      { comment_ids: ['c1'], scope: 'selected' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
  });

  it('ignores expired locks', async () => {
    const comments: CommentRow[] = [
      { id: 'c1', book_id: 'book-A', status: 'pending' },
    ];
    const locks: BookLockRow[] = [
      {
        book_id: 'book-A',
        holder: 'pipeline:old',
        expires_at: new Date('2026-05-25T09:00:00.000Z'), // before FROZEN_NOW
      },
    ];

    const { deps } = makeDeps({ comments, locks });
    const result = await createRevisionRunCore(
      { comment_ids: ['c1'], scope: 'selected' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.data.blocked_books).toEqual([]);
    }
  });

  // --- 1 book = 1 task enqueue ---

  it('enqueues one task per unique book', async () => {
    const comments: CommentRow[] = [
      { id: 'c1', book_id: 'book-A', status: 'pending' },
      { id: 'c2', book_id: 'book-A', status: 'pending' },
      { id: 'c3', book_id: 'book-B', status: 'pending' },
      { id: 'c4', book_id: 'book-C', status: 'pending' },
    ];

    const { deps, spies } = makeDeps({ comments });
    const result = await createRevisionRunCore(
      { comment_ids: ['c1', 'c2', 'c3', 'c4'], scope: 'selected' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    expect(spies.enqueue).toHaveBeenCalledTimes(3); // 3 books

    const payloads = spies.enqueue.mock.calls.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (call: any[]) => call[1],
    ) as Array<{ book_id: string; comment_ids: string[] }>;

    const bookAPayload = payloads.find((p) => p.book_id === 'book-A');
    expect(bookAPayload).toBeDefined();
    expect(bookAPayload!.comment_ids).toEqual(['c1', 'c2']);

    const bookBPayload = payloads.find((p) => p.book_id === 'book-B');
    expect(bookBPayload).toBeDefined();
    expect(bookBPayload!.comment_ids).toEqual(['c3']);

    const bookCPayload = payloads.find((p) => p.book_id === 'book-C');
    expect(bookCPayload).toBeDefined();
    expect(bookCPayload!.comment_ids).toEqual(['c4']);
  });

  // --- cost estimation ---

  it('calculates estimated cost and time correctly', async () => {
    const comments: CommentRow[] = [
      { id: 'c1', book_id: 'book-A', status: 'pending' },
      { id: 'c2', book_id: 'book-A', status: 'pending' },
      { id: 'c3', book_id: 'book-B', status: 'pending' },
      { id: 'c4', book_id: 'book-B', status: 'pending' },
      { id: 'c5', book_id: 'book-C', status: 'pending' },
    ];

    const { deps } = makeDeps({ comments });
    const result = await createRevisionRunCore(
      { comment_ids: ['c1', 'c2', 'c3', 'c4', 'c5'], scope: 'selected' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.data.estimated_cost_jpy).toBe(5 * COST_PER_COMMENT_JPY);
      // 5 comments * 30 seconds = 150 seconds = 2.5 minutes -> ceil -> 3
      expect(result.data.estimated_minutes).toBe(
        Math.ceil((5 * SECONDS_PER_COMMENT) / 60),
      );
    }
  });

  it('ensures minimum 1 minute estimated time', async () => {
    const comments: CommentRow[] = [
      { id: 'c1', book_id: 'book-A', status: 'pending' },
    ];

    const { deps } = makeDeps({ comments });
    const result = await createRevisionRunCore(
      { comment_ids: ['c1'], scope: 'selected' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.data.estimated_minutes).toBeGreaterThanOrEqual(1);
    }
  });

  // --- RevisionRun and comment updates ---

  it('creates RevisionRun with correct data and updates comments', async () => {
    const comments: CommentRow[] = [
      { id: 'c1', book_id: 'book-A', status: 'pending' },
      { id: 'c2', book_id: 'book-B', status: 'pending' },
    ];

    const { deps, spies } = makeDeps({ comments });
    const result = await createRevisionRunCore(
      { comment_ids: ['c1', 'c2'], scope: 'selected' },
      deps,
    );

    expect(isOk(result)).toBe(true);

    // RevisionRun created with correct data
    expect(spies.revisionRunCreate).toHaveBeenCalledTimes(1);
    const createArgs = spies.revisionRunCreate.mock.calls[0]![0] as {
      data: {
        triggered_by: string;
        status: string;
        book_ids_json: unknown;
        comment_ids_json: unknown;
      };
    };
    expect(createArgs.data.triggered_by).toBe('user-1');
    expect(createArgs.data.status).toBe('queued');

    // Comments updated with run_id
    expect(spies.commentUpdateMany).toHaveBeenCalledTimes(1);
    const updateArgs = spies.commentUpdateMany.mock.calls[0]![0] as {
      where: { id: { in: string[] } };
      data: { run_id: string };
    };
    expect(updateArgs.data.run_id).toBe('run-1');
    expect(updateArgs.where.id.in).toEqual(expect.arrayContaining(['c1', 'c2']));

    // Audit log created
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArgs = spies.auditCreate.mock.calls[0]![0] as {
      data: { action: string; target_kind: string };
    };
    expect(auditArgs.data.action).toBe('revision_run.kick');
    expect(auditArgs.data.target_kind).toBe('revision_run');
  });

  // --- non-pending comments are excluded ---

  it('only includes pending comments', async () => {
    const comments: CommentRow[] = [
      { id: 'c1', book_id: 'book-A', status: 'pending' },
      { id: 'c2', book_id: 'book-A', status: 'applied' },
      { id: 'c3', book_id: 'book-A', status: 'not_applicable' },
    ];

    const { deps, spies } = makeDeps({ comments });
    const result = await createRevisionRunCore(
      { comment_ids: ['c1', 'c2', 'c3'], scope: 'selected' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.data.estimated_cost_jpy).toBe(1 * COST_PER_COMMENT_JPY);
    }

    // Only 1 comment included
    expect(spies.commentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['c1'] } },
      }),
    );
  });

  it('returns not_found when no pending comments exist', async () => {
    const comments: CommentRow[] = [
      { id: 'c1', book_id: 'book-A', status: 'applied' },
    ];

    const { deps } = makeDeps({ comments });
    const result = await createRevisionRunCore(
      { comment_ids: ['c1'], scope: 'selected' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });

  // --- scope=all_pending_in_selected_books ---

  it('fetches all pending comments for selected books when scope=all_pending_in_selected_books', async () => {
    const comments: CommentRow[] = [
      { id: 'c1', book_id: 'book-A', status: 'pending' },
      { id: 'c2', book_id: 'book-A', status: 'pending' },
      { id: 'c3', book_id: 'book-B', status: 'pending' },
    ];

    const { deps, spies } = makeDeps({ comments });
    const result = await createRevisionRunCore(
      {
        comment_ids: ['c1'],
        scope: 'all_pending_in_selected_books',
        selected_book_ids: ['book-A'],
      },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      // Should include c1 and c2 (both pending in book-A), not c3 (book-B)
      expect(result.data.estimated_cost_jpy).toBe(2 * COST_PER_COMMENT_JPY);
    }

    // commentFindMany called twice: once for specified IDs, once for book-A pending
    expect(spies.commentFindMany).toHaveBeenCalledTimes(2);
  });
});
