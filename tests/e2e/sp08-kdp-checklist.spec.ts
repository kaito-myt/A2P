/**
 * E2E: S-015 KDP 入稿チェックリスト — T-08-03 / F-020/F-040/F-049.
 *
 * 検証する 3 つのメインシナリオ:
 *   1. ページ表示 — ログイン → /kdp/checklist → 入稿対象書籍 3 冊が表示、タブ、テーブル
 *   2. コピー・チェック操作 → チェックボックス ON / コピー操作 → 状態が更新される (updateChecklist SA)
 *   3. ブロックシナリオ — 1 冊に must コメント → ブロック表示 + submit ボタン disabled
 *   4. リロード後の状態保持 — checklist_state_json から復元
 *   5. KDP 新規タブ開くリンク検証 — href="https://kdp.amazon.co.jp/bookshelf"
 *
 * 注:
 *  - 外部 LLM/API は呼ばない（表示 + 状態管理のみ）。
 *  - dev server (Next.js port 3001) は playwright.config の webServer で再利用。
 *  - Postgres は Docker a2p-pg port 5433 / .env.local の DATABASE_URL。
 *
 * 仕様根拠:
 *  - docs/02 F-020 (KDP 入稿チェックリスト) / F-040 (KDP メタデータ) / F-049 (コメント)
 *  - docs/04 S-015
 *  - docs/05 §5.3.8 (シーケンス)
 *  - docs/sprints/SP-08 T-08-03
 */

import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import type { Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-sp08-kdp-checklist';

// ---------------------------------------------------------------------------
// Seed types
// ---------------------------------------------------------------------------

interface SeededBook {
  bookId: string;
  title: string;
  subtitle: string;
  status: string;
  metadataId?: string;
}

interface SeedContext {
  accountId: string;
  books: SeededBook[];
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Account pen_name prefix で本 spec 由来の行を識別して削除。
 * Account cascade => Book / KdpSubmissionProgress 消える。
 * graphile_worker._private_jobs (foreign_key) / Job は book_id FK が SetNull なため先に消す。
 * KdpSubmissionProgress は Book に紐付く (book_id)。
 */
async function cleanupS015Data(): Promise<void> {
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
    // Job cascade delete (graphile_worker._private_jobs も消える)
    await prisma.job
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
    // BookLock
    await prisma.bookLock
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
    // KdpSubmissionProgress
    await prisma.kdpSubmissionProgress
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);
  }

  // Account cascade
  await prisma.account
    .deleteMany({ where: { id: { in: accountIds } } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * 1 Account + 3 Books (done ステータス) を作成。
 * 各 Book に:
 *  - KdpMetadata (メタデータあり)
 *  - Cover (adopted status)
 *  - KdpSubmissionProgress (checklist_state_json は空で初期化)
 *  - RevisionComment (第 2 冊のみ must/pending コメント付き)
 */
async function seedKdpChecklistBooks(label: string): Promise<SeedContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${label}-${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['remote_work'],
      } as unknown as Prisma.InputJsonValue,
    },
  });

  const books: SeededBook[] = [];

  // Book 1: メタデータあり、コメントなし
  const book1 = await prisma.book.create({
    data: {
      account_id: account.id,
      title: '副業 × AI で月 5 万円稼ぐ実践ガイド',
      subtitle: '初心者でも今日から始められる',
      status: 'done',
      done_at: new Date(),
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      kdpMetadata: {
        create: {
          description: 'テスト用の紹介文です。本書は副業を始めたい方に最適です。',
          categories: ['ビジネス・経済 > 個人投資・副業', 'コンピュータ・IT > 人工知能'],
          keywords: ['副業', 'AI', 'ChatGPT', '月5万', '実践', '初心者', 'ガイド'],
          price_jpy: 499,
        },
      },
      covers: {
        create: {
          status: 'adopted',
          r2_key: 'covers/book1/v1.png',
          prompt_used: 'テスト用プロンプト',
          width: 1600,
          height: 2560,
          generation_meta_json: { provider: 'openai', model: 'gpt-image-1', cost_jpy: 10 } as unknown as Prisma.InputJsonValue,
        },
      },
      kdpSubmissionProgress: {
        create: {
          checklist_state_json: {},
        },
      },
    },
  });
  books.push({
    bookId: book1.id,
    title: book1.title,
    subtitle: book1.subtitle,
    status: book1.status,
    metadataId: book1.kdp_metadata_id ?? undefined,
  });

  // Book 2: メタデータあり、must/pending コメント 1 件 (ブロック)
  const book2 = await prisma.book.create({
    data: {
      account_id: account.id,
      title: 'Python 初心者から 3 ヶ月で実務レベルへ',
      subtitle: 'Web スクレイピング実践ハンドブック',
      status: 'done',
      done_at: new Date(),
      has_blocking_comments: true,
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      kdpMetadata: {
        create: {
          description: 'テスト用の紹介文 2。Web スクレイピングの実践手法を解説します。',
          categories: ['コンピュータ・IT > プログラミング言語 > Python', 'コンピュータ・IT > 雑誌 > Web'],
          keywords: ['Python', 'スクレイピング', '初心者', '実践', 'Web', '自動化', '効率化'],
          price_jpy: 699,
        },
      },
      covers: {
        create: {
          status: 'adopted',
          r2_key: 'covers/book2/v1.png',
          prompt_used: 'テスト用プロンプト',
          width: 1600,
          height: 2560,
          generation_meta_json: { provider: 'openai', model: 'gpt-image-1', cost_jpy: 10 } as unknown as Prisma.InputJsonValue,
        },
      },
      kdpSubmissionProgress: {
        create: {
          checklist_state_json: {},
        },
      },
      revisionComments: {
        create: {
          body: '第 3 章の実装例を修正してください',
          priority: 'must',
          status: 'pending',
          target_kind: 'chapter',
          target_id: 'chapter_1',
          created_by: 'test-user',
        },
      },
    },
  });
  books.push({
    bookId: book2.id,
    title: book2.title,
    subtitle: book2.subtitle,
    status: book2.status,
    metadataId: book2.kdp_metadata_id ?? undefined,
  });

  // Book 3: メタデータあり、コメントなし
  const book3 = await prisma.book.create({
    data: {
      account_id: account.id,
      title: '月 10 万円の副業でセミリタイアメント',
      subtitle: '自動化ビジネスの仕組み作り',
      status: 'done',
      done_at: new Date(),
      prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      kdpMetadata: {
        create: {
          description: 'テスト用の紹介文 3。セミリタイアメント達成の方法論を紹介。',
          categories: ['ビジネス・経済 > 起業・副業 > 副業', 'ビジネス・経済 > 人生設計・生涯教育'],
          keywords: ['副業', 'セミリタイア', '自動化', 'ビジネス', '月10万', '不労所得', '仕組み'],
          price_jpy: 599,
        },
      },
      covers: {
        create: {
          status: 'adopted',
          r2_key: 'covers/book3/v1.png',
          prompt_used: 'テスト用プロンプト',
          width: 1600,
          height: 2560,
          generation_meta_json: { provider: 'openai', model: 'gpt-image-1', cost_jpy: 10 } as unknown as Prisma.InputJsonValue,
        },
      },
      kdpSubmissionProgress: {
        create: {
          checklist_state_json: {},
        },
      },
    },
  });
  books.push({
    bookId: book3.id,
    title: book3.title,
    subtitle: book3.subtitle,
    status: book3.status,
    metadataId: book3.kdp_metadata_id ?? undefined,
  });

  return { accountId: account.id, books };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('S-015 KDP 入稿チェックリスト', () => {
  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
  });

  test.afterAll(async () => {
    await cleanupS015Data();
  });

  test('1. ページ表示 — 3 冊の入稿対象書籍が表示される', async ({ page }) => {
    const seed = await seedKdpChecklistBooks('page-display');

    await page.goto('/kdp/checklist');

    // ページ要素が表示される
    await expect(page.locator('[data-testid="kdp-checklist-page"]')).toBeVisible();

    // 3 冊が一覧 (カード) で表示
    for (const book of seed.books) {
      const item = page.locator(`[data-testid="checklist-list-item-${book.bookId}"]`);
      await expect(item).toBeVisible();
      await expect(item).toContainText(book.title);
    }

    // 「KDP を新規タブで開く」リンク存在
    const kdpLink = page.locator('[data-testid="kdp-open-link"]');
    await expect(kdpLink).toBeVisible();
    expect(await kdpLink.getAttribute('href')).toBe('https://kdp.amazon.co.jp/bookshelf');
    expect(await kdpLink.getAttribute('target')).toBe('_blank');

    // クリックで詳細に遷移し、チェックリストテーブルが表示される
    await page.locator(`[data-testid="checklist-list-item-${seed.books[0]!.bookId}"]`).click();
    await expect(page.locator('[data-testid="submission-checklist-table"]')).toBeVisible();
  });

  test('2. コピー・チェック操作 — チェックボックス状態と persistent 状態が更新される', async ({ page }) => {
    const seed = await seedKdpChecklistBooks('copy-check-ops');

    await page.goto('/kdp/checklist');

    // Book 1 の詳細へ遷移
    await page.locator(`[data-testid="checklist-list-item-${seed.books[0]!.bookId}"]`).click();

    // title フィールドのチェックボックスを確認
    const titleCheckbox = page.locator('[data-testid="checkbox-title"]');
    await expect(titleCheckbox).not.toBeChecked();

    // チェックボックスをクリック
    await titleCheckbox.click();

    // チェック状態が ON になることを待つ
    await expect(titleCheckbox).toBeChecked({ timeout: 5000 });

    // 状態は Client state で更新 + SA (updateChecklist) が呼ばれる
    const titleRow = page.locator('[data-testid="field-row-title"]');
    await expect(titleRow).toHaveClass(/bg-success-bg/);

    // (リロード後の状態保持は T-08-03 仕様 §6 で定義、
    // ここでは即座の UI 更新を検証)
  });

  test('3. ブロック表示 — must コメント残時に ブロック理由バナーが表示、submit ボタン disabled', async ({
    page,
  }) => {
    const seed = await seedKdpChecklistBooks('block-display');
    const blockedBook = seed.books[1]!; // Book 2 = has_blocking_comments=true

    await page.goto('/kdp/checklist');

    // 一覧で Book 2 (ブロック済み) のカードに blocked バッジが出る
    const book2Item = page.locator(`[data-testid="checklist-list-item-${blockedBook.bookId}"]`);
    await expect(book2Item).toContainText(/blocked:|ブロック/i);

    // 詳細へ遷移
    await book2Item.click();

    // ブロック理由バナーが表示される
    const blockBanner = page.locator('[data-testid="block-reason-banner"]');
    await expect(blockBanner).toBeVisible();

    // バナー内に must コメントが表示される（最低 1 件）
    await expect(blockBanner).toContainText(/コメント|修正|確認/);

    // submit ボタンは常に disabled (Phase 3 機能)
    const submitButton = page.locator('[data-testid="submit-to-kdp-btn"]');
    await expect(submitButton).toBeDisabled();
  });

  test('4. 複数冊の独立性 — Book 1 詳細でチェック、Book 2 は未チェック、再訪で保持', async ({ page }) => {
    const seed = await seedKdpChecklistBooks('multi-book-switch');
    const book1Id = seed.books[0]!.bookId;
    const book2Id = seed.books[1]!.bookId;

    // Book 1 詳細で title をチェック
    await page.goto(`/kdp/checklist/${book1Id}`);
    const titleCheckbox1 = page.locator('[data-testid="checkbox-title"]');
    await titleCheckbox1.click();
    await expect(titleCheckbox1).toBeChecked();

    // Book 2 詳細では未チェック (状態分離)
    await page.goto(`/kdp/checklist/${book2Id}`);
    const titleCheckbox2 = page.locator('[data-testid="checkbox-title"]');
    await expect(titleCheckbox2).not.toBeChecked();

    // Book 1 に戻ると DB から復元されチェック状態が保持されている
    await page.goto(`/kdp/checklist/${book1Id}`);
    await expect(page.locator('[data-testid="checkbox-title"]')).toBeChecked();
  });

  test('5. メタデータ欠落時の表示 — メタデータなし書籍は「未生成」メッセージ', async ({ page }) => {
    // Book without KdpMetadata
    const account = await prisma.account.create({
      data: {
        pen_name: `${TEST_PEN_PREFIX}-no-meta-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const bookNoMeta = await prisma.book.create({
      data: {
        account_id: account.id,
        title: 'メタデータなし書籍',
        subtitle: 'テスト用',
        status: 'done',
        done_at: new Date(),
        prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
        model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
        kdpSubmissionProgress: {
          create: {
            checklist_state_json: {},
          },
        },
      },
    });

    // 詳細ページでメタデータ未生成メッセージが表示される
    await page.goto(`/kdp/checklist/${bookNoMeta.id}`);
    const metaMissingState = page.locator('[data-testid="metadata-missing-state"]');
    await expect(metaMissingState).toBeVisible();

    // Cleanup
    await prisma.kdpSubmissionProgress.deleteMany({ where: { book_id: bookNoMeta.id } });
    await prisma.book.deleteMany({ where: { id: bookNoMeta.id } });
    await prisma.account.deleteMany({ where: { id: account.id } });
  });
});
