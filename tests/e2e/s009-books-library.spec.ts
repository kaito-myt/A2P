/**
 * E2E: S-009 書籍ライブラリ + ダウンロード — T-05-11.
 *
 * 書籍ライブラリ画面 (/books) の表示・フィルタ・ダウンロードリンク・空状態を検証。
 *
 * 検証する 5 ケース:
 *   1. ページ表示: ログイン → /books → BooksTable + 書籍行が表示される
 *   2. ステータスフィルタ: フィルタドロップダウンで特定ステータスを選択 → テーブルが絞り込まれる
 *   3. ダウンロードリンク: Artifact がある書籍で docx/pdf/png のダウンロードリンク表示
 *   4. 空状態: 書籍がない場合の空メッセージ表示
 *   5. 書籍詳細リンク: 書籍行の詳細リンク → /books/[id] に遷移
 *
 * 注:
 *  - 外部 LLM/API は呼ばない (表示系のみの検証)。
 *  - dev server (Next.js port 3001) は playwright.config の webServer が
 *    reuseExistingServer: true で既存稼働中プロセスを再利用する。
 *  - Postgres は Docker a2p-pg port 5433。
 *  - R2 ダウンロード RH はテストしにくい (署名付き URL 先が存在しない) ので
 *    リンクの href 存在確認のみ行う。
 *
 * 仕様根拠:
 *  - docs/02 F-015 R2 永続化 (ダウンロード)
 *  - docs/02 F-039 書籍ライブラリ (準備)
 *  - docs/04 S-009 書籍ライブラリ画面
 *  - docs/sprints/SP-05 T-05-11
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-s009-books-library';

// ---------------------------------------------------------------------------
// Seed types
// ---------------------------------------------------------------------------

interface SeededBook {
  bookId: string;
  title: string;
  status: string;
  artifactIds: { id: string; kind: string }[];
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
 * Account cascade => Book => Artifact も消える。
 * Job は Book FK が SetNull のため book_id 経由で先に消す。
 */
async function cleanupS009Data(): Promise<void> {
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
  }

  await prisma.account
    .deleteMany({ where: { id: { in: accountIds } } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * 1 Account + 1 Theme + N Books (各 status 指定可) + per-book artifacts を作成。
 */
async function seedBooksLibrary(
  label: string,
  bookSpecs: Array<{
    title: string;
    status: string;
    artifacts?: Array<{ kind: string }>;
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
      title: `S-009 ${label} テスト用テーマ`,
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
        status: spec.status,
        prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
        model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    const artifactIds: { id: string; kind: string }[] = [];
    if (spec.artifacts) {
      for (const art of spec.artifacts) {
        const artifact = await prisma.artifact.create({
          data: {
            book_id: book.id,
            kind: art.kind,
            r2_key: `test/artifacts/${book.id}/${art.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            byte_size: 1024,
            checksum: 'e2e-test-checksum-' + Date.now(),
          },
          select: { id: true },
        });
        artifactIds.push({ id: artifact.id, kind: art.kind });
      }
    }

    books.push({
      bookId: book.id,
      title: spec.title,
      status: spec.status,
      artifactIds,
    });
  }

  return { accountId: account.id, themeId: theme.id, books };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('S-009: 書籍ライブラリ + ダウンロード (T-05-11)', () => {
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS009Data();
  });

  test.afterAll(async () => {
    await cleanupS009Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. ページ表示 — /books で BooksTable + 書籍行が表示される
  // -------------------------------------------------------------------------
  test('1. ページ表示: /books で BooksTable に書籍行が表示される', async ({
    page,
  }) => {
    const seeded = await seedBooksLibrary('display', [
      { title: 'S-009 表示テスト書籍A', status: 'done' },
      { title: 'S-009 表示テスト書籍B', status: 'running' },
    ]);

    await page.goto('/books');
    await page.waitForURL(/\/books(\?|$)/);

    // books-library-page が見える
    await expect(page.getByTestId('books-library-page')).toBeVisible();

    // BooksTable が表示される
    await expect(page.getByTestId('books-table')).toBeVisible();

    // フィルタバーが表示される
    await expect(page.getByTestId('books-filter-bar')).toBeVisible();

    // 件数表示
    await expect(page.getByTestId('books-total-count')).toBeVisible();

    // パンくずリストが見える
    const breadcrumb = page.locator('nav[aria-label="breadcrumb"]');
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toContainText('ホーム');
    await expect(breadcrumb).toContainText('書籍ライブラリ');

    // 各書籍行が表示される
    for (const b of seeded.books) {
      const row = page.getByTestId(`book-row-${b.bookId}`);
      await expect(row).toBeVisible();

      // タイトルリンクが表示される
      const titleLink = page.getByTestId(`book-title-${b.bookId}`);
      await expect(titleLink).toBeVisible();
      await expect(titleLink).toContainText(b.title);
    }

    // ステータスバッジが見える (done -> 完了, running -> 実行中)
    const bookA = seeded.books[0]!;
    const bookB = seeded.books[1]!;
    const rowA = page.getByTestId(`book-row-${bookA.bookId}`);
    const rowB = page.getByTestId(`book-row-${bookB.bookId}`);
    await expect(rowA.getByTestId('book-status-badge-done')).toBeVisible();
    await expect(rowB.getByTestId('book-status-badge-running')).toBeVisible();

    // 空状態メッセージは表示されない
    await expect(page.getByTestId('books-empty-state')).toHaveCount(0);

    // 新規プロジェクト CTA が表示される
    await expect(page.getByTestId('new-project-cta')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 2. ステータスフィルタ — フィルタドロップダウンでテーブルが絞り込まれる
  // -------------------------------------------------------------------------
  test('2. ステータスフィルタ: ドロップダウンで絞り込みが動作する', async ({
    page,
  }) => {
    // 前テストで seed されたデータを掃除し、本テストで seed した 3 冊だけにする
    await cleanupS009Data();
    await cleanupTransientData();

    const seeded = await seedBooksLibrary('filter', [
      { title: 'S-009 フィルタ完了本', status: 'done' },
      { title: 'S-009 フィルタ実行中本', status: 'running' },
      { title: 'S-009 フィルタ待機中本', status: 'queued' },
    ]);

    await page.goto('/books');
    await expect(page.getByTestId('books-table')).toBeVisible();

    // 初期状態: すべて表示
    for (const b of seeded.books) {
      await expect(page.getByTestId(`book-row-${b.bookId}`)).toBeVisible();
    }

    // 件数が 3 冊
    await expect(page.getByTestId('books-total-count')).toContainText('3');

    // done でフィルタ
    const filterSelect = page.getByTestId('books-status-filter');
    await filterSelect.selectOption('done');

    // done の本だけ表示される
    const doneBook = seeded.books.find((b) => b.status === 'done')!;
    const runningBook = seeded.books.find((b) => b.status === 'running')!;
    const queuedBook = seeded.books.find((b) => b.status === 'queued')!;

    await expect(page.getByTestId(`book-row-${doneBook.bookId}`)).toBeVisible();
    await expect(
      page.getByTestId(`book-row-${runningBook.bookId}`),
    ).toHaveCount(0);
    await expect(
      page.getByTestId(`book-row-${queuedBook.bookId}`),
    ).toHaveCount(0);

    // 件数が 1 に更新
    await expect(page.getByTestId('books-total-count')).toContainText('1');

    // running でフィルタ
    await filterSelect.selectOption('running');
    await expect(
      page.getByTestId(`book-row-${runningBook.bookId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`book-row-${doneBook.bookId}`),
    ).toHaveCount(0);

    // all に戻す
    await filterSelect.selectOption('all');
    for (const b of seeded.books) {
      await expect(page.getByTestId(`book-row-${b.bookId}`)).toBeVisible();
    }
    await expect(page.getByTestId('books-total-count')).toContainText('3');
  });

  // -------------------------------------------------------------------------
  // 3. ダウンロードリンク — Artifact がある書籍で docx/pdf/png リンクが表示
  // -------------------------------------------------------------------------
  test('3. ダウンロードリンク: Artifact がある書籍で docx/pdf/png リンクが表示される', async ({
    page,
  }) => {
    const seeded = await seedBooksLibrary('download', [
      {
        title: 'S-009 DL テスト全種本',
        status: 'done',
        artifacts: [
          { kind: 'docx' },
          { kind: 'pdf' },
          { kind: 'png_cover' },
        ],
      },
      {
        title: 'S-009 DL テスト docx のみ',
        status: 'done',
        artifacts: [{ kind: 'docx' }],
      },
      {
        title: 'S-009 DL テスト成果物なし',
        status: 'queued',
        // No artifacts
      },
    ]);

    await page.goto('/books');
    await expect(page.getByTestId('books-table')).toBeVisible();

    // --- 全種アーティファクトの書籍 ---
    const fullBook = seeded.books[0]!;
    const fullRow = page.getByTestId(`book-row-${fullBook.bookId}`);
    await expect(fullRow).toBeVisible();

    // artifact-download-group が見える
    await expect(
      fullRow.getByTestId('artifact-download-group'),
    ).toBeVisible();

    // docx, pdf, png のリンクが存在する
    const docxArtifact = fullBook.artifactIds.find((a) => a.kind === 'docx')!;
    const pdfArtifact = fullBook.artifactIds.find((a) => a.kind === 'pdf')!;
    const pngArtifact = fullBook.artifactIds.find(
      (a) => a.kind === 'png_cover',
    )!;

    const docxLink = fullRow.getByTestId('artifact-link-docx');
    const pdfLink = fullRow.getByTestId('artifact-link-pdf');
    const pngLink = fullRow.getByTestId('artifact-link-png_cover');

    await expect(docxLink).toBeVisible();
    await expect(pdfLink).toBeVisible();
    await expect(pngLink).toBeVisible();

    // href が正しいパスを指している
    await expect(docxLink).toHaveAttribute(
      'href',
      `/api/artifacts/${docxArtifact.id}/download`,
    );
    await expect(pdfLink).toHaveAttribute(
      'href',
      `/api/artifacts/${pdfArtifact.id}/download`,
    );
    await expect(pngLink).toHaveAttribute(
      'href',
      `/api/artifacts/${pngArtifact.id}/download`,
    );

    // --- docx のみの書籍 ---
    const docxOnlyBook = seeded.books[1]!;
    const docxOnlyRow = page.getByTestId(`book-row-${docxOnlyBook.bookId}`);
    await expect(docxOnlyRow).toBeVisible();

    // docx リンクあり
    await expect(
      docxOnlyRow.getByTestId('artifact-link-docx'),
    ).toBeVisible();
    // pdf, png は disabled 表示 (リンクではなくテキスト)
    await expect(
      docxOnlyRow.getByTestId('artifact-link-pdf-disabled'),
    ).toBeVisible();
    await expect(
      docxOnlyRow.getByTestId('artifact-link-png_cover-disabled'),
    ).toBeVisible();

    // --- 成果物なしの書籍 ---
    const noArtBook = seeded.books[2]!;
    const noArtRow = page.getByTestId(`book-row-${noArtBook.bookId}`);
    await expect(noArtRow).toBeVisible();

    // artifact-download-group は表示されない (成果物なしテキストが出る)
    await expect(
      noArtRow.getByTestId('artifact-download-group'),
    ).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 4. 空状態 — 書籍がない場合の空メッセージ表示
  // -------------------------------------------------------------------------
  test('4. 空状態: 書籍が 0 件のとき books-empty-state が表示される', async ({
    page,
  }) => {
    // 前テストで seed されたデータを掃除 (cleanupTransientData は全体を消す)
    await cleanupS009Data();
    // 他 spec で seed されたデータも消えるように cleanupTransientData
    await cleanupTransientData();

    await page.goto('/books');
    await page.waitForURL(/\/books(\?|$)/);

    // 空状態メッセージが表示される
    await expect(page.getByTestId('books-empty-state')).toBeVisible();
    await expect(page.getByTestId('books-empty-state')).toContainText(
      '最初の本を作成しましょう',
    );

    // BooksTable は表示されない
    await expect(page.getByTestId('books-table')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 5. 書籍詳細リンク — 詳細リンクで /books/[id] に遷移
  // -------------------------------------------------------------------------
  test('5. 書籍詳細リンク: 詳細リンクをクリックで /books/[id] に遷移する', async ({
    page,
  }) => {
    const seeded = await seedBooksLibrary('detail-link', [
      { title: 'S-009 詳細遷移テスト本', status: 'done' },
    ]);

    await page.goto('/books');
    await expect(page.getByTestId('books-table')).toBeVisible();

    const book = seeded.books[0]!;

    // 詳細リンクが見える
    const detailLink = page.getByTestId(`book-detail-link-${book.bookId}`);
    await expect(detailLink).toBeVisible();

    // タイトルリンクも /books/[id] に遷移可能
    const titleLink = page.getByTestId(`book-title-${book.bookId}`);
    await expect(titleLink).toHaveAttribute('href', `/books/${book.bookId}`);

    // 詳細リンクをクリックして遷移
    await detailLink.click();
    await page.waitForURL(new RegExp(`/books/${book.bookId}`));

    // 書籍詳細ページが表示される
    await expect(page.getByTestId('book-detail-page')).toBeVisible();
  });
});
