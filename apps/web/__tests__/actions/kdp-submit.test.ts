/**
 * kdp-submit.ts のユニットテスト (T-08-09, F-041).
 *
 * 検証:
 *  1. 不正入力 → validation fail (zod)
 *  2. 有効入力 + 認証済 → prisma 経由でキューに登録できる (ok)
 *  3. unqueueFromKdp が動作する
 *  4. throw しない
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isFail, isOk } from '@a2p/contracts';

// ---------------------------------------------------------------------------
// auth-helpers をモック — SA 内の getSessionOrThrow が呼ばれたとき認証済とみなす。
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth-helpers', () => ({
  getSessionOrThrow: vi.fn().mockResolvedValue({
    user: { id: 'u_1', username: 'operator' },
  }),
}));

// ---------------------------------------------------------------------------
// next/cache をモック — 'use server' ファイルが revalidatePath を呼んでも落ちない。
// ---------------------------------------------------------------------------

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// ---------------------------------------------------------------------------
// @a2p/db (prisma) をモック
// ---------------------------------------------------------------------------

const bookFindMany = vi.fn();
const bookUpdateMany = vi.fn();
const revisionCommentFindMany = vi.fn();
const auditLogCreate = vi.fn();

vi.mock('@a2p/db', () => ({
  prisma: {
    book: {
      findMany: (...args: unknown[]) => bookFindMany(...args),
      updateMany: (...args: unknown[]) => bookUpdateMany(...args),
    },
    revisionComment: {
      findMany: (...args: unknown[]) => revisionCommentFindMany(...args),
    },
    auditLog: {
      create: (...args: unknown[]) => auditLogCreate(...args),
    },
  },
}));

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

let submitToKdp: (input: unknown) => Promise<import('@a2p/contracts').ActionResult<unknown>>;
let unqueueFromKdp: (input: unknown) => Promise<import('@a2p/contracts').ActionResult<unknown>>;

function mockBook(overrides: Partial<{
  id: string;
  status: string;
  publish_status: string;
  kdpMetadata: { id: string } | null;
}> = {}) {
  return {
    id: 'book_1',
    status: 'done',
    publish_status: 'unlisted',
    kdpMetadata: { id: 'meta_1' },
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  bookFindMany.mockResolvedValue([mockBook()]);
  bookUpdateMany.mockResolvedValue({ count: 1 });
  revisionCommentFindMany.mockResolvedValue([]);
  auditLogCreate.mockResolvedValue({});

  const mod = await import('@/app/actions/kdp-submit');
  submitToKdp = mod.submitToKdp as typeof submitToKdp;
  unqueueFromKdp = mod.unqueueFromKdp as typeof unqueueFromKdp;
});

// ---------------------------------------------------------------------------
// Test 1: 不正入力 → validation fail
// ---------------------------------------------------------------------------

describe('submitToKdp — validation', () => {
  it('book_ids が空配列のとき validation fail を返す', async () => {
    const result = await submitToKdp({ book_ids: [] });
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('book_ids が 21 件のとき validation fail を返す (max 20)', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `book_${i}`);
    const result = await submitToKdp({ book_ids: ids });
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('book_ids が文字列のとき validation fail を返す', async () => {
    const result = await submitToKdp({ book_ids: 'not-an-array' });
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('book_ids が未指定のとき validation fail を返す', async () => {
    const result = await submitToKdp({});
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('null 入力のとき validation fail を返す', async () => {
    const result = await submitToKdp(null);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Test 2: 有効入力 → キューに登録する (ok)
// ---------------------------------------------------------------------------

describe('submitToKdp — queue', () => {
  it('入稿可能な書籍はキューに登録される', async () => {
    const result = await submitToKdp({ book_ids: ['book_1'] });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const data = result.data as { queued: Array<{ book_id: string }>; blocked: unknown[] };
      expect(data.queued).toEqual([{ book_id: 'book_1' }]);
      expect(data.blocked).toHaveLength(0);
    }
    expect(bookUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['book_1'] } },
      data: expect.objectContaining({ kdp_publish_queued: true }),
    });
  });

  it('must コメントが残っている書籍は blocked になる', async () => {
    revisionCommentFindMany.mockResolvedValue([{ book_id: 'book_1' }]);
    const result = await submitToKdp({ book_ids: ['book_1'] });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const data = result.data as { queued: unknown[]; blocked: Array<{ book_id: string; reason: string }> };
      expect(data.queued).toHaveLength(0);
      expect(data.blocked).toEqual([{ book_id: 'book_1', reason: expect.any(String) }]);
    }
    expect(bookUpdateMany).not.toHaveBeenCalled();
  });

  it('既に出版済みの書籍は blocked になる', async () => {
    bookFindMany.mockResolvedValue([mockBook({ publish_status: 'published' })]);
    const result = await submitToKdp({ book_ids: ['book_1'] });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const data = result.data as { queued: unknown[]; blocked: unknown[] };
      expect(data.queued).toHaveLength(0);
      expect(data.blocked).toHaveLength(1);
    }
  });

  it('入稿可能な状態でない書籍 (running 等) は blocked になる', async () => {
    bookFindMany.mockResolvedValue([mockBook({ status: 'running' })]);
    const result = await submitToKdp({ book_ids: ['book_1'] });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const data = result.data as { blocked: unknown[] };
      expect(data.blocked).toHaveLength(1);
    }
  });

  it('メタデータ未生成の書籍は blocked になる', async () => {
    bookFindMany.mockResolvedValue([mockBook({ kdpMetadata: null })]);
    const result = await submitToKdp({ book_ids: ['book_1'] });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const data = result.data as { blocked: unknown[] };
      expect(data.blocked).toHaveLength(1);
    }
  });

  it('audit_log を記録する', async () => {
    await submitToKdp({ book_ids: ['book_1'] });
    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'kdp.queue' }),
      }),
    );
  });

  it('throw しない (例外を送出しない)', async () => {
    await expect(submitToKdp({ book_ids: ['book_x'] })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test 3: unqueueFromKdp
// ---------------------------------------------------------------------------

describe('unqueueFromKdp', () => {
  it('不正入力は validation fail', async () => {
    const result = await unqueueFromKdp({ book_ids: [] });
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('キューから取り消す', async () => {
    const result = await unqueueFromKdp({ book_ids: ['book_1'] });
    expect(isOk(result)).toBe(true);
    expect(bookUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['book_1'] } },
      data: { kdp_publish_queued: false, kdp_publish_queued_at: null },
    });
  });
});
