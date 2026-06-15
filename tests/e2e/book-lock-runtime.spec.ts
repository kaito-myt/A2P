/**
 * Runtime verification spec for T-02-07 — BookLock acquire/release/sweep
 *
 * SP-02 段階では BookLock を実際に使う pipeline (Marketer/Writer/...) はまだ
 * 配線されていないので、通常の Playwright (ブラウザ操作 → DOM 検証) では
 * docs/05 §14 #4 の排他制御セマンティクスを検証できない。代わりに以下を
 * Node ランタイム上で実 PostgreSQL に対して直接呼び出して検証する:
 *
 *   1. 一時 Account → Book を Prisma で作成 (BookLock.book_id は実テーブル参照
 *      ではないが、運用整合のため実 book_id を使う)
 *   2. acquireBookLock / releaseBookLock / sweepExpiredLocks を直接呼出
 *   3. 並列 5 race / 同一 holder release / 他 holder release / sweep の
 *      期限切れ判定など 6 シナリオを実 DB で検証
 *      → mock では再現しきれない PostgreSQL Unique constraint の真の挙動を確認
 *   4. クリーンアップ: 一時 BookLock + Book + Account を deleteMany
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner
 *     として借用し、@a2p/db / @a2p/agents を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (DATABASE_URL) が前提。
 *
 * コスト: ゼロ (DB のみ、LLM/外部 API 呼出なし)
 *
 * T-02-05 で「mock では PASS だが実 DB で FAIL」のバグ (NULLS FIRST) を踏んだ
 * 経緯あり。BookLock は真の concurrency 排他を扱うため、実 PostgreSQL での
 * race condition 検証が特に重要 (transaction race は mock 不可能)。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import {
  acquireBookLock,
  releaseBookLock,
  sweepExpiredLocks,
} from '@a2p/agents';
import { ConflictError } from '@a2p/contracts/errors';

const TEST_TAG = 't-02-07-runtime-test';

test.describe('runtime: BookLock acquire/release/sweep (T-02-07)', () => {
  // DB I/O + 並列 5 race + sweep の確認で 30s では不安全
  test.setTimeout(60_000);

  let accountId: string;
  let bookId: string;
  // 別 book で sweep のセットアップを行うため
  let bookIdForSweep: string;

  test.beforeAll(async () => {
    // 一時 Account を作成 (Book FK 用)
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-booklock-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'practical',
          ratio: { practical: 1 },
          focus_themes: [],
        },
        status: 'archived', // ダッシュボードに出さない
      },
    });
    accountId = account.id;

    // 一時 Book を作成。BookLock.book_id は FK 制約は持たないが
    // (schema 上は @id のみ)、実運用と同じ形式 (cuid) で扱うため Book を立てる。
    const book = await prisma.book.create({
      data: {
        account_id: accountId,
        title: `e2e booklock primary ${TEST_TAG}`,
        prompt_version_ids_json: {},
        model_assignment_snapshot: {},
      },
    });
    bookId = book.id;

    const bookSweep = await prisma.book.create({
      data: {
        account_id: accountId,
        title: `e2e booklock sweep ${TEST_TAG}`,
        prompt_version_ids_json: {},
        model_assignment_snapshot: {},
      },
    });
    bookIdForSweep = bookSweep.id;

    // 既に同 book_id の lock が残っていないことを確実にしておく
    await prisma.bookLock.deleteMany({
      where: { book_id: { in: [bookId, bookIdForSweep] } },
    });
  });

  test.afterAll(async () => {
    // 順序: book_locks → books → account
    if (bookId || bookIdForSweep) {
      const ids = [bookId, bookIdForSweep].filter(Boolean);
      await prisma.bookLock
        .deleteMany({ where: { book_id: { in: ids } } })
        .catch(() => undefined);
    }
    if (accountId) {
      // Book は Account 削除で onDelete: Cascade されるが念のため明示
      await prisma.book
        .deleteMany({ where: { account_id: accountId } })
        .catch(() => undefined);
      await prisma.account
        .delete({ where: { id: accountId } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  test.beforeEach(async () => {
    // 各テストで前回の lock を必ず除去する (テスト間の独立性確保)
    await prisma.bookLock.deleteMany({
      where: { book_id: { in: [bookId, bookIdForSweep] } },
    });
  });

  // -------------------------------------------------------------------------
  // a. 並列 5 acquire で 1 つだけ成功
  // -------------------------------------------------------------------------
  test('a. 並列 5 acquire (同一 book) → 1 つだけ成功、4 つは ConflictError', async () => {
    // 5 並列 acquire を一斉に発火。PostgreSQL の UNIQUE 制約 (BookLock.book_id PK)
    // により、INSERT の race は 1 件 commit + 4 件 P2002 となる。
    const results = await Promise.allSettled([
      acquireBookLock({ bookId, holder: 'race:1' }),
      acquireBookLock({ bookId, holder: 'race:2' }),
      acquireBookLock({ bookId, holder: 'race:3' }),
      acquireBookLock({ bookId, holder: 'race:4' }),
      acquireBookLock({ bookId, holder: 'race:5' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    // 4 つの reject は全て ConflictError 化されているはず
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(ConflictError);
      const ce = reason as ConflictError;
      const details = ce.details as Record<string, unknown>;
      expect(details).toMatchObject({
        reason: 'book_locked',
        bookId,
      });
      // existingHolder は勝者 holder のいずれかであることを確認
      expect(details.existingHolder).toMatch(/^race:[1-5]$/);
    }

    // DB に 1 行だけ存在する
    const rows = await prisma.bookLock.findMany({ where: { book_id: bookId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.holder).toMatch(/^race:[1-5]$/);
  });

  // -------------------------------------------------------------------------
  // b. 同一 holder の release 成功 → 再 acquire 可
  // -------------------------------------------------------------------------
  test('b. alice acquire → alice release → 再 acquire 成功', async () => {
    const rec1 = await acquireBookLock({ bookId, holder: 'alice' });
    expect(rec1.book_id).toBe(bookId);
    expect(rec1.holder).toBe('alice');

    await releaseBookLock({ bookId, holder: 'alice' });

    const rowsAfterRelease = await prisma.bookLock.findMany({
      where: { book_id: bookId },
    });
    expect(rowsAfterRelease).toHaveLength(0);

    // 再 acquire は成功する (他 holder でも可)
    const rec2 = await acquireBookLock({ bookId, holder: 'alice-again' });
    expect(rec2.holder).toBe('alice-again');
  });

  // -------------------------------------------------------------------------
  // c. 他 holder の release 弾き
  // -------------------------------------------------------------------------
  test('c. alice acquire → bob release (no-op) → bob acquire は ConflictError', async () => {
    await acquireBookLock({ bookId, holder: 'alice' });

    // bob による release は throw せず warn ログのみ (誤呼び出しでパイプライン
    // failed させない運用上の譲歩)。
    await releaseBookLock({ bookId, holder: 'bob' });

    // DB には alice の lock がまだ残っているはず
    const rows = await prisma.bookLock.findMany({ where: { book_id: bookId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.holder).toBe('alice');

    // bob の acquire は ConflictError (alice が holder)
    let threw: unknown;
    try {
      await acquireBookLock({ bookId, holder: 'bob' });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(ConflictError);
    const details = (threw as ConflictError).details as Record<string, unknown>;
    expect(details.existingHolder).toBe('alice');
    expect(details.requestedHolder).toBe('bob');
  });

  // -------------------------------------------------------------------------
  // d. sweep が期限切れのみ削除
  // -------------------------------------------------------------------------
  test('d. sweepExpiredLocks → 期限切れのみ削除、未来は残す', async () => {
    // 過去 expires_at の lock を直接 INSERT (helper の TTL=1 分でも今は未来になりがち)
    const past = new Date(Date.now() - 60_000); // 1 分前
    const future = new Date(Date.now() + 60 * 60_000); // 60 分後

    await prisma.bookLock.create({
      data: {
        book_id: bookId,
        holder: 'expired-holder',
        acquired_at: new Date(Date.now() - 2 * 60_000),
        expires_at: past,
      },
    });
    await prisma.bookLock.create({
      data: {
        book_id: bookIdForSweep,
        holder: 'alive-holder',
        expires_at: future,
      },
    });

    const beforeCount = await prisma.bookLock.count({
      where: { book_id: { in: [bookId, bookIdForSweep] } },
    });
    expect(beforeCount).toBe(2);

    const result = await sweepExpiredLocks();
    // 他テストの残骸が混在する可能性は beforeEach で排除済みだが、
    // 念のため期限切れ削除数は >= 1 (本テストの 1 行) であることを確認
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);

    // 期限切れの行は消滅、未来の行は残る
    const remaining = await prisma.bookLock.findMany({
      where: { book_id: { in: [bookId, bookIdForSweep] } },
      orderBy: { book_id: 'asc' },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.book_id).toBe(bookIdForSweep);
    expect(remaining[0]!.holder).toBe('alive-holder');
  });

  // -------------------------------------------------------------------------
  // e. acquire は期限切れ判定を持たない
  // -------------------------------------------------------------------------
  test('e. 期限切れ lock 残存中の acquire → ConflictError (acquire は sweep を内包しない)', async () => {
    // 期限切れ lock を直接 INSERT
    await prisma.bookLock.create({
      data: {
        book_id: bookId,
        holder: 'dead-holder',
        acquired_at: new Date(Date.now() - 2 * 60 * 60_000),
        expires_at: new Date(Date.now() - 60_000), // 1 分前 = 既に期限切れ
      },
    });

    // sweep を挟まずに acquire を試行 → ConflictError
    // 設計判断: acquire 側は副作用 (削除) を持たない。死んだ lock の掃除は
    // cron `0 * * * *` の sweepExpiredLocks 専任 (docs/05 §14 #4 / OQ-D-05)。
    let threw: unknown;
    try {
      await acquireBookLock({ bookId, holder: 'new-holder' });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(ConflictError);
    const details = (threw as ConflictError).details as Record<string, unknown>;
    expect(details.existingHolder).toBe('dead-holder');
    // existingExpiresAt は ISO 文字列で過去
    expect(typeof details.existingExpiresAt).toBe('string');
    expect(new Date(details.existingExpiresAt as string).getTime()).toBeLessThan(
      Date.now(),
    );
  });

  // -------------------------------------------------------------------------
  // f. sweep 後の再 acquire 成功
  // -------------------------------------------------------------------------
  test('f. 期限切れ lock → sweep → 再 acquire 成功', async () => {
    // 期限切れ lock を仕込む
    await prisma.bookLock.create({
      data: {
        book_id: bookId,
        holder: 'dead-holder',
        acquired_at: new Date(Date.now() - 2 * 60 * 60_000),
        expires_at: new Date(Date.now() - 60_000),
      },
    });

    // sweep
    const swept = await sweepExpiredLocks();
    expect(swept.deletedCount).toBeGreaterThanOrEqual(1);

    // 同じ book_id で別 holder の acquire が成功する
    const rec = await acquireBookLock({ bookId, holder: 'fresh-holder' });
    expect(rec.book_id).toBe(bookId);
    expect(rec.holder).toBe('fresh-holder');
    // expires_at は今から +30 分 (TTL 既定) ぐらいに入っている
    const ttlMs = rec.expires_at.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(25 * 60_000);
    expect(ttlMs).toBeLessThan(35 * 60_000);
  });
});
