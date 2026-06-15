import { describe, expect, it, vi } from 'vitest';

import { ConflictError } from '@a2p/contracts/errors';

// `@a2p/db` を引かないようモック。各テストで deps 経由で repo を差し替える。
vi.mock('@a2p/db', () => ({
  prisma: {
    bookLock: {
      create: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import {
  acquireBookLock,
  releaseBookLock,
  sweepExpiredLocks,
  type BookLockLogger,
  type BookLockRecord,
  type BookLockRepo,
} from '../src/lib/book-lock.js';

// ---------------------------------------------------------------------------
// 実 DB セマンティクス忠実 mock
//
// PostgreSQL の Unique constraint (`BookLock.book_id` 主キー) と Prisma の
// `PrismaClientKnownRequestError({code:'P2002'})` を Map で正確に再現する。
//
// **acquire は期限切れチェックを持たない**: 死んだロックが残っていれば衝突する。
// 死んだロックの削除は sweepExpiredLocks の責務 (docs/05 OQ-D-05)。
// ---------------------------------------------------------------------------

class FakeP2002Error extends Error {
  code = 'P2002';
  override name = 'PrismaClientKnownRequestError';
  meta: { target?: string[] };
  constructor(target = 'book_locks_pkey') {
    super(`Unique constraint failed on the constraint: \`${target}\``);
    this.meta = { target: [target] };
  }
}

interface MockState {
  rows: Map<string, BookLockRecord>;
  repo: BookLockRepo;
}

function makeMockRepo(): MockState {
  const rows = new Map<string, BookLockRecord>();
  const repo: BookLockRepo = {
    create: vi.fn(async ({ data }) => {
      if (rows.has(data.book_id)) {
        // 実 DB の挙動と同じく、INSERT 時点で衝突を throw する。
        throw new FakeP2002Error();
      }
      const rec: BookLockRecord = {
        book_id: data.book_id,
        holder: data.holder,
        acquired_at: data.acquired_at ?? new Date(),
        expires_at: data.expires_at,
      };
      rows.set(data.book_id, rec);
      return rec;
    }),
    findUnique: vi.fn(async ({ where }) => rows.get(where.book_id) ?? null),
    deleteMany: vi.fn(async ({ where }) => {
      if ('expires_at' in where) {
        // sweep: expires_at < lt の行を全削除
        const threshold = where.expires_at.lt;
        let count = 0;
        for (const [k, v] of rows) {
          if (v.expires_at < threshold) {
            rows.delete(k);
            count++;
          }
        }
        return { count };
      }
      // release: book_id + holder の組合せでのみ削除
      const existing = rows.get(where.book_id);
      if (!existing || existing.holder !== where.holder) return { count: 0 };
      rows.delete(where.book_id);
      return { count: 1 };
    }),
  };
  return { rows, repo };
}

function makeLogger(): BookLockLogger & {
  infoCalls: Array<{ payload: Record<string, unknown>; msg?: string }>;
  warnCalls: Array<{ payload: Record<string, unknown>; msg?: string }>;
} {
  const infoCalls: Array<{ payload: Record<string, unknown>; msg?: string }> = [];
  const warnCalls: Array<{ payload: Record<string, unknown>; msg?: string }> = [];
  return {
    info: (payload, msg) => infoCalls.push({ payload, msg }),
    warn: (payload, msg) => warnCalls.push({ payload, msg }),
    infoCalls,
    warnCalls,
  };
}

// ---------------------------------------------------------------------------
// acquireBookLock
// ---------------------------------------------------------------------------

describe('acquireBookLock', () => {
  it('空ロック状態 → 成功し BookLockRecord を返す', async () => {
    const { repo, rows } = makeMockRepo();
    const logger = makeLogger();
    const now = new Date('2026-05-22T10:00:00Z');

    const rec = await acquireBookLock(
      { bookId: 'book-1', holder: 'pipeline:job-1', ttlMinutes: 30 },
      { prisma: { bookLock: repo }, logger, now: () => now },
    );

    expect(rec.book_id).toBe('book-1');
    expect(rec.holder).toBe('pipeline:job-1');
    expect(rec.expires_at.toISOString()).toBe('2026-05-22T10:30:00.000Z');
    expect(rows.size).toBe(1);
    expect(logger.infoCalls).toHaveLength(1);
  });

  it('ttlMinutes 既定 30 分', async () => {
    const { repo } = makeMockRepo();
    const now = new Date('2026-05-22T10:00:00Z');
    const rec = await acquireBookLock(
      { bookId: 'b', holder: 'pipeline:j' },
      { prisma: { bookLock: repo }, now: () => now },
    );
    expect(rec.expires_at.getTime() - now.getTime()).toBe(30 * 60_000);
  });

  it('ttlMinutes <= 0 → ConflictError (引数バリデーション)', async () => {
    const { repo } = makeMockRepo();
    await expect(
      acquireBookLock(
        { bookId: 'b', holder: 'h', ttlMinutes: 0 },
        { prisma: { bookLock: repo } },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('既存ロックあり → ConflictError + details に existingHolder/expiresAt', async () => {
    const { repo } = makeMockRepo();
    const now = new Date('2026-05-22T10:00:00Z');
    await acquireBookLock(
      { bookId: 'book-X', holder: 'pipeline:first' },
      { prisma: { bookLock: repo }, now: () => now },
    );

    try {
      await acquireBookLock(
        { bookId: 'book-X', holder: 'pipeline:second' },
        { prisma: { bookLock: repo }, now: () => now },
      );
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      const ce = err as ConflictError;
      expect(ce.code).toBe('conflict');
      const details = ce.details as Record<string, unknown>;
      expect(details).toMatchObject({
        reason: 'book_locked',
        bookId: 'book-X',
        requestedHolder: 'pipeline:second',
        existingHolder: 'pipeline:first',
      });
      expect(typeof details.existingExpiresAt).toBe('string');
    }
  });

  // タスク §4 完了判定 #1 — 同時 2 並列 acquire で 1 つだけ成功
  it('並列 2 acquire (same book) → 1 つのみ成功、もう 1 つは ConflictError', async () => {
    const { repo, rows } = makeMockRepo();

    // 並列実行をエミュレートするため、create を意図的にマイクロタスクで遅延させる。
    // 実 DB では transaction race だが、Map ベース mock でも create 内で `await Promise.resolve()`
    // を挟むことで「両者が同時に has() をすり抜けて、後着で throw」のリアル DB 順序を再現する必要がある。
    //
    // ただし本 mock の create は同期的に rows.has() → throw するため、JS シングルスレッドの
    // 性質上 2 つ目の create は必ず後着になる。これは PostgreSQL の挙動と同じ
    // (片方がコミットされるまでもう片方は待ってから unique 違反で fail する)。
    const results = await Promise.allSettled([
      acquireBookLock(
        { bookId: 'race', holder: 'A' },
        { prisma: { bookLock: repo } },
      ),
      acquireBookLock(
        { bookId: 'race', holder: 'B' },
        { prisma: { bookLock: repo } },
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictError,
    );
    expect(rows.size).toBe(1);
  });

  // タスク §4 完了判定 #2 — expires 後に再 acquire 可能 (sweep を挟んで)
  it('期限切れロック残存 → acquire はまだ conflict / sweep 後は再 acquire 成功', async () => {
    const { repo, rows } = makeMockRepo();
    const past = new Date('2026-05-22T09:00:00Z');
    const now = new Date('2026-05-22T10:00:00Z');

    // 過去 (TTL ごく短い) で 1 件 acquire — 結果として expires_at は past+1min = 過去
    await acquireBookLock(
      { bookId: 'book-E', holder: 'old-holder', ttlMinutes: 1 },
      { prisma: { bookLock: repo }, now: () => past },
    );
    expect(rows.size).toBe(1);

    // 現在時刻で再 acquire を試みる: sweep していないのでまだ conflict
    await expect(
      acquireBookLock(
        { bookId: 'book-E', holder: 'new-holder' },
        { prisma: { bookLock: repo }, now: () => now },
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // sweep を挟むと期限切れ行が消える
    const swept = await sweepExpiredLocks({
      prisma: { bookLock: repo },
      now: () => now,
    });
    expect(swept.deletedCount).toBe(1);
    expect(rows.size).toBe(0);

    // sweep 後は同一 book_id で再 acquire 成功
    const rec = await acquireBookLock(
      { bookId: 'book-E', holder: 'new-holder' },
      { prisma: { bookLock: repo }, now: () => now },
    );
    expect(rec.holder).toBe('new-holder');
  });

  it('Prisma が P2002 以外を throw → そのまま再 throw', async () => {
    const { repo } = makeMockRepo();
    (repo.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError('boom unknown'),
    );
    await expect(
      acquireBookLock(
        { bookId: 'b', holder: 'h' },
        { prisma: { bookLock: repo } },
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('衝突時の findUnique 失敗でも ConflictError は飛ぶ (details 一部欠落のみ)', async () => {
    const { repo } = makeMockRepo();
    // まず 1 つ入れる
    await acquireBookLock(
      { bookId: 'b', holder: 'first' },
      { prisma: { bookLock: repo } },
    );
    // findUnique を 1 回だけ失敗させる
    (repo.findUnique as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('db unavailable'),
    );

    await expect(
      acquireBookLock(
        { bookId: 'b', holder: 'second' },
        { prisma: { bookLock: repo } },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// releaseBookLock
// ---------------------------------------------------------------------------

describe('releaseBookLock', () => {
  // タスク §4 完了判定 #4 — 同一 holder の release は成功
  it('同一 holder の release 成功 → lock 消滅', async () => {
    const { repo, rows } = makeMockRepo();
    await acquireBookLock(
      { bookId: 'b', holder: 'pipeline:j' },
      { prisma: { bookLock: repo } },
    );
    expect(rows.size).toBe(1);

    await releaseBookLock(
      { bookId: 'b', holder: 'pipeline:j' },
      { prisma: { bookLock: repo } },
    );
    expect(rows.size).toBe(0);
  });

  // タスク §4 完了判定 #3 — 他 holder の lock を release できない
  it('他 holder からの release → warn ログのみで lock 残存', async () => {
    const { repo, rows } = makeMockRepo();
    const logger = makeLogger();
    await acquireBookLock(
      { bookId: 'b', holder: 'alice' },
      { prisma: { bookLock: repo } },
    );

    await releaseBookLock(
      { bookId: 'b', holder: 'bob' },
      { prisma: { bookLock: repo }, logger },
    );

    expect(rows.size).toBe(1);
    expect(rows.get('b')!.holder).toBe('alice');
    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]!.msg).toContain('no row deleted');
  });

  it('存在しないロックの release → エラーにせず warn のみ', async () => {
    const { repo } = makeMockRepo();
    const logger = makeLogger();
    await expect(
      releaseBookLock(
        { bookId: 'no-such', holder: 'h' },
        { prisma: { bookLock: repo }, logger },
      ),
    ).resolves.toBeUndefined();
    expect(logger.warnCalls).toHaveLength(1);
  });

  // タスク §4 完了判定 #6 — release 後の再 acquire 成功
  it('release 後の再 acquire 成功 (別 holder でも OK)', async () => {
    const { repo } = makeMockRepo();
    await acquireBookLock(
      { bookId: 'b', holder: 'A' },
      { prisma: { bookLock: repo } },
    );
    await releaseBookLock(
      { bookId: 'b', holder: 'A' },
      { prisma: { bookLock: repo } },
    );
    const rec = await acquireBookLock(
      { bookId: 'b', holder: 'B' },
      { prisma: { bookLock: repo } },
    );
    expect(rec.holder).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// sweepExpiredLocks
// ---------------------------------------------------------------------------

describe('sweepExpiredLocks', () => {
  // タスク §4 完了判定 #5 — sweep が期限切れのみ削除
  it('expired のみ削除、future / recently-acquired は残す', async () => {
    const { repo, rows } = makeMockRepo();
    const now = new Date('2026-05-22T10:00:00Z');

    // 3 行: 過去 1 / 過去 2 / 未来 1
    await acquireBookLock(
      { bookId: 'b-past-1', holder: 'h', ttlMinutes: 1 },
      { prisma: { bookLock: repo }, now: () => new Date('2026-05-22T08:00:00Z') },
    );
    await acquireBookLock(
      { bookId: 'b-past-2', holder: 'h', ttlMinutes: 1 },
      { prisma: { bookLock: repo }, now: () => new Date('2026-05-22T09:00:00Z') },
    );
    await acquireBookLock(
      { bookId: 'b-future', holder: 'h', ttlMinutes: 60 },
      { prisma: { bookLock: repo }, now: () => now },
    );
    expect(rows.size).toBe(3);

    const result = await sweepExpiredLocks({
      prisma: { bookLock: repo },
      now: () => now,
    });

    expect(result.deletedCount).toBe(2);
    expect(rows.size).toBe(1);
    expect(rows.has('b-future')).toBe(true);
  });

  it('期限切れ 0 件 → deletedCount=0', async () => {
    const { repo } = makeMockRepo();
    const now = new Date('2026-05-22T10:00:00Z');
    await acquireBookLock(
      { bookId: 'b', holder: 'h', ttlMinutes: 60 },
      { prisma: { bookLock: repo }, now: () => now },
    );
    const result = await sweepExpiredLocks({
      prisma: { bookLock: repo },
      now: () => now,
    });
    expect(result.deletedCount).toBe(0);
  });

  it('空テーブル → deletedCount=0', async () => {
    const { repo } = makeMockRepo();
    const result = await sweepExpiredLocks({ prisma: { bookLock: repo } });
    expect(result.deletedCount).toBe(0);
  });

  it('info ログに deletedCount と asOf を含める', async () => {
    const { repo } = makeMockRepo();
    const logger = makeLogger();
    const now = new Date('2026-05-22T10:00:00Z');
    await sweepExpiredLocks({
      prisma: { bookLock: repo },
      logger,
      now: () => now,
    });
    expect(logger.infoCalls).toHaveLength(1);
    expect(logger.infoCalls[0]!.payload).toMatchObject({
      deletedCount: 0,
      asOf: '2026-05-22T10:00:00.000Z',
    });
  });
});
