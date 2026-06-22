/**
 * comments-core.ts のユニットテスト (T-06-01, F-049).
 *
 * 検証:
 *  1. createComment で has_blocking_comments が true になる (must priority)
 *  2. deleteComment で最後の must コメント削除時に has_blocking_comments が false になる
 *  3. bulkChangePriority で must -> may に変更時に has_blocking_comments が再計算される
 *  4. createComment で book 未存在時 not_found
 *  5. updateComment で priority 変更時に Book フラグ再計算
 *  6. deleteComment で存在しないコメント時 not_found
 *  7. 入力 zod 検証
 */
import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@a2p/db';
import { isFail, isOk } from '@a2p/contracts';

import {
  createCommentCore,
  updateCommentCore,
  deleteCommentCore,
  bulkChangePriorityCore,
  type CommentsDeps,
  type CommentRow,
} from '../../lib/comments-core';

const FROZEN_NOW = new Date('2026-05-25T10:00:00.000Z');

interface CommentStoreRow extends CommentRow {
  body: string;
}

function makeDeps(opts: {
  comments?: CommentStoreRow[];
  bookExists?: boolean;
}): {
  deps: CommentsDeps;
  spies: {
    commentCreate: ReturnType<typeof vi.fn>;
    commentFindUnique: ReturnType<typeof vi.fn>;
    commentFindMany: ReturnType<typeof vi.fn>;
    commentUpdate: ReturnType<typeof vi.fn>;
    commentUpdateMany: ReturnType<typeof vi.fn>;
    commentCount: ReturnType<typeof vi.fn>;
    bookFindUnique: ReturnType<typeof vi.fn>;
    bookUpdate: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
  };
  commentsStore: CommentStoreRow[];
  bookFlags: { has_pending_comments: boolean; has_blocking_comments: boolean };
} {
  const commentsStore: CommentStoreRow[] = (opts.comments ?? []).map((c) => ({ ...c }));
  const bookFlags = { has_pending_comments: false, has_blocking_comments: false };

  let commentIdCounter = 0;
  const commentCreate = vi.fn(async (args: { data: { book_id: string; priority: string; status: string; body: string } }) => {
    commentIdCounter += 1;
    const id = `comment_${commentIdCounter}`;
    commentsStore.push({
      id,
      book_id: args.data.book_id,
      status: args.data.status,
      priority: args.data.priority,
      body: args.data.body,
    });
    return { id };
  });

  const commentFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const row = commentsStore.find((c) => c.id === args.where.id);
    if (!row) return null;
    return { id: row.id, book_id: row.book_id, status: row.status, priority: row.priority };
  });

  const commentFindMany = vi.fn(async (args: {
    where: { id?: { in: string[] }; book_id?: string; status?: string };
  }) => {
    return commentsStore.filter((c) => {
      if (args.where.id && !args.where.id.in.includes(c.id)) return false;
      if (args.where.book_id !== undefined && c.book_id !== args.where.book_id) return false;
      if (args.where.status !== undefined && c.status !== args.where.status) return false;
      return true;
    }).map((c) => ({ id: c.id, book_id: c.book_id, status: c.status, priority: c.priority }));
  });

  const commentUpdate = vi.fn(async (args: {
    where: { id: string };
    data: { body?: string; priority?: string; status?: string };
  }) => {
    const row = commentsStore.find((c) => c.id === args.where.id);
    if (row) {
      if (args.data.body !== undefined) row.body = args.data.body;
      if (args.data.priority !== undefined) row.priority = args.data.priority;
      if (args.data.status !== undefined) row.status = args.data.status;
    }
    return { id: args.where.id };
  });

  const commentUpdateMany = vi.fn(async (args: {
    where: { id: { in: string[] } };
    data: { priority: string };
  }) => {
    let count = 0;
    const ids = new Set(args.where.id.in);
    for (const c of commentsStore) {
      if (ids.has(c.id)) {
        c.priority = args.data.priority;
        count++;
      }
    }
    return { count };
  });

  const commentCount = vi.fn(async (args: {
    where: { book_id: string; status: string; priority?: string };
  }) => {
    return commentsStore.filter((c) => {
      if (c.book_id !== args.where.book_id) return false;
      if (c.status !== args.where.status) return false;
      if (args.where.priority !== undefined && c.priority !== args.where.priority) return false;
      return true;
    }).length;
  });

  const bookFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    if (opts.bookExists === false) return null;
    return { id: args.where.id };
  });

  const bookUpdate = vi.fn(async (args: {
    where: { id: string };
    data: { has_pending_comments: boolean; has_blocking_comments: boolean };
  }) => {
    bookFlags.has_pending_comments = args.data.has_pending_comments;
    bookFlags.has_blocking_comments = args.data.has_blocking_comments;
    return { id: args.where.id };
  });

  const auditCreate = vi.fn(async () => ({}));

  const repoBundle = () => ({
    commentRepo: {
      create: commentCreate,
      findUnique: commentFindUnique,
      findMany: commentFindMany,
      update: commentUpdate,
      updateMany: commentUpdateMany,
      count: commentCount,
    } as unknown as CommentsDeps['commentRepo'],
    bookRepo: {
      findUnique: bookFindUnique,
      update: bookUpdate,
    } as unknown as CommentsDeps['bookRepo'],
    auditLogRepo: {
      create: auditCreate,
    } as unknown as CommentsDeps['auditLogRepo'],
  });

  const runTransaction: CommentsDeps['runTransaction'] = async (fn) =>
    fn(repoBundle());

  return {
    deps: {
      ...repoBundle(),
      runTransaction,
      session: { user: { id: 'u_1', username: 'operator' } },
      now: () => FROZEN_NOW,
    },
    spies: {
      commentCreate,
      commentFindUnique,
      commentFindMany,
      commentUpdate,
      commentUpdateMany,
      commentCount,
      bookFindUnique,
      bookUpdate,
      auditCreate,
    },
    commentsStore,
    bookFlags,
  };
}

function commentStub(
  id: string,
  bookId: string,
  priority: string,
  status = 'pending',
): CommentStoreRow {
  return { id, book_id: bookId, priority, status, body: 'test comment' };
}

// ---------------------------------------------------------------------------
// Test Case 1: createComment で has_blocking_comments が true になる
// ---------------------------------------------------------------------------

describe('createCommentCore - has_blocking_comments becomes true on must', () => {
  it('must priority のコメント作成で has_blocking_comments=true', async () => {
    const { deps, spies, bookFlags } = makeDeps({ bookExists: true });

    const r = await createCommentCore({
      book_id: 'book_1',
      target_kind: 'chapter',
      target_id: 'ch_1',
      body: '第3章に事例を追加してください',
      priority: 'must',
    }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.comment_id).toMatch(/^comment_/);

    // Book flags updated
    expect(bookFlags.has_pending_comments).toBe(true);
    expect(bookFlags.has_blocking_comments).toBe(true);

    // audit_log recorded
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('comment.create');
    expect(auditArg.data.target_kind).toBe('revision_comment');
  });

  it('should priority のコメント作成で has_blocking_comments=false', async () => {
    const { deps, bookFlags } = makeDeps({ bookExists: true });

    const r = await createCommentCore({
      book_id: 'book_1',
      target_kind: 'outline',
      target_id: 'outline_1',
      body: '構成を見直したほうが良い',
      priority: 'should',
    }, deps);

    expect(isOk(r)).toBe(true);
    expect(bookFlags.has_pending_comments).toBe(true);
    expect(bookFlags.has_blocking_comments).toBe(false);
  });

  it('book 未存在時 not_found', async () => {
    const { deps } = makeDeps({ bookExists: false });

    const r = await createCommentCore({
      book_id: 'no_book',
      target_kind: 'chapter',
      target_id: 'ch_1',
      body: 'test',
      priority: 'must',
    }, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Test Case 2: deleteComment で最後の must コメント削除時に has_blocking_comments が false
// ---------------------------------------------------------------------------

describe('deleteCommentCore - last must deletion clears has_blocking_comments', () => {
  it('最後の must コメント削除で has_blocking_comments=false', async () => {
    const comments = [
      commentStub('c_1', 'book_1', 'must', 'pending'),
      commentStub('c_2', 'book_1', 'should', 'pending'),
    ];

    const { deps, bookFlags } = makeDeps({ comments, bookExists: true });

    const r = await deleteCommentCore({ comment_id: 'c_1' }, deps);

    expect(isOk(r)).toBe(true);
    // c_1 is now superseded, only c_2 (should) remains pending
    expect(bookFlags.has_pending_comments).toBe(true);
    expect(bookFlags.has_blocking_comments).toBe(false);
  });

  it('全 pending コメント削除で has_pending_comments=false', async () => {
    const comments = [
      commentStub('c_1', 'book_1', 'should', 'pending'),
    ];

    const { deps, bookFlags } = makeDeps({ comments, bookExists: true });

    const r = await deleteCommentCore({ comment_id: 'c_1' }, deps);

    expect(isOk(r)).toBe(true);
    expect(bookFlags.has_pending_comments).toBe(false);
    expect(bookFlags.has_blocking_comments).toBe(false);
  });

  it('存在しないコメント削除で not_found', async () => {
    const { deps } = makeDeps({ bookExists: true });

    const r = await deleteCommentCore({ comment_id: 'nonexistent' }, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Test Case 3: bulkChangePriority で must -> may に変更時に has_blocking_comments 再計算
// ---------------------------------------------------------------------------

describe('bulkChangePriorityCore - must to may clears has_blocking_comments', () => {
  it('must -> may 変更で has_blocking_comments=false', async () => {
    const comments = [
      commentStub('c_1', 'book_1', 'must', 'pending'),
      commentStub('c_2', 'book_1', 'must', 'pending'),
      commentStub('c_3', 'book_1', 'should', 'pending'),
    ];

    const { deps, bookFlags, commentsStore } = makeDeps({ comments, bookExists: true });

    const r = await bulkChangePriorityCore({
      comment_ids: ['c_1', 'c_2'],
      priority: 'may',
    }, deps);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.data.updated).toBe(2);

    // Verify store update
    expect(commentsStore.find((c) => c.id === 'c_1')!.priority).toBe('may');
    expect(commentsStore.find((c) => c.id === 'c_2')!.priority).toBe('may');

    // No must pending left
    expect(bookFlags.has_pending_comments).toBe(true);
    expect(bookFlags.has_blocking_comments).toBe(false);
  });

  it('should -> must 変更で has_blocking_comments=true', async () => {
    const comments = [
      commentStub('c_1', 'book_1', 'should', 'pending'),
    ];

    const { deps, bookFlags } = makeDeps({ comments, bookExists: true });

    const r = await bulkChangePriorityCore({
      comment_ids: ['c_1'],
      priority: 'must',
    }, deps);

    expect(isOk(r)).toBe(true);
    expect(bookFlags.has_blocking_comments).toBe(true);
  });

  it('空配列で validation エラー', async () => {
    const { deps } = makeDeps({ bookExists: true });

    const r = await bulkChangePriorityCore({
      comment_ids: [],
      priority: 'must',
    }, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('pending でないコメントのみ指定時 not_found', async () => {
    const comments = [
      commentStub('c_1', 'book_1', 'must', 'applied'),
    ];

    const { deps } = makeDeps({ comments, bookExists: true });

    const r = await bulkChangePriorityCore({
      comment_ids: ['c_1'],
      priority: 'may',
    }, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// updateCommentCore
// ---------------------------------------------------------------------------

describe('updateCommentCore', () => {
  it('priority 変更時に Book フラグ再計算', async () => {
    const comments = [
      commentStub('c_1', 'book_1', 'must', 'pending'),
    ];

    const { deps, bookFlags, commentsStore } = makeDeps({ comments, bookExists: true });

    const r = await updateCommentCore({
      comment_id: 'c_1',
      priority: 'may',
    }, deps);

    expect(isOk(r)).toBe(true);
    expect(commentsStore.find((c) => c.id === 'c_1')!.priority).toBe('may');
    expect(bookFlags.has_blocking_comments).toBe(false);
  });

  it('body のみ変更時は Book フラグ再計算なし', async () => {
    const comments = [
      commentStub('c_1', 'book_1', 'must', 'pending'),
    ];

    const { deps, spies } = makeDeps({ comments, bookExists: true });

    const r = await updateCommentCore({
      comment_id: 'c_1',
      body: 'updated body',
    }, deps);

    expect(isOk(r)).toBe(true);
    // bookUpdate should not be called (recalcBookFlags not invoked)
    expect(spies.bookUpdate).not.toHaveBeenCalled();
  });

  it('存在しないコメント更新で not_found', async () => {
    const { deps } = makeDeps({ bookExists: true });

    const r = await updateCommentCore({
      comment_id: 'nonexistent',
      body: 'test',
    }, deps);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('createCommentCore - input validation', () => {
  it('body empty fails validation', async () => {
    const { deps } = makeDeps({ bookExists: true });
    const r = await createCommentCore({
      book_id: 'book_1',
      target_kind: 'chapter',
      target_id: 'ch_1',
      body: '',
      priority: 'must',
    }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('invalid priority fails validation', async () => {
    const { deps } = makeDeps({ bookExists: true });
    const r = await createCommentCore({
      book_id: 'book_1',
      target_kind: 'chapter',
      target_id: 'ch_1',
      body: 'test',
      priority: 'critical',
    }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('missing book_id fails validation', async () => {
    const { deps } = makeDeps({ bookExists: true });
    const r = await createCommentCore({
      target_kind: 'chapter',
      target_id: 'ch_1',
      body: 'test',
      priority: 'must',
    }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  // 回帰防止: KDP 入稿チェックリストの「コメント」列は range に
  // { field: <フィールド名> } を渡す。これが range union に無いと
  // バリデーションで弾かれ「登録できない (UI 無反応)」になっていた。
  it('metadata フィールドアンカー { field } で登録できる', async () => {
    const { deps } = makeDeps({ bookExists: true });
    const r = await createCommentCore({
      book_id: 'book_1',
      target_kind: 'metadata',
      target_id: 'book_1',
      range: { field: 'title' },
      body: 'タイトルを変更してください',
      priority: 'should',
    }, deps);
    expect(isOk(r)).toBe(true);
  });
});

// Prisma import warning suppression
void Prisma;
