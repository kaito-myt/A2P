/**
 * E2E: S-011 アウトライン承認 UI — T-04-08 / F-007 / F-018.
 *
 * UI 経由のハッピーパス / 差戻しモーダル / disabled 状態を Playwright で検証。
 * outlines-bulk-actions-runtime.spec.ts は SA コア層 (DB) を直接叩く統合検証で
 * UI を介さない。本 spec は **ブラウザ UI 操作 → SA → DB → router.refresh** の
 * フルパスを検証する (T-04-08 受入基準: 「ユーザが /outlines で承認/差戻しを操作
 * できる」).
 *
 * 検証する 4 ケース:
 *   1. ハッピーパス (一括承認):
 *      - DB seed: pending_review な Outline 5 件 (Account/Theme/Book/Outline chain)
 *      - /outlines で outlines-grid + 5 outline-row-{id} が見える
 *      - outlines-select-all チェック → 全選択 → outline-bulk-approve クリック
 *      - SA 成功後 selection clear で action bar が unmount されるため、成功判定は
 *        「rows が grid から消える」+ 「DB 状態が approved」で行う
 *      - DB: Outline.status='approved' × 5 / Book.status='running' × 5 /
 *        Job (kind='pipeline.book.writer.chapters.dispatch') × 5 INSERT
 *   2. 差戻しモーダル (1 件):
 *      - DB seed: pending_review な Outline 1 件
 *      - /outlines → outline-checkbox-{id} → outline-bulk-reject
 *      - outline-reject-dialog 表示 → outline-reject-note 入力 → outline-reject-submit
 *      - SA 成功後ダイアログ閉じ → rows 消失 → DB 検証
 *      - DB: Outline.status='rejected' / reject_note 反映 /
 *        Job (kind='pipeline.book.writer.outline') × 1 INSERT
 *   3. 空 reject_note → outline-reject-submit が disabled (空欄では送信不可)
 *   4. 空 selection → outline-bulk-action-bar 非表示 (selected 0 では描画されない仕様)
 *
 * 注:
 *  - 外部 LLM/API は呼ばれない (graphile-worker が動いていない前提)。enqueue は
 *    Postgres の graphile_worker.jobs テーブルに INSERT されるが、worker process
 *    が稼働していないので消費されない。spec の最後で本 spec 由来の job を deleteMany。
 *  - dev server (Next.js port 3001) は playwright.config の webServer が
 *    reuseExistingServer: true で既存稼働中の `pnpm dev` プロセスを再利用する。
 *  - Postgres は Docker `a2p-pg` port 5433 / .env.local の DATABASE_URL を使う。
 *
 * 仕様根拠:
 *  - docs/02 §F-007 アウトライン承認 UI
 *  - docs/04 §4 S-011 画面設計
 *  - docs/sprints/SP-04 T-04-08
 */
import { test, expect, type Page } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const TEST_PEN_PREFIX = 'e2e-s011-outline-approval';

interface SeededOutline {
  outlineId: string;
  bookId: string;
  title: string;
}

interface SeedContext {
  accountId: string;
  themeId: string;
  outlines: SeededOutline[];
}

/**
 * 本 spec で投入した行を Account の pen_name 前方一致で識別して削除する。
 * Account を消すと cascade で Book / Outline / ThemeCandidate が落ちる。
 * Job は Book FK が SetNull のため、book_id 経由で先に消す。
 */
async function cleanupS011Data(): Promise<void> {
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

  // graphile_worker._private_jobs もテストで投入された分を最小限掃除
  // (raw SQL: payload->>'book_id' で本 spec の bookIds を含む行を削除)
  // 注: graphile-worker v0.16+ では payload は _private_jobs テーブルにある
  if (bookIds.length > 0) {
    for (const bookId of bookIds) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM graphile_worker._private_jobs WHERE payload->>'book_id' = $1`,
          bookId,
        )
        .catch(() => undefined);
    }
  }
}

/**
 * 本 spec 由来の audit_log を target_kind='outline' + actor_id (seed user) で
 * 削除。after_json.outline_ids が本 spec で seed した outline id を含む行を絞り込む。
 */
async function cleanupS011AuditLogs(allOutlineIds: string[]): Promise<void> {
  if (allOutlineIds.length === 0) return;
  // PostgreSQL JSON 演算子で safe に絞るのは難しいので、最近 5 分以内の bulk audit を
  // 取って outline_ids 一致のものだけ id IN で削除する。
  const recent = await prisma.auditLog
    .findMany({
      where: {
        target_kind: 'outline',
        target_id: 'bulk',
        created_at: { gte: new Date(Date.now() - 30 * 60_000) },
      },
      select: { id: true, after_json: true },
    })
    .catch(() => [] as Array<{ id: string; after_json: unknown }>);

  const ourIds = recent
    .filter((r) => {
      const af = r.after_json as { outline_ids?: string[] } | null;
      const ids = af?.outline_ids ?? [];
      return ids.some((id) => allOutlineIds.includes(id));
    })
    .map((r) => r.id);

  if (ourIds.length > 0) {
    await prisma.auditLog
      .deleteMany({ where: { id: { in: ourIds } } })
      .catch(() => undefined);
  }
}

/**
 * 1 Account + 1 ThemeCandidate(accepted) + N Book(queued) + N Outline(pending_review)
 * を作成。Outline.chapters_json は最小ダミー (承認 SA は chapters_json を読まない).
 */
async function seedOutlines(count: number, label: string): Promise<SeedContext> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PEN_PREFIX}-${label}-${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['remote_work'],
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
      title: `S-011 ${label} シナリオ用テーマ`,
      hook: 'e2e test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  const outlines: SeededOutline[] = [];
  for (let i = 0; i < count; i += 1) {
    const title = `S-011 ${label} テスト書籍 #${i + 1}`;
    const book = await prisma.book.create({
      data: {
        account_id: account.id,
        theme_id: theme.id,
        title,
        status: 'queued',
        prompt_version_ids_json: {} as unknown as Prisma.InputJsonValue,
        model_assignment_snapshot: {} as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    const outline = await prisma.outline.create({
      data: {
        book_id: book.id,
        status: 'pending_review',
        chapters_json: [
          {
            index: 1,
            heading: 'はじめに',
            summary: '導入',
            target_chars: 5000,
            subheadings: ['背景', '目的'],
          },
          {
            index: 2,
            heading: '本論',
            summary: '主要トピック',
            target_chars: 5000,
            subheadings: ['ポイント1', 'ポイント2'],
          },
          {
            index: 3,
            heading: 'まとめ',
            summary: '結論',
            target_chars: 4000,
            subheadings: ['結論', '次のステップ'],
          },
        ] as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    outlines.push({ outlineId: outline.id, bookId: book.id, title });
  }

  return { accountId: account.id, themeId: theme.id, outlines };
}

async function gotoOutlinesPage(page: Page): Promise<void> {
  await page.goto('/outlines');
  await page.waitForURL(/\/outlines(\?|$)/);
}

test.describe('S-011: アウトライン承認 UI (T-04-08)', () => {
  // UI 操作 + DB 検証で 60s に拡張
  test.setTimeout(60_000);

  // 全 seed の outline id を accumulator として持ち、後始末で audit_log 掃除に使う
  const allSeededOutlineIds: string[] = [];

  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS011Data();
  });

  test.afterAll(async () => {
    await cleanupS011AuditLogs(allSeededOutlineIds);
    await cleanupS011Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. ハッピーパス: 一括承認 (5 件 → approved + Book.running + Job × 5)
  // -------------------------------------------------------------------------
  test('1. happy path: outlines-select-all → outline-bulk-approve で 5 件 approved + Book.running + Job × 5', async ({
    page,
  }) => {
    const seeded = await seedOutlines(5, 'approve');
    allSeededOutlineIds.push(...seeded.outlines.map((o) => o.outlineId));

    await gotoOutlinesPage(page);

    // ページ shell + grid が見える
    await expect(page.getByTestId('outlines-grid')).toBeVisible();

    // 5 行が見えていることを確認 (他 seed が混ざっても自分の 5 行は確実に居る)
    for (const o of seeded.outlines) {
      const row = page.getByTestId(`outline-row-${o.outlineId}`);
      await expect(row).toBeVisible();
      await expect(page.getByTestId(`outline-title-${o.outlineId}`)).toContainText(
        o.title,
      );
    }

    // selection=0 のときは bulk action bar が描画されない (page-shell 条件分岐)
    await expect(page.getByTestId('outline-bulk-action-bar')).toHaveCount(0);

    // ⚠ outlines-select-all は「現 grid 上の全 pending_review」を選ぶため、本 spec の
    // seed 以外に pending_review な outline が居ると selection 数が膨らみ、approve で
    // 巻き込まれる。beforeAll で cleanupTransientData → cleanupS011Data 済みなので
    // pending_review は本 spec の 5 件のみのはず → 個別 checkbox で 5 件選ぶことで
    // 「seed 由来 5 件だけ approve する」契約を厳格化する。
    for (const o of seeded.outlines) {
      await page.getByTestId(`outline-checkbox-${o.outlineId}`).check();
    }

    // selection count 表示
    await expect(page.getByTestId('outline-bulk-action-bar')).toBeVisible();
    await expect(page.getByTestId('outline-bulk-selection-count')).toContainText(
      '5 件選択中',
    );

    // 一括承認
    await page.getByTestId('outline-bulk-approve').click();

    // SA 成功 → onSelectionClear() で action bar が即 unmount されるため
    // outline-bulk-info は一瞬しか存在しない (= コンポーネント設計上、selection clear で
    // bar が消える)。成功判定は「rows が消える (router.refresh 後 pending_review 0)」+
    // 「DB 状態が approved」で行う。
    for (const o of seeded.outlines) {
      await expect(page.getByTestId(`outline-row-${o.outlineId}`)).toHaveCount(0, {
        timeout: 20_000,
      });
    }

    // --- DB 検証 ----------------------------------------------------------
    const outlineIds = seeded.outlines.map((o) => o.outlineId);
    const bookIds = seeded.outlines.map((o) => o.bookId);

    // Outline: 全件 approved + approved_at 設定 + reject_note null
    const outlines = await prisma.outline.findMany({
      where: { id: { in: outlineIds } },
    });
    expect(outlines).toHaveLength(5);
    for (const o of outlines) {
      expect(o.status).toBe('approved');
      expect(o.approved_at).not.toBeNull();
      expect(o.reject_note).toBeNull();
    }

    // Book: 全件 status='running'
    const books = await prisma.book.findMany({
      where: { id: { in: bookIds } },
    });
    expect(books).toHaveLength(5);
    for (const b of books) {
      expect(b.status).toBe('running');
    }

    // Job: kind='pipeline.book.writer.chapters.dispatch' × 5 INSERT
    const jobs = await prisma.job.findMany({
      where: {
        book_id: { in: bookIds },
        kind: 'pipeline.book.writer.chapters.dispatch',
      },
    });
    expect(jobs).toHaveLength(5);
    const jobBookIds = new Set(jobs.map((j) => j.book_id));
    for (const bid of bookIds) {
      expect(jobBookIds.has(bid)).toBe(true);
    }
    for (const j of jobs) {
      expect(j.status).toBe('queued');
      const payload = j.payload_json as Record<string, unknown>;
      expect(payload.book_id).toBe(j.book_id);
      expect(typeof payload.outline_id).toBe('string');
      expect(outlineIds).toContain(payload.outline_id as string);
    }
  });

  // -------------------------------------------------------------------------
  // 2. 差戻しモーダル: 1 件 reject (status=rejected + reject_note + Job × 1)
  // -------------------------------------------------------------------------
  test('2. reject dialog: 1 件 → outline-reject-dialog → reject_note 送信 → rejected + writer.outline Job', async ({
    page,
  }) => {
    const seeded = await seedOutlines(1, 'reject');
    const target = seeded.outlines[0]!;
    allSeededOutlineIds.push(target.outlineId);

    await gotoOutlinesPage(page);
    await expect(page.getByTestId('outlines-grid')).toBeVisible();

    // 自分の行が見える
    await expect(page.getByTestId(`outline-row-${target.outlineId}`)).toBeVisible();

    // checkbox で 1 件選択
    await page.getByTestId(`outline-checkbox-${target.outlineId}`).check();
    await expect(page.getByTestId('outline-bulk-action-bar')).toBeVisible();
    await expect(page.getByTestId('outline-bulk-selection-count')).toContainText(
      '1 件選択中',
    );

    // 差戻しボタン → ダイアログ表示
    await page.getByTestId('outline-bulk-reject').click();
    await expect(page.getByTestId('outline-reject-dialog')).toBeVisible();

    // 空欄では submit ボタン disabled
    const submitBtn = page.getByTestId('outline-reject-submit');
    await expect(submitBtn).toBeDisabled();

    // reject_note を入力
    const REJECT_NOTE = '章立てが浅いです。もっと具体例を盛り込んでください';
    await page.getByTestId('outline-reject-note').fill(REJECT_NOTE);
    await expect(submitBtn).toBeEnabled();

    // 送信
    await submitBtn.click();

    // SA 成功 → onSelectionClear() で action bar が即 unmount されるため
    // outline-bulk-info は表示されない。成功判定は row 消失 + DB 状態で行う。

    // ダイアログが閉じる
    await expect(page.getByTestId('outline-reject-dialog')).toHaveCount(0, {
      timeout: 15_000,
    });

    // router.refresh 後、rejected になった行は pending_review 一覧から消える
    await expect(page.getByTestId(`outline-row-${target.outlineId}`)).toHaveCount(0, {
      timeout: 20_000,
    });

    // --- DB 検証 ----------------------------------------------------------
    const outline = await prisma.outline.findUnique({
      where: { id: target.outlineId },
    });
    expect(outline).not.toBeNull();
    expect(outline!.status).toBe('rejected');
    expect(outline!.reject_note).toBe(REJECT_NOTE);
    expect(outline!.approved_at).toBeNull();

    // 差戻し時は Book.status を触らない (queued 維持)
    const book = await prisma.book.findUnique({ where: { id: target.bookId } });
    expect(book!.status).toBe('queued');

    // Job: kind='pipeline.book.writer.outline' × 1, payload.reject_note 一致
    const jobs = await prisma.job.findMany({
      where: {
        book_id: target.bookId,
        kind: 'pipeline.book.writer.outline',
      },
    });
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.status).toBe('queued');
    const payload = job.payload_json as Record<string, unknown>;
    expect(payload.book_id).toBe(target.bookId);
    expect(payload.reject_note).toBe(REJECT_NOTE);
  });

  // -------------------------------------------------------------------------
  // 3. 空 reject_note → submit ボタン disabled
  // -------------------------------------------------------------------------
  test('3. validation: 差戻しダイアログを空欄のまま開くと outline-reject-submit が disabled', async ({
    page,
  }) => {
    const seeded = await seedOutlines(1, 'validation');
    const target = seeded.outlines[0]!;
    allSeededOutlineIds.push(target.outlineId);

    await gotoOutlinesPage(page);
    await expect(page.getByTestId('outlines-grid')).toBeVisible();
    await expect(page.getByTestId(`outline-row-${target.outlineId}`)).toBeVisible();

    await page.getByTestId(`outline-checkbox-${target.outlineId}`).check();
    await page.getByTestId('outline-bulk-reject').click();
    await expect(page.getByTestId('outline-reject-dialog')).toBeVisible();

    // 空のまま submit ボタンが disabled
    await expect(page.getByTestId('outline-reject-submit')).toBeDisabled();

    // 半角スペースのみも disabled (trim 後空文字 → component の `note.trim().length === 0`)
    await page.getByTestId('outline-reject-note').fill('   ');
    await expect(page.getByTestId('outline-reject-submit')).toBeDisabled();

    // 文字を入れたら enabled
    await page.getByTestId('outline-reject-note').fill('テストコメント');
    await expect(page.getByTestId('outline-reject-submit')).toBeEnabled();

    // クリア → 再 disabled
    await page.getByTestId('outline-reject-note').fill('');
    await expect(page.getByTestId('outline-reject-submit')).toBeDisabled();

    // キャンセルで閉じる (DB に副作用なし)
    await page.getByTestId('outline-reject-cancel').click();
    await expect(page.getByTestId('outline-reject-dialog')).toHaveCount(0);

    // DB: outline 状態が pending_review のまま
    const outline = await prisma.outline.findUnique({
      where: { id: target.outlineId },
    });
    expect(outline!.status).toBe('pending_review');
    expect(outline!.reject_note).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. 空 selection: outline-bulk-action-bar 非表示
  // -------------------------------------------------------------------------
  test('4. empty selection: 何も選択していないとき outline-bulk-action-bar は描画されない', async ({
    page,
  }) => {
    const seeded = await seedOutlines(2, 'empty-selection');
    allSeededOutlineIds.push(...seeded.outlines.map((o) => o.outlineId));

    await gotoOutlinesPage(page);
    await expect(page.getByTestId('outlines-grid')).toBeVisible();

    // 行は見えている
    for (const o of seeded.outlines) {
      await expect(page.getByTestId(`outline-row-${o.outlineId}`)).toBeVisible();
    }

    // selection 0 → bar 非描画
    await expect(page.getByTestId('outline-bulk-action-bar')).toHaveCount(0);
    // ボタンも当然存在しない
    await expect(page.getByTestId('outline-bulk-approve')).toHaveCount(0);
    await expect(page.getByTestId('outline-bulk-reject')).toHaveCount(0);

    // 1 件選択して bar 出現を確認
    const first = seeded.outlines[0]!;
    await page.getByTestId(`outline-checkbox-${first.outlineId}`).check();
    await expect(page.getByTestId('outline-bulk-action-bar')).toBeVisible();
    await expect(page.getByTestId('outline-bulk-approve')).toBeEnabled();
    await expect(page.getByTestId('outline-bulk-reject')).toBeEnabled();

    // 選択解除ボタンで bar が消える
    await page.getByTestId('outline-bulk-clear').click();
    await expect(page.getByTestId('outline-bulk-action-bar')).toHaveCount(0);
  });
});
