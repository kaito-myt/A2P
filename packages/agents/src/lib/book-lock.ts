/**
 * docs/05 §14 #4 / OQ-D-05 / T-02-07 — 書籍単位の排他制御 (`BookLock`) ヘルパ。
 *
 * 用途:
 *  - `pipeline.book.*` / `revision.book.apply` / `kdp.submit` が書籍書き込みに入る前に取得し、
 *    終了時に解放する。
 *  - `expires_at` 超過の死んだロックは `sweepExpiredLocks()` が cron で掃除する。
 *
 * 同時性モデル:
 *  - `BookLock.book_id` は主キーなので、同一 book に対する 2 並列 INSERT のうち
 *    後着は PostgreSQL の Unique constraint violation で失敗する。Prisma はこれを
 *    `PrismaClientKnownRequestError` (`code='P2002'`) で throw する。
 *  - 本ヘルパはそれを補足して `ConflictError('book_locked', ...)` に正規化する。
 *  - 取得自体は **期限切れ判定をしない**。死んでいるロックが残ったまま再取得は失敗する。
 *    死んだロックの掃除は専ら `sweepExpiredLocks()` (cron `0 * * * *`) の責務 (docs/05 §14 #4)。
 *
 * release は **同一 holder のみ**:
 *  - `revision_run:r1` が取った lock を `pipeline:p2` が解放できると `book_locks` の意味を失う。
 *  - 他 holder からの release 試行は warn ログだけ出して継続 (誤呼び出しでパイプラインを
 *    failed させない、運用上の譲歩)。
 */
import { ConflictError } from '@a2p/contracts/errors';
import { prisma as defaultPrisma } from '@a2p/db';

// ---------------------------------------------------------------------------
// 型定義 — Prisma の `BookLock` モデルを最小サーフェスで写像
// ---------------------------------------------------------------------------

export interface BookLockRecord {
  book_id: string;
  holder: string;
  acquired_at: Date;
  expires_at: Date;
}

/**
 * Prisma の `BookLockDelegate` を最小サブセットで型化。実 PrismaClient はこのインタフェース
 * を構造的に満たすため、DI で差し替えても any キャストを必要としない。
 */
export interface BookLockRepo {
  create(args: {
    data: {
      book_id: string;
      holder: string;
      acquired_at?: Date;
      expires_at: Date;
    };
  }): Promise<BookLockRecord>;
  findUnique(args: {
    where: { book_id: string };
  }): Promise<BookLockRecord | null>;
  deleteMany(args: {
    where:
      | { book_id: string; holder: string }
      | { expires_at: { lt: Date } };
  }): Promise<{ count: number }>;
}

export interface BookLockLogger {
  info: (payload: Record<string, unknown>, msg?: string) => void;
  warn: (payload: Record<string, unknown>, msg?: string) => void;
}

export interface BookLockDeps {
  prisma?: { bookLock: BookLockRepo };
  logger?: BookLockLogger;
  /** テストで「now」を固定するためのフック。本番は `new Date()` で十分。 */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// 内部ヘルパ
// ---------------------------------------------------------------------------

/** Prisma の Unique constraint violation を判定。`PrismaClientKnownRequestError` (`code='P2002'`)。 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; name?: unknown };
  return e.code === 'P2002';
}

const noopLogger: BookLockLogger = {
  info: () => {},
  warn: () => {},
};

function getRepo(deps: BookLockDeps): BookLockRepo {
  return (
    deps.prisma?.bookLock ??
    (defaultPrisma as unknown as { bookLock: BookLockRepo }).bookLock
  );
}

function getLogger(deps: BookLockDeps): BookLockLogger {
  return deps.logger ?? noopLogger;
}

// ---------------------------------------------------------------------------
// acquireBookLock
// ---------------------------------------------------------------------------

export interface AcquireBookLockArgs {
  bookId: string;
  /** docs/05 §3 BookLock.holder 規約: `"pipeline:<job_id>" | "revision_run:<id>" | "kdp_submit:<job_id>"`。 */
  holder: string;
  /** TTL (分)。docs/05 §3 の既定 +30 分と整合 (タスクタイムアウトと合わせる)。 */
  ttlMinutes?: number;
}

/**
 * `BookLock` を 1 件 INSERT する。既存ロックがあれば `ConflictError` を throw。
 *
 * @throws ConflictError code=`conflict`, details に既存 holder と expires_at を含める
 */
export async function acquireBookLock(
  args: AcquireBookLockArgs,
  deps: BookLockDeps = {},
): Promise<BookLockRecord> {
  const { bookId, holder } = args;
  const ttlMinutes = args.ttlMinutes ?? 30;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new ConflictError('ttlMinutes は 1 以上の有限数である必要があります', {
      details: { bookId, holder, ttlMinutes },
    });
  }
  const repo = getRepo(deps);
  const log = getLogger(deps);
  const now = (deps.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

  try {
    const created = await repo.create({
      data: {
        book_id: bookId,
        holder,
        acquired_at: now,
        expires_at: expiresAt,
      },
    });
    log.info(
      { bookId, holder, expiresAt: expiresAt.toISOString(), ttlMinutes },
      'book lock acquired',
    );
    return created;
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;

    // 衝突: 既存行を読み出して呼出元に存在情報を返す。findUnique 自体が失敗しても
    // ConflictError の発火は維持する (details 欠落のみ)。
    let existingHolder: string | undefined;
    let existingExpiresAt: string | undefined;
    try {
      const existing = await repo.findUnique({ where: { book_id: bookId } });
      if (existing) {
        existingHolder = existing.holder;
        existingExpiresAt = existing.expires_at.toISOString();
      }
    } catch (lookupErr) {
      log.warn(
        { err: lookupErr, bookId },
        'failed to read existing BookLock after conflict',
      );
    }

    throw new ConflictError(
      `BookLock conflict: book_id=${bookId} already held by ${existingHolder ?? 'unknown'}`,
      {
        userMessage: 'この書籍は別の処理中のため操作できません',
        details: {
          reason: 'book_locked',
          bookId,
          requestedHolder: holder,
          existingHolder,
          existingExpiresAt,
        },
        cause: err,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// releaseBookLock
// ---------------------------------------------------------------------------

export interface ReleaseBookLockArgs {
  bookId: string;
  holder: string;
}

/**
 * 指定 holder の `BookLock` を 1 件削除する。`holder` 不一致 / 既に解放済の場合は warn ログのみで
 * 続行 (誤呼び出しでパイプラインを failed させない)。
 */
export async function releaseBookLock(
  args: ReleaseBookLockArgs,
  deps: BookLockDeps = {},
): Promise<void> {
  const { bookId, holder } = args;
  const repo = getRepo(deps);
  const log = getLogger(deps);

  const result = await repo.deleteMany({
    where: { book_id: bookId, holder },
  });
  if (result.count === 0) {
    log.warn(
      { bookId, holder },
      'releaseBookLock: no row deleted (already released or held by another holder)',
    );
    return;
  }
  log.info({ bookId, holder, deleted: result.count }, 'book lock released');
}

// ---------------------------------------------------------------------------
// sweepExpiredLocks
// ---------------------------------------------------------------------------

export interface SweepResult {
  deletedCount: number;
}

/**
 * `expires_at < now()` の `BookLock` を一括削除する。cron `0 * * * *` から呼ばれる
 * (apps/worker/src/tasks/locks-sweep.ts)。
 *
 * 死んだロックを残すと acquire が永久に conflict するため、運用上の安全弁となる
 * (docs/05 OQ-D-05 で「必要なら alert.cost.check と同 cron で掃除」と明記された運用要件)。
 */
export async function sweepExpiredLocks(
  deps: BookLockDeps = {},
): Promise<SweepResult> {
  const repo = getRepo(deps);
  const log = getLogger(deps);
  const now = (deps.now ?? (() => new Date()))();

  const result = await repo.deleteMany({
    where: { expires_at: { lt: now } },
  });
  log.info(
    { deletedCount: result.count, asOf: now.toISOString() },
    'expired book locks swept',
  );
  return { deletedCount: result.count };
}
