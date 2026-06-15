/**
 * E2E: S-008 新規プロジェクト / 夜間バッチ計画 — T-03-09 / F-010 + F-021.
 *
 * 検証する 8 ケース:
 *   a. /batches/new?theme_ids=... 遷移 → batches-page-shell 可視
 *   b. SelectedThemesList: selected-theme-row-{id} × 3 が表示される
 *   c. ModelAssignmentPreview: 7 役分 (marketer/writer/editor/judge/
 *      thumbnail_text/thumbnail_image/optimizer) の provider/model 行表示
 *   d. CostForecastCard: forecast-total-jpy が "¥XXX" 形式で > 0 を表示
 *   e. "scheduled" モード: BatchScheduleForm 操作 → batch-create-button →
 *      DB: BatchPlan(status='scheduled', planned_at 設定) + 3 BatchPlanItem
 *          (status='pending') + audit_log 1 件 ('batch_plan.create')
 *   f. "now" モード: 別 3 件 theme で kickMode=now → batch-kick-now-button →
 *      DB: BatchPlan(status='running') + 3 Job(kind='pipeline.book.kickoff',
 *          status='queued') + BatchPlanItem.status='kicked' + audit_log 2 件
 *          (batch_plan.create + batch_plan.kick) + graphile_worker._private_jobs
 *          に 3 件 INSERT
 *   g. /batches 一覧表示: 上で作成した 2 件の BatchPlan が batches-table の
 *      batch-plan-row-{id} で表示される
 *   h. empty theme_ids: /batches/new (query 無) → SelectedThemesList の
 *      empty state ("採用済みテーマがありません") 表示 + batch-create-button が disabled
 *
 * 前提:
 *   - storageState は global.setup.ts が認証済みで保存済
 *   - PostgreSQL (Docker a2p-pg port 5433) 稼働中
 *   - 既存 seed の ModelAssignment 7 行 (全 genre=null = default 列) は維持する
 *   - 本 spec で ModelCatalog 3 行を投入 (各 active assignment の provider/model に対応)
 *     ことで forecastBookCostJpy > 0 + canKick=true を担保する
 *   - apps/worker は起動していない (= enqueue 後ジョブは graphile_worker._private_jobs
 *     に滞留する → INSERT 件数を $queryRaw で確認できる)
 *
 * テストデータ:
 *   - 一時 Account 1 件 (pen_name 前方一致 = 'e2e-s008-')
 *   - 6 件 ThemeCandidate (全 status='accepted'):
 *       3 件 → scheduled モードで使用
 *       3 件 → now モードで使用
 *   - 3 件 ModelCatalog (anthropic/claude-opus-4-7, anthropic/claude-sonnet-4-6,
 *     openai/gpt-image-1) — 既存 seed の ModelAssignment と provider/model を一致させ
 *     forecast がヒットするようにする。fx_rate=150 固定
 *
 * クリーンアップ (afterAll):
 *   - 本 spec で投入した ModelCatalog (source = 'e2e-s008-pricing')
 *   - 本 spec で作った BatchPlan / BatchPlanItem (BatchPlan.id を track)
 *   - 本 spec で作った Job (book_id IS NULL && kind='pipeline.book.kickoff' &&
 *     payload_json.batch_plan_item_id が track 済みの BatchPlanItem.id にマッチ)
 *   - 本 spec で書かれた audit_log (target_kind='batch_plan' AND target_id IN
 *     (track 済みの BatchPlan.id))
 *   - graphile_worker._private_jobs から pipeline.book.kickoff を一括削除 (本 spec
 *     由来か区別が難しいが、worker 未起動環境前提なので影響軽微)
 *   - 一時 Account (cascade で ThemeCandidate も削除)
 *
 * コスト: ゼロ (DB 操作 + UI 操作のみ、LLM/外部 API 呼出なし)
 */
import { test, expect, type Page } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';

import { cleanupTransientData, ensureSeededAuthUser } from './fixtures/db';

const E2E_PEN_NAME_PREFIX = 'e2e-s008-';
const E2E_THEME_SESSION_ID = `e2e-s008-session-${Date.now()}`;
const E2E_CATALOG_SOURCE = 'e2e-s008-pricing';

/** seed ModelAssignment と一致する provider/model 3 ペア。fx=150 固定。 */
const CATALOG_SEEDS = [
  {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    input_price_per_mtok_usd: 15.0,
    output_price_per_mtok_usd: 75.0,
    image_price_per_image_usd: null as number | null,
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    input_price_per_mtok_usd: 3.0,
    output_price_per_mtok_usd: 15.0,
    image_price_per_image_usd: null,
  },
  {
    provider: 'openai',
    model: 'gpt-image-1',
    input_price_per_mtok_usd: 0,
    output_price_per_mtok_usd: 0,
    image_price_per_image_usd: 0.04,
  },
];

let accountId = '';
let scheduledThemeIds: string[] = [];
let nowThemeIds: string[] = [];
const createdBatchPlanIds: string[] = [];

// ---------------------------------------------------------------------------
// seed / cleanup helpers
// ---------------------------------------------------------------------------

async function seedCatalog(): Promise<void> {
  for (const r of CATALOG_SEEDS) {
    await prisma.modelCatalog.create({
      data: {
        provider: r.provider,
        model: r.model,
        input_price_per_mtok_usd: r.input_price_per_mtok_usd as unknown as Prisma.Decimal,
        output_price_per_mtok_usd: r.output_price_per_mtok_usd as unknown as Prisma.Decimal,
        image_price_per_image_usd:
          r.image_price_per_image_usd === null
            ? null
            : (r.image_price_per_image_usd as unknown as Prisma.Decimal),
        fx_rate_usd_jpy: 150 as unknown as Prisma.Decimal,
        source: E2E_CATALOG_SOURCE,
        raw_json: {} as unknown as Prisma.InputJsonValue,
        is_current: true,
      },
    });
  }
}

async function seedAccountAndThemes(): Promise<void> {
  const account = await prisma.account.create({
    data: {
      pen_name: `${E2E_PEN_NAME_PREFIX}${Date.now()}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['side_business'],
      } as unknown as Prisma.InputJsonValue,
      status: 'archived', // ダッシュボード一覧に出さない
    },
  });
  accountId = account.id;

  // 6 件作成 (3 → scheduled / 3 → now)
  scheduledThemeIds = [];
  nowThemeIds = [];
  for (let i = 0; i < 6; i++) {
    const row = await prisma.themeCandidate.create({
      data: {
        account_id: accountId,
        theme_session_id: E2E_THEME_SESSION_ID,
        genre: 'business',
        title: `E2E-S008 テーマ ${i + 1}`,
        hook: `差別化要素 ${i + 1}`,
        target_reader: `想定読者 ${i + 1}`,
        competitors_json: [] as unknown as Prisma.InputJsonValue,
        signals_json: {} as unknown as Prisma.InputJsonValue,
        status: 'accepted',
        decided_at: new Date(),
      },
    });
    if (i < 3) scheduledThemeIds.push(row.id);
    else nowThemeIds.push(row.id);
  }
}

async function cleanupS008Data(): Promise<void> {
  // 1. Job: 本 spec が作成した BatchPlanItem 由来の Job を削除
  //    payload_json.batch_plan_item_id が created BatchPlan items に属するもの
  if (createdBatchPlanIds.length > 0) {
    const items = await prisma.batchPlanItem.findMany({
      where: { batch_id: { in: createdBatchPlanIds } },
      select: { id: true },
    });
    if (items.length > 0) {
      for (const it of items) {
        await prisma.job
          .deleteMany({
            where: {
              kind: 'pipeline.book.kickoff',
              payload_json: {
                path: ['batch_plan_item_id'],
                equals: it.id,
              } as never,
            },
          })
          .catch(() => undefined);
      }
    }
  }

  // 2. audit_log: target_kind='batch_plan' AND target_id IN createdBatchPlanIds
  if (createdBatchPlanIds.length > 0) {
    await prisma.auditLog
      .deleteMany({
        where: {
          target_kind: 'batch_plan',
          target_id: { in: createdBatchPlanIds },
        },
      })
      .catch(() => undefined);
  }

  // 3. BatchPlan (cascade → BatchPlanItem)
  if (createdBatchPlanIds.length > 0) {
    await prisma.batchPlan
      .deleteMany({ where: { id: { in: createdBatchPlanIds } } })
      .catch(() => undefined);
  }

  // 4. ModelCatalog (本 spec の source)
  await prisma.modelCatalog
    .deleteMany({ where: { source: E2E_CATALOG_SOURCE } })
    .catch(() => undefined);

  // 5. Account (cascade で ThemeCandidate も削除される)
  await prisma.account
    .deleteMany({ where: { pen_name: { startsWith: E2E_PEN_NAME_PREFIX } } })
    .catch(() => undefined);

  // 6. graphile_worker._private_jobs から pipeline.book.kickoff を削除
  //    (worker 未起動環境前提。本 spec 以外で kickoff を enqueue するテストが
  //     並走しないため、全削除で問題なし)
  await prisma
    .$executeRawUnsafe(
      "DELETE FROM graphile_worker._private_jobs WHERE task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = 'pipeline.book.kickoff')",
    )
    .catch(() => undefined);
}

async function countKickoffJobsInGraphile(): Promise<number> {
  const rows = await prisma
    .$queryRawUnsafe<{ c: bigint }[]>(
      "SELECT count(*)::bigint AS c FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'pipeline.book.kickoff'",
    )
    .catch(() => [] as { c: bigint }[]);
  if (rows.length === 0) return 0;
  return Number(rows[0]!.c);
}

async function gotoBatchesNew(page: Page, themeIds: string[]): Promise<void> {
  const url =
    themeIds.length > 0
      ? `/batches/new?theme_ids=${themeIds.join(',')}`
      : `/batches/new`;
  await page.goto(url);
  await expect(page.getByTestId('batches-page-shell')).toBeVisible();
}

// ---------------------------------------------------------------------------
// spec
// ---------------------------------------------------------------------------

test.describe('S-008: 新規プロジェクト / 夜間バッチ計画 (T-03-09)', () => {
  test.beforeAll(async () => {
    await cleanupTransientData();
    await ensureSeededAuthUser();
    await cleanupS008Data(); // 過去 run の残骸も含めて掃除
    await seedCatalog();
    await seedAccountAndThemes();
  });

  test.afterAll(async () => {
    await cleanupS008Data();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // a. /batches/new?theme_ids=... 遷移
  // -------------------------------------------------------------------------
  test('a. /batches/new?theme_ids=... に直接遷移 → batches-page-shell が可視', async ({
    page,
  }) => {
    await gotoBatchesNew(page, scheduledThemeIds);
    await expect(page.getByTestId('batches-page-shell')).toBeVisible();
    await expect(page.getByTestId('batch-schedule-form')).toBeVisible();
    await expect(page.getByTestId('selected-themes-list')).toBeVisible();
    await expect(page.getByTestId('model-assignment-preview')).toBeVisible();
    await expect(page.getByTestId('cost-forecast-card')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // b. SelectedThemesList: 3 行表示
  // -------------------------------------------------------------------------
  test('b. selected-theme-row-{id} が 3 行表示される', async ({ page }) => {
    await gotoBatchesNew(page, scheduledThemeIds);
    for (const id of scheduledThemeIds) {
      const row = page.getByTestId(`selected-theme-row-${id}`);
      await expect(row).toBeVisible();
    }
  });

  // -------------------------------------------------------------------------
  // c. ModelAssignmentPreview: 7 役分の provider/model 表示
  // -------------------------------------------------------------------------
  test('c. ModelAssignmentPreview に 7 役 (marketer..optimizer) の行が表示される', async ({
    page,
  }) => {
    await gotoBatchesNew(page, scheduledThemeIds);
    const roles = [
      'marketer',
      'writer',
      'editor',
      'judge',
      'thumbnail_text',
      'thumbnail_image',
      'optimizer',
    ];
    for (const role of roles) {
      const row = page.getByTestId(`model-preview-row-${role}`);
      await expect(row).toBeVisible();
    }
    // seed assignment が全 7 役揃っているため "未設定" warning は出ない
    await expect(page.getByTestId('model-preview-missing-warning')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // d. CostForecastCard: forecast-total-jpy が > 0
  // -------------------------------------------------------------------------
  test('d. forecast-total-jpy が "¥XXX" 形式で > 0 を表示する', async ({ page }) => {
    await gotoBatchesNew(page, scheduledThemeIds);
    const total = page.getByTestId('forecast-total-jpy');
    await expect(total).toBeVisible();

    const text = (await total.textContent()) ?? '';
    expect(text).toContain('¥');
    // "¥1,234" や "¥12,345" 等を許容。数字部分のみ抽出してパース
    const digits = text.replace(/[^\d]/g, '');
    expect(digits.length).toBeGreaterThan(0);
    const value = Number(digits);
    expect(value).toBeGreaterThan(0);

    // 警告系は出ていない (catalog 揃っている + assignment 揃っている)
    await expect(page.getByTestId('forecast-missing-catalog-warning')).toHaveCount(0);
    await expect(
      page.getByTestId('forecast-missing-assignment-warning'),
    ).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // e. "scheduled" モード: BatchPlan(scheduled) + 3 items + audit_log 1
  // -------------------------------------------------------------------------
  test('e. scheduled モード: batch-create-button → DB に BatchPlan(scheduled) + 3 items + audit_log', async ({
    page,
  }) => {
    const auditBefore = await prisma.auditLog.count({
      where: { action: 'batch_plan.create' },
    });
    const planCountBefore = await prisma.batchPlan.count();

    await gotoBatchesNew(page, scheduledThemeIds);

    // kickMode='scheduled' に設定 (既定だが明示)
    await page.getByTestId('batch-kick-mode-radio-scheduled').check();
    await expect(
      page.getByTestId('batch-kick-mode-radio-scheduled'),
    ).toBeChecked();

    // plannedAt を 3 日後の 23:00 (ローカル) に設定
    const future = new Date();
    future.setDate(future.getDate() + 3);
    future.setHours(23, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(
      future.getDate(),
    )}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    await page.getByTestId('batch-scheduled-at-input').fill(local);

    // 送信
    await page.getByTestId('batch-create-button').click();

    // 成功すると router.push('/batches') → URL が /batches に遷移する
    await page.waitForURL(/\/batches$/, { timeout: 15_000 });

    // DB 検証 — scheduled BatchPlan を 1 件特定する
    const planCountAfter = await prisma.batchPlan.count();
    expect(planCountAfter - planCountBefore).toBe(1);

    const newPlan = await prisma.batchPlan.findFirst({
      where: { status: 'scheduled' },
      orderBy: { created_at: 'desc' },
      include: { items: true },
    });
    expect(newPlan).not.toBeNull();
    expect(newPlan!.status).toBe('scheduled');
    expect(newPlan!.planned_at).not.toBeNull();
    expect(newPlan!.kicked_at).toBeNull();
    expect(newPlan!.predicted_cost_jpy).toBeGreaterThan(0);
    expect(newPlan!.concurrency).toBe(5);

    // 3 BatchPlanItem (status='pending')
    expect(newPlan!.items.length).toBe(3);
    for (const it of newPlan!.items) {
      expect(it.status).toBe('pending');
      expect(it.theme_id).not.toBeNull();
      expect(scheduledThemeIds).toContain(it.theme_id!);
    }

    // audit_log 1 件追加
    const auditAfter = await prisma.auditLog.count({
      where: { action: 'batch_plan.create' },
    });
    expect(auditAfter - auditBefore).toBe(1);

    // ID を track してクリーンアップ対象にする
    createdBatchPlanIds.push(newPlan!.id);
  });

  // -------------------------------------------------------------------------
  // f. "now" モード: BatchPlan(running) + 3 Jobs + items.kicked + audit_log 2
  // -------------------------------------------------------------------------
  test('f. now モード: batch-kick-now-button → BatchPlan(running) + 3 Jobs + audit_log 2 + graphile-worker INSERT', async ({
    page,
  }) => {
    // 既存 catalog.fetch 等の private_jobs と区別したいので、本テスト中の
    // pipeline.book.kickoff 件数差分のみを観察する
    const graphileBefore = await countKickoffJobsInGraphile();
    const auditCreateBefore = await prisma.auditLog.count({
      where: { action: 'batch_plan.create' },
    });
    const auditKickBefore = await prisma.auditLog.count({
      where: { action: 'batch_plan.kick' },
    });
    const jobBefore = await prisma.job.count({
      where: { kind: 'pipeline.book.kickoff' },
    });

    await gotoBatchesNew(page, nowThemeIds);

    // kickMode='now' に切替
    await page.getByTestId('batch-kick-mode-radio-now').check();
    await expect(page.getByTestId('batch-kick-mode-radio-now')).toBeChecked();

    // batch-kick-now-button (canKick=true 前提)
    const kickButton = page.getByTestId('batch-kick-now-button');
    await expect(kickButton).toBeVisible();
    await expect(kickButton).toBeEnabled();
    await kickButton.click();

    // 成功すると router.push('/dashboard') へ遷移
    await page.waitForURL(/\/dashboard$/, { timeout: 20_000 });

    // DB 検証 — 直近作成の running BatchPlan
    const runningPlan = await prisma.batchPlan.findFirst({
      where: { status: 'running' },
      orderBy: { created_at: 'desc' },
      include: { items: true },
    });
    expect(runningPlan).not.toBeNull();
    expect(runningPlan!.status).toBe('running');
    expect(runningPlan!.kicked_at).not.toBeNull();
    expect(runningPlan!.items.length).toBe(3);

    // 各 item status='kicked'
    for (const it of runningPlan!.items) {
      expect(it.status).toBe('kicked');
      expect(it.theme_id).not.toBeNull();
      expect(nowThemeIds).toContain(it.theme_id!);
    }

    // ID を track してクリーンアップ対象にする (early に append しておく)
    createdBatchPlanIds.push(runningPlan!.id);

    // 内部 Job 行: pipeline.book.kickoff が 3 件追加
    const jobAfter = await prisma.job.count({
      where: { kind: 'pipeline.book.kickoff' },
    });
    expect(jobAfter - jobBefore).toBe(3);

    // 各 Job: status='queued' + payload に batch_plan_item_id が入っている
    const itemIds = runningPlan!.items.map((i) => i.id);
    const jobs = await prisma.job.findMany({
      where: {
        kind: 'pipeline.book.kickoff',
        payload_json: {
          path: ['batch_plan_item_id'],
          string_contains: '',
        } as never,
      },
      orderBy: { created_at: 'desc' },
      take: 10,
    });
    const ourJobs = jobs.filter((j) => {
      const payload = j.payload_json as { batch_plan_item_id?: string };
      return payload?.batch_plan_item_id !== undefined &&
        itemIds.includes(payload.batch_plan_item_id);
    });
    expect(ourJobs.length).toBe(3);
    for (const j of ourJobs) {
      expect(j.status).toBe('queued');
      const payload = j.payload_json as {
        theme_id?: string;
        account_id?: string;
        batch_plan_item_id?: string;
      };
      expect(payload.theme_id).toBeTruthy();
      expect(payload.account_id).toBe(accountId);
      expect(payload.batch_plan_item_id).toBeTruthy();
    }

    // audit_log: batch_plan.create +1, batch_plan.kick +1
    const auditCreateAfter = await prisma.auditLog.count({
      where: { action: 'batch_plan.create' },
    });
    const auditKickAfter = await prisma.auditLog.count({
      where: { action: 'batch_plan.kick' },
    });
    expect(auditCreateAfter - auditCreateBefore).toBe(1);
    expect(auditKickAfter - auditKickBefore).toBe(1);

    // graphile_worker._private_jobs に 3 件追加
    const graphileAfter = await countKickoffJobsInGraphile();
    expect(graphileAfter - graphileBefore).toBeGreaterThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // g. /batches 一覧表示
  // -------------------------------------------------------------------------
  test('g. /batches 一覧画面に作成した BatchPlan が batch-plan-row-{id} で表示される', async ({
    page,
  }) => {
    expect(createdBatchPlanIds.length).toBeGreaterThanOrEqual(2);

    await page.goto('/batches');
    await expect(page.getByTestId('batches-table')).toBeVisible();
    await expect(page.getByTestId('batches-status-summary')).toBeVisible();

    // 直近の 7 件しか表示しないが、e/f で 2 件作っただけなので必ず含まれる
    for (const id of createdBatchPlanIds) {
      const row = page.getByTestId(`batch-plan-row-${id}`);
      await expect(row).toBeVisible();
    }

    // status カウントカード (scheduled / running が 1 ずつ)
    await expect(page.getByTestId('batches-status-scheduled')).toContainText('1');
    await expect(page.getByTestId('batches-status-running')).toContainText('1');
  });

  // -------------------------------------------------------------------------
  // h. empty theme_ids
  // -------------------------------------------------------------------------
  test('h. /batches/new (query 無) → SelectedThemesList が empty state + 送信ボタン disabled', async ({
    page,
  }) => {
    await page.goto('/batches/new');
    await expect(page.getByTestId('batches-page-shell')).toBeVisible();
    await expect(page.getByTestId('selected-themes-list')).toBeVisible();

    // 採用済みテーマがない旨のメッセージ
    await expect(
      page.getByText('採用済みテーマがありません'),
    ).toBeVisible();

    // 送信ボタンは themeCount=0 で disabled
    await expect(page.getByTestId('batch-create-button')).toBeDisabled();
    await expect(page.getByTestId('batch-kick-now-button')).toBeDisabled();
  });
});
