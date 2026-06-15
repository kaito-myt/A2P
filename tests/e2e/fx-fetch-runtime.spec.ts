/**
 * Runtime verification spec for T-02-08 — fx.fetch + AppSettings.latest_fx_rate
 *
 * SP-02 段階では fx.fetch を呼び出す UI 画面 (Settings 画面の為替表示等) はまだ
 * 配線されていない (T-02-08 のスコープは Worker タスク + DB スキーマ + cron 登録)。
 * 通常の Playwright (ブラウザ操作 → DOM 検証) では fx.fetch の docs/05 §5.3.13
 * セマンティクスを検証できない。代わりに以下を Node ランタイム上で実 PostgreSQL +
 * 実 open.er-api.com に対して直接呼び出して検証する:
 *
 *   1. 初期 latest_fx_rate を snapshot
 *   2. runFxFetch を実 API で実行 → result.ok === true, rate ∈ [100, 250]
 *   3. AppSettings.latest_fx_rate が 100〜250 範囲の Decimal で更新済を確認
 *   4. 失敗パス: 不正 apiUrl で runFxFetch → result.ok === false
 *      → Alert に kind='fx_fetch_failed' が INSERT
 *   5. クリーンアップ: latest_fx_rate を初期値に戻し、テスト用 Alert を deleteMany
 *   6. Worker cron 登録確認: buildTaskList() (21 件 — docs/05 §2 の 19 件 +
 *      locks.sweep [SP-02 T-02-07] + pipeline.theme.generate [SP-03 T-03-06]) /
 *      buildParsedCronItems() (4 件 cron, うち fx-fetch-daily が含まれること)
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner
 *     として借用し、@a2p/db / apps/worker のタスクを直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (DATABASE_URL, FX_RATE_API_URL) が前提。
 *
 * インターネット接続必須 (open.er-api.com への HTTP fetch)。
 * コスト: ゼロ (無料無認証 API)。
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';
import {
  FX_FETCH_TASK_NAME,
  runFxFetch,
} from '../../apps/worker/src/tasks/fx-fetch.js';
import {
  buildTaskList,
  // buildParsedCronItems は startRunner からは export されていないので crontab.ts を直接 import
} from '../../apps/worker/src/runner.js';
import {
  buildParsedCronItems,
  CRON_ITEMS,
} from '../../apps/worker/src/crontab.js';

const TEST_ALERT_TAG_URL = 'https://invalid.example.invalid/fx-fetch-e2e-test';

test.describe('runtime: fx.fetch + AppSettings.latest_fx_rate (T-02-08)', () => {
  // 実 HTTP fetch + DB I/O が走るため 60s
  test.setTimeout(60_000);

  let initialRate: Prisma.Decimal | null = null;

  test.beforeAll(async () => {
    // singleton AppSettings の初期値を保存 (afterAll で復元)
    const current = await prisma.appSettings.findUnique({
      where: { id: 'singleton' },
    });
    expect(current).not.toBeNull();
    initialRate = current!.latest_fx_rate ?? null;

    // 検証直前に念のため null へリセット (新規 fetch を強制)
    await prisma.appSettings.update({
      where: { id: 'singleton' },
      data: { latest_fx_rate: null },
    });

    // テスト中に挿入される失敗 Alert が前回残骸と衝突しないよう先に掃除
    await prisma.alert
      .deleteMany({
        where: {
          kind: 'fx_fetch_failed',
          payload_json: { path: ['api_url'], equals: TEST_ALERT_TAG_URL },
        },
      })
      .catch(() => undefined);
  });

  test.afterAll(async () => {
    // 失敗パスで挿入したテスト用 Alert を掃除
    await prisma.alert
      .deleteMany({
        where: {
          kind: 'fx_fetch_failed',
          payload_json: { path: ['api_url'], equals: TEST_ALERT_TAG_URL },
        },
      })
      .catch(() => undefined);

    // latest_fx_rate を元値に戻す (テスト前のクリーン状態へ)
    await prisma.appSettings
      .update({
        where: { id: 'singleton' },
        data: { latest_fx_rate: initialRate },
      })
      .catch(() => undefined);

    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. 成功パス: 実 API + 実 DB
  // -------------------------------------------------------------------------
  test('success: open.er-api.com から USD/JPY 取得 → latest_fx_rate が 100〜250 で更新', async () => {
    const result = await runFxFetch({
      // env FX_RATE_API_URL を尊重 (.env.local 既定は open.er-api.com/v6/latest/USD)
    });

    expect(result.ok).toBe(true);
    expect(result.rate).not.toBeNull();
    // USD/JPY の常識的レンジ (歴史的に 75〜160 程度。安全幅をとって 100〜250)
    expect(result.rate!).toBeGreaterThan(100);
    expect(result.rate!).toBeLessThan(250);
    // apiUpdatedAt は最近 (過去 48h 以内) のはず
    expect(result.apiUpdatedAt).not.toBeNull();
    const ageSeconds = Math.floor(Date.now() / 1000) - result.apiUpdatedAt!;
    expect(ageSeconds).toBeGreaterThan(-300); // 多少のクロックずれ許容
    expect(ageSeconds).toBeLessThan(48 * 60 * 60);

    // DB に書き戻されている
    const row = await prisma.appSettings.findUnique({ where: { id: 'singleton' } });
    expect(row).not.toBeNull();
    expect(row!.latest_fx_rate).not.toBeNull();
    const rateStr = row!.latest_fx_rate!.toString();
    const rateNum = Number(rateStr);
    expect(Number.isFinite(rateNum)).toBe(true);
    expect(rateNum).toBeGreaterThan(100);
    expect(rateNum).toBeLessThan(250);
    // Decimal(10,4) なので小数点以下最大 4 桁
    expect(rateStr).toMatch(/^\d+(\.\d{1,4})?$/);
  });

  // -------------------------------------------------------------------------
  // 2. 失敗パス: 不正 apiUrl → Alert(fx_fetch_failed) を INSERT、appSettings 不変
  // -------------------------------------------------------------------------
  test('failure: 不正 apiUrl → ok=false, latest_fx_rate 据え置き, Alert(fx_fetch_failed) INSERT', async () => {
    // 直前の成功テストで入った値を snapshot
    const before = await prisma.appSettings.findUnique({ where: { id: 'singleton' } });
    const beforeRate = before!.latest_fx_rate;

    const result = await runFxFetch({
      apiUrl: TEST_ALERT_TAG_URL,
    });

    expect(result.ok).toBe(false);
    expect(result.rate).toBeNull();

    // latest_fx_rate は据え置き
    const after = await prisma.appSettings.findUnique({ where: { id: 'singleton' } });
    expect(after!.latest_fx_rate?.toString()).toBe(beforeRate?.toString());

    // Alert(fx_fetch_failed) が 1 件 INSERT されている
    const alerts = await prisma.alert.findMany({
      where: {
        kind: 'fx_fetch_failed',
        payload_json: { path: ['api_url'], equals: TEST_ALERT_TAG_URL },
      },
    });
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const a = alerts[0]!;
    expect(a.kind).toBe('fx_fetch_failed');
    expect(a.severity).toBe('warning');
    const payload = a.payload_json as Record<string, unknown>;
    expect(payload.api_url).toBe(TEST_ALERT_TAG_URL);
    // network_error または http_error_* のいずれか
    expect(typeof payload.reason).toBe('string');
    expect(payload.reason as string).toMatch(/^(network_error|http_error_\d+|json_parse_error)$/);
  });

  // -------------------------------------------------------------------------
  // 3. Worker cron 登録確認
  // -------------------------------------------------------------------------
  test('worker: buildTaskList に fx.fetch を含む 23 タスクが登録されている', () => {
    const tasks = buildTaskList();
    const taskNames = Object.keys(tasks);
    // 23 件 (docs/05 §2 の 19 件 [fx.fetch を含む] + locks.sweep [SP-02 T-02-07] +
    // pipeline.theme.generate [SP-03 T-03-06] + batch_plan.dispatcher [SP-03 T-03-10] +
    // pipeline.book.writer.chapters.dispatch [SP-04 T-04-05])。
    // fx.fetch は元から docs/05 にあり、T-02-08 で placeholder → 本実装に差し替わったのみで
    // 件数は増えない。locks.sweep は SP-02、pipeline.theme.generate / batch_plan.dispatcher
    // は SP-03、pipeline.book.writer.chapters.dispatch は SP-04 で追加。
    expect(taskNames.length).toBe(23);
    expect(taskNames).toContain(FX_FETCH_TASK_NAME);
    expect(taskNames).toContain('pipeline.book.writer.chapters.dispatch');
    expect(FX_FETCH_TASK_NAME).toBe('fx.fetch');
  });

  test('worker: buildParsedCronItems に fx-fetch-daily を含む 6 件の cron が登録されている', () => {
    const parsed = buildParsedCronItems();
    // SP-02 T-02-08 までは 3 件 (archive + locks-sweep + fx-fetch)。
    // T-02-09 で catalog-fetch-daily が追加されたため 4 件に変わった。
    // SP-03 T-03-10 で batch-plan-dispatcher-minute が追加されたため 5 件。
    // SP-07 T-07-02 で alert-cost-check-hourly が追加され、T-07-11 で
    //   standalone locks-sweep-hourly が削除されたため 5 件のまま。
    // SP-09 T-09-04 で archive-jobs-weekly が追加されたため 6 件。
    expect(parsed.length).toBe(6);

    // CRON_ITEMS の方で identifier ベースで存在確認 (parsed の構造は graphile-worker 内部型)
    const identifiers = CRON_ITEMS.map((c) => c.identifier);
    expect(identifiers).toEqual(
      expect.arrayContaining([
        'archive-db-backup-weekly',
        'fx-fetch-daily',
        'catalog-fetch-daily',
        'batch-plan-dispatcher-minute',
        'alert-cost-check-hourly',
        'archive-jobs-weekly',
      ]),
    );

    const fxItem = CRON_ITEMS.find((c) => c.identifier === 'fx-fetch-daily');
    expect(fxItem).toBeDefined();
    expect(fxItem!.task).toBe(FX_FETCH_TASK_NAME);
    expect(fxItem!.match).toBe('55 18 * * *'); // JST 03:55
  });
});
