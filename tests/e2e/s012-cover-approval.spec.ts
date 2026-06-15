/**
 * E2E: S-012 サムネ承認 UI -- T-05-10 / F-019.
 *
 * UI 経由のハッピーパス / 単冊比較 / 空状態を Playwright で検証。
 * covers-bulk-actions-runtime.spec.ts は SA コア層 (DB) を直接叩く統合検証で
 * UI を介さない。本 spec は **ブラウザ UI 操作 -> SA -> DB -> router.refresh** の
 * フルパスを検証する (T-05-10 受入基準: 「単冊比較 + バルク一括採用が動作」).
 *
 * 検証する 4 ケース:
 *   1. ページ表示 -- ログイン -> /covers -> thumbnail status の書籍がカバー候補と
 *      ともに表示 (covers-grid / cover-book-card-{id} / cover-image-{id})
 *   2. バルクモード: 一括採用 -- 書籍を選択 -> 「一括採用」-> SA 呼出 -> 成功
 *      (Cover.status='adopted' / 他 cover='rejected' / Job INSERT)
 *   3. 単冊モード: 比較ビュー -- 「個別比較へ」-> covers-comparator 表示、
 *      カバー候補とテキスト案が並ぶ
 *   4. 空状態 -- thumbnail status の書籍がない場合の covers-empty-state 表示
 *
 * 注:
 *  - 外部 LLM/API は呼ばれない (graphile-worker が動いていない前提)。enqueue は
 *    graphile_worker._private_jobs テーブルに INSERT されるが、worker process
 *    が稼働していないので消費されない。spec の最後で本 spec 由来の job を deleteMany。
 *  - dev server (Next.js port 3001) は playwright.config の webServer が
 *    reuseExistingServer: true で既存稼働中の `pnpm dev` プロセスを再利用する。
 *  - Postgres は Docker `a2p-pg` port 5433 / .env.local の DATABASE_URL を使う。
 *
 * 仕様根拠:
 *  - docs/02 F-019 サムネ候補のバルク採用/再生成
 *  - docs/04 S-012 画面設計
 *  - docs/sprints/SP-05 T-05-10
 */
import { test, expect, type Page } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-s012-cover-approval';

// ---------------------------------------------------------------------------
// Seed types
// ---------------------------------------------------------------------------

interface SeededCover {
  coverId: string;
  bookId: string;
  status: string;
}

interface SeededCoverTextProposal {
  proposalId: string;
  bookId: string;
  title: string;
}

interface SeededBook {
  bookId: string;
  title: string;
  covers: SeededCover[];
  coverTextProposals: SeededCoverTextProposal[];
}

interface SeedContext {
  accountId: string;
  themeId: string;
  books: SeededBook[];
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Account pen_name prefix で本 spec 由来の行を識別して削除。
 * Account cascade => Book => Cover / CoverTextProposal も消える。
 * Job は Book FK が SetNull のため book_id 経由で先に消す。
 */
async function cleanupS012Data(): Promise<void> {
  const accounts = await prisma.account.findMany({
    where: { pen_name: { startsWith: TEST_PEN_PREFIX } },
    select: { id: true },
  });
  if (accounts.length === 0) return;
  const accountIds = accounts.map((a) => a.id);

  const books = await prisma.book.findMany({
    where: { account_id: { in: accountIds } },
    select: { id: true },
  });
  const bookIds = books.map((b) => b.id);

  if (bookIds.length > 0) {
    await prisma.job
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
    await prisma.bookLock
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
    // graphile_worker._private_jobs
    for (const bookId of bookIds) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM graphile_worker._private_jobs WHERE payload->>'book_id' = $1`,
          bookId,
        )
        .catch(() => undefined);
    }
  }

  await prisma.account
    .deleteMany({ where: { id: { in: accountIds } } })
    .catch(() => undefined);
}

/**
 * 本 spec 由来の audit_log を掃除。
 */
async function cleanupS012AuditLogs(allCoverIds: string[]): Promise<void> {
  if (allCoverIds.length === 0) return;
  const recent = await prisma.auditLog
    .findMany({
      where: {
        target_kind: 'cover',
        target_id: 'bulk',
        created_at: { gte: new Date(Date.now() - 30 * 60_000) },
      },
      select: { id: true, after_json: true },
    })
    .catch(() => [] as Array<{ id: string; after_json: unknown }>);

  const ourIds = recent
    .filter((r) => {
      const af = r.after_json as { adopted_cover_ids?: string[] } | null;
      const ids = af?.adopted_cover_ids ?? [];
      return ids.some((id) => allCoverIds.includes(id));
    })
    .map((r) => r.id);

  if (ourIds.length > 0) {
    await prisma.auditLog
      .deleteMany({ where: { id: { in: ourIds } } })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * 1 Account + 1 Theme(accepted) + N Book(thumbnail) + per-book M Cover(generated)
 * + per-book K CoverTextProposal(proposed) を作成。
 */
async function seedCoversData(
  label: string,
  bookSpecs: Array<{
    title: string;
    coverCount: number;
    coverTextCount: number;
  }>,
): Promise<SeedContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${label}-${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['test'],
      } as unknown as Prisma.InputJsonValue,
      status: 'archived',
    },
    select: { id: true },
  });

  const theme = await prisma.themeCandidate.create({
    data: {
      account_id: account.id,
      theme_session_id: `${TEST_PEN_PREFIX}-${label}-session-${Date.now()}`,
      genre: 'business',
      title: `S-012 ${label} テスト用テーマ`,
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const books: SeededBook[] = [];

  for (const spec of bookSpecs) {
    const book = await prisma.book.create({
      data: {
        account_id: account.id,
        theme_id: theme.id,
        title: spec.title,
        status: 'thumbnail',
        prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
        model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    const covers: SeededCover[] = [];
    for (let i = 0; i < spec.coverCount; i++) {
      const cover = await prisma.cover.create({
        data: {
          book_id: book.id,
          r2_key: `test/covers/${book.id}/cover-${i}.png`,
          prompt_used: `テスト用プロンプト ${i}`,
          width: 1600,
          height: 2560,
          status: 'generated',
          generation_meta_json: {
            provider: 'openai',
            model: 'gpt-image-1',
            cost_jpy: 8,
          },
        },
        select: { id: true },
      });
      covers.push({
        coverId: cover.id,
        bookId: book.id,
        status: 'generated',
      });
    }

    const coverTextProposals: SeededCoverTextProposal[] = [];
    for (let i = 0; i < spec.coverTextCount; i++) {
      const proposal = await prisma.coverTextProposal.create({
        data: {
          book_id: book.id,
          title: `${spec.title} テキスト案 #${i + 1}`,
          subtitle: i % 2 === 0 ? `サブタイトル #${i + 1}` : null,
          band_copy: i === 0 ? '帯文テスト' : null,
          status: 'proposed',
        },
        select: { id: true, title: true },
      });
      coverTextProposals.push({
        proposalId: proposal.id,
        bookId: book.id,
        title: proposal.title,
      });
    }

    books.push({
      bookId: book.id,
      title: spec.title,
      covers,
      coverTextProposals,
    });
  }

  return { accountId: account.id, themeId: theme.id, books };
}

async function gotoCoversPage(page: Page): Promise<void> {
  await page.goto('/covers');
  await page.waitForURL(/\/covers(\?|$)/);
}

// ===========================================================================
// Test suite
// ===========================================================================

test.describe('S-012: サムネ承認 UI (T-05-10, F-019)', () => {
  test.setTimeout(60_000);

  const allSeededCoverIds: string[] = [];

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS012Data();
  });

  test.afterAll(async () => {
    await cleanupS012AuditLogs(allSeededCoverIds);
    await cleanupS012Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. ページ表示: /covers -> thumbnail status の書籍がカバー候補とともに表示
  // -------------------------------------------------------------------------
  test('1. ページ表示: covers-grid に thumbnail 書籍 + cover-image が表示される', async ({
    page,
  }) => {
    const seeded = await seedCoversData('display', [
      { title: 'S-012 表示テスト書籍 #1', coverCount: 3, coverTextCount: 2 },
      { title: 'S-012 表示テスト書籍 #2', coverCount: 2, coverTextCount: 1 },
    ]);
    for (const b of seeded.books) {
      allSeededCoverIds.push(...b.covers.map((c) => c.coverId));
    }

    await gotoCoversPage(page);

    // covers-grid が表示される
    await expect(page.getByTestId('covers-grid')).toBeVisible();

    // covers-summary がある
    await expect(page.getByTestId('covers-summary')).toBeVisible();

    // 各書籍の card が表示される
    for (const b of seeded.books) {
      const card = page.getByTestId(`cover-book-card-${b.bookId}`);
      await expect(card).toBeVisible();

      // card 内のカバー画像が表示される
      for (const c of b.covers) {
        await expect(page.getByTestId(`cover-image-${c.coverId}`)).toBeVisible();
      }
    }

    // covers-empty-state は表示されない
    await expect(page.getByTestId('covers-empty-state')).toHaveCount(0);

    // mode toggle が表示される
    await expect(page.getByTestId('covers-mode-toggle')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 2. バルクモード: 一括採用
  //    書籍を選択 -> 「一括採用」-> SA 成功 -> Cover adopted / 他 rejected / Job INSERT
  // -------------------------------------------------------------------------
  test('2. バルクモード: 一括採用 -- covers-select-all -> cover-bulk-adopt -> Cover adopted + Job INSERT', async ({
    page,
  }) => {
    const seeded = await seedCoversData('bulk-adopt', [
      { title: 'S-012 一括採用テスト #1', coverCount: 3, coverTextCount: 0 },
      { title: 'S-012 一括採用テスト #2', coverCount: 2, coverTextCount: 0 },
    ]);
    for (const b of seeded.books) {
      allSeededCoverIds.push(...b.covers.map((c) => c.coverId));
    }

    await gotoCoversPage(page);
    await expect(page.getByTestId('covers-grid')).toBeVisible();

    // 書籍 cards が見える
    for (const b of seeded.books) {
      await expect(
        page.getByTestId(`cover-book-card-${b.bookId}`),
      ).toBeVisible();
    }

    // selection=0 のときは bulk action bar 非表示
    await expect(page.getByTestId('cover-bulk-action-bar')).toHaveCount(0);

    // 個別 checkbox で 2 冊とも選択
    for (const b of seeded.books) {
      await page.getByTestId(`cover-book-checkbox-${b.bookId}`).check();
    }

    // selection count 表示
    await expect(page.getByTestId('cover-bulk-action-bar')).toBeVisible();
    await expect(
      page.getByTestId('cover-bulk-selection-count'),
    ).toContainText('2 件選択中');

    // 一括採用ボタンクリック
    await page.getByTestId('cover-bulk-adopt').click();

    // SA 成功後 -> selection clear -> action bar unmount -> rows が消える
    // (router.refresh 後 thumbnail status の book は covers ページから消える
    //  ...ただし Book.status は 'thumbnail' のまま。covers ページは Book.status='thumbnail'
    //  で取得しているが、Cover が全部 adopted/rejected になると covers 自体は消えない。
    //  実際には cover-book-card は残るが cover の status 表示が変わる)
    // 正確には: bulkAdoptCovers は Book.status を変更しないため、router.refresh 後も
    // card は残る。ただし selection がクリアされ action bar が消える。
    //
    // 待ち条件: action bar が消える (= selection clear 成功)
    await expect(page.getByTestId('cover-bulk-action-bar')).toHaveCount(0, {
      timeout: 20_000,
    });

    // --- DB 検証 ---
    const book1 = seeded.books[0]!;
    const book2 = seeded.books[1]!;

    // pickEligibleCoverIds は「各 book の最初の generated cover」を1つ選ぶ
    // -> book1 covers[0], book2 covers[0] が adopted になるはず
    const adoptedCoverId1 = book1.covers[0]!.coverId;
    const adoptedCoverId2 = book2.covers[0]!.coverId;

    // Cover: 採用対象 (各 book の最初の generated) -> adopted
    const adoptedCovers = await prisma.cover.findMany({
      where: { id: { in: [adoptedCoverId1, adoptedCoverId2] } },
    });
    expect(adoptedCovers).toHaveLength(2);
    for (const c of adoptedCovers) {
      expect(c.status).toBe('adopted');
    }

    // Cover: 同 book の他 cover -> rejected
    const otherCoverIds1 = book1.covers.slice(1).map((c) => c.coverId);
    const otherCoverIds2 = book2.covers.slice(1).map((c) => c.coverId);
    const otherCovers = await prisma.cover.findMany({
      where: { id: { in: [...otherCoverIds1, ...otherCoverIds2] } },
    });
    for (const c of otherCovers) {
      expect(c.status).toBe('rejected');
    }

    // Job: kind='pipeline.book.export' x 2 (1 per book)
    const jobs = await prisma.job.findMany({
      where: {
        book_id: { in: [book1.bookId, book2.bookId] },
        kind: 'pipeline.book.export',
      },
    });
    expect(jobs).toHaveLength(2);
    const jobBookIds = new Set(jobs.map((j) => j.book_id));
    expect(jobBookIds.has(book1.bookId)).toBe(true);
    expect(jobBookIds.has(book2.bookId)).toBe(true);
    for (const j of jobs) {
      expect(j.status).toBe('queued');
    }
  });

  // -------------------------------------------------------------------------
  // 3. 単冊モード: 比較ビュー
  //    「個別比較へ」-> covers-comparator 表示 + カバー候補 + テキスト案
  // -------------------------------------------------------------------------
  test('3. 単冊モード: 個別比較へ -> covers-comparator にカバー候補とテキスト案が表示', async ({
    page,
  }) => {
    const seeded = await seedCoversData('single', [
      { title: 'S-012 単冊比較テスト', coverCount: 3, coverTextCount: 2 },
    ]);
    const book = seeded.books[0]!;
    allSeededCoverIds.push(...book.covers.map((c) => c.coverId));

    await gotoCoversPage(page);
    await expect(page.getByTestId('covers-grid')).toBeVisible();

    // card が見える
    await expect(
      page.getByTestId(`cover-book-card-${book.bookId}`),
    ).toBeVisible();

    // 「個別比較へ」リンクをクリック
    await page.getByTestId(`cover-compare-${book.bookId}`).click();

    // covers-comparator が表示される
    await expect(page.getByTestId('covers-comparator')).toBeVisible();

    // covers-grid は非表示 (mode toggle で切り替わる)
    await expect(page.getByTestId('covers-grid')).toHaveCount(0);

    // 各 cover の comparator image card が表示される
    for (const c of book.covers) {
      await expect(
        page.getByTestId(`cover-comparator-image-${c.coverId}`),
      ).toBeVisible();

      // 各 cover に adopt ボタンが表示される (generated status)
      await expect(
        page.getByTestId(`cover-comparator-adopt-${c.coverId}`),
      ).toBeVisible();
    }

    // CoverTextProposals が表示される
    await expect(page.getByTestId('cover-text-proposals')).toBeVisible();
    for (const tp of book.coverTextProposals) {
      await expect(
        page.getByTestId(`cover-text-proposal-${tp.proposalId}`),
      ).toBeVisible();
    }

    // navigation ボタンが表示される
    await expect(page.getByTestId('covers-back-to-list')).toBeVisible();

    // 「一覧に戻る」で covers-grid に戻る
    await page.getByTestId('covers-back-to-list').click();
    await expect(page.getByTestId('covers-grid')).toBeVisible();
    await expect(page.getByTestId('covers-comparator')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 4. 空状態: thumbnail status の書籍がない場合の空メッセージ
  // -------------------------------------------------------------------------
  test('4. 空状態: thumbnail status 書籍が 0 件のとき covers-empty-state が表示される', async ({
    page,
  }) => {
    // この時点で cleanupTransientData + cleanupS012Data 済み
    // 前のテストで seed した Book は status='thumbnail' のまま残る可能性があるので
    // 明示的にクリーンアップ
    await cleanupS012Data();

    await gotoCoversPage(page);

    // covers-empty-state が表示される
    await expect(page.getByTestId('covers-empty-state')).toBeVisible();

    // covers-grid は表示されない
    await expect(page.getByTestId('covers-grid')).toHaveCount(0);

    // CTA リンクが表示される
    await expect(page.getByTestId('covers-empty-cta')).toBeVisible();
  });
});
