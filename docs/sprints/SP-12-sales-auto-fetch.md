# SP-12 sales-auto-fetch (Phase 2)

> `pm` 計画モードで生成。対象機能: **F-038** 売上・レビューの Amazon 自動取得。
> 設計根拠: `docs/05-program-design.md §5.3.14`, `docs/02 F-038`, `docs/04 S-017/S-027`。
> 参照ワイヤーフレーム: `docs/wireframes/S-017-sales-kpi/prompt.md`, `docs/wireframes/S-027-settings/prompt.md`。
> 前提: SP-10 (quality-judge) / SP-11 (optimizer-approval) が PHASE_COMPLETE であること。

---

## 1. 目的

KDP レポート画面からの Playwright 自動取得 (F-038) を実装し、売上・レビューを日次で `SalesRecord` に upsert する。ブラウザ取得部分を DI 境界で差し替え可能にすることで、実 KDP へのアクセス（認証・2FA・bot 検出リスク）なしにすべての自律実装層をテスト可能な状態にして完成させる。

### 二層構成の明確化

| 層 | 本スプリントの扱い |
|---|---|
| **自律実装・テスト可能層** | 本スプリントで完成させる（下記タスク一覧参照） |
| **人間/実環境ゲート** | 本スプリントのコード完了条件には含めない（§7 申し送りに記載） |

---

## 2. 対応機能 ID

- **F-038** 売上・レビューの Amazon 自動取得
- 関連画面: **S-017** 売上・KPI ダッシュボード（自動取得ステータス + 手動更新ボタン）
- 関連画面: **S-027** 設定（`sales_auto_fetch_enabled` / `sales_auto_fetch_cron` トグル）

---

## 3. タスク一覧

| タスク ID | 概要 | 工数 | 状態 | Vitest | E2E |
|---|---|---|---|---|---|
| T-12-01 | DBスキーマ確認・`SalesFetchRun` テーブル追加マイグレーション | S | 完了 | 不要 | 不要 |
| T-12-02 | KDP レポートHTML パーサ純関数実装 + fixture 単体テスト | M | 完了 | 必須 | 不要 |
| T-12-03 | `fetchKdpReportHtml` DI 境界インターフェース + ダミー実装 | S | 完了 | 必須 | 不要 |
| T-12-04 | `sales.fetch` ワーカタスク本体（DI 注入版） | M | 完了 | 必須 | 不要 |
| T-12-05 | crontab への `sales.fetch` エントリ追加 + `AppSettings` 反映 | S | 完了 | 必須 | 不要 |
| T-12-06 | Server Action `triggerSalesFetch` (手動実行) | S | 完了 | 必須 | 不要 |
| T-12-07 | S-017 自動取得ステータスバナー + 手動更新ボタン UI | M | 完了 | 不要 | 必須 |
| T-12-08 | S-027 `sales_auto_fetch_enabled` / cron トグル UI | M | 完了 | 不要 | 必須 |
| T-12-09 | E2E: fixture HTML サーバ + `sales.fetch` 統合テスト | M | 完了 | 不要 | 必須 |

合計 9 タスク。

---

## 4. タスク詳細

### T-12-01 DBスキーマ確認・`SalesFetchRun` テーブル追加マイグレーション

**目的**
`SalesRecord` スキーマ（`docs/05 §3`）は Phase 1 で先取り定義済みで変更不要。
しかし自動取得の「実行履歴・ステータス表示」を S-017 に出すために `SalesFetchRun` テーブルが必要。

**参照**
- `docs/05-program-design.md §3`（`SalesRecord` スキーマ、`AppSettings.sales_auto_fetch_enabled/cron`）
- `packages/db/schema.prisma`（既存定義確認）

**実装内容**
1. `packages/db/schema.prisma` を読み、`SalesRecord` と `AppSettings` の既存列を確認する。
2. `SalesFetchRun` モデルを追加:

```prisma
// 売上自動取得実行履歴 [F-038]
model SalesFetchRun {
  id           String   @id @default(cuid())
  account_id   String
  year_month   String   // "2026-05"
  status       String   @default("running") // running | done | failed | 2fa_waiting
  records_upserted Int  @default(0)
  error_message String?
  started_at   DateTime @default(now())
  finished_at  DateTime?

  account      Account  @relation(fields: [account_id], references: [id], onDelete: Cascade)

  @@index([account_id, started_at(sort: Desc)], map: "sales_fetch_runs_account_time_idx")
  @@index([status, started_at(sort: Desc)],     map: "sales_fetch_runs_status_time_idx")
  @@map("sales_fetch_runs")
}
```

3. `Account` モデルに `salesFetchRuns SalesFetchRun[]` リレーションを追加。
4. `pnpm --filter @a2p/db prisma migrate dev --name add_sales_fetch_run` を実行。
5. `packages/db/src/index.ts` から `SalesFetchRun` 型を re-export。

**対象ファイル**
- `packages/db/schema.prisma`
- `packages/db/src/index.ts`（型 re-export）

**受け入れ基準**
- `SalesFetchRun` テーブルが DB に存在し `prisma migrate status` が clean
- `Account` から `salesFetchRuns` リレーションで取得できる
- `AppSettings.sales_auto_fetch_enabled` と `sales_auto_fetch_cron` が既存列として存在する（追加不要）

**依存**: なし（最初に実行）

---

### T-12-02 KDP レポートHTML パーサ純関数実装 + fixture 単体テスト

**目的**
KDP レポート画面の HTML から売上・レビューデータを抽出する純関数を実装する。
実ブラウザ・実 KDP なしで Vitest で完全テスト可能にする。

**参照**
- `docs/05-program-design.md §5.3.14`（`sales.fetch` 実行内容）
- `docs/02 F-038`（受け入れ基準: 売上/レビュー/順位の取得）
- `apps/worker/src/tasks/catalog-fetch.ts`（パーサ設計のパターン参照）

**実装内容**

1. `apps/worker/src/tasks/sales-fetch/parser.ts` を新規作成:

```typescript
// KDP レポートページのパース結果（1 書籍 × 1 月分）
export interface KdpSalesRow {
  asin: string
  year_month: string   // "YYYY-MM"
  royalty_jpy: number
  units_sold: number
  review_count: number
  avg_stars: number | null
  bsr: number | null
}

/**
 * KDP レポートHTMLから売上行を抽出する純関数。
 * 実ブラウザ不使用。Vitest で fixture HTML を渡してテスト可能。
 *
 * 設計原則:
 * - throw しない（パース失敗は空配列 or 部分成功で返す）
 * - HTML 構造の変化に対し保守的（1 行でも取れれば ok）
 * - KDP は日本語 UI を前提とする（円建て / 「レビュー」ラベル）
 */
export function parseKdpSalesHtml(html: string, yearMonth: string): KdpSalesRow[]

/**
 * Amazon 書籍ページの HTML から BSR と平均星を抽出する純関数（補助）。
 */
export interface KdpPublicPageData {
  bsr: number | null
  avg_stars: number | null
  review_count: number | null
}
export function parseAmazonPublicPage(html: string): KdpPublicPageData
```

2. `tests/fixtures/kdp-report/` ディレクトリを作成し、以下の fixture HTML ファイルを作成:
   - `sample-report.html`: ダミーKDPレポートHTML（ASIN/月/ロイヤリティ/レビュー含む。実KDPとは関係のない架空データ）
   - `empty-report.html`: 売上ゼロのKDPレポートHTML
   - `amazon-product-page.html`: ダミーAmazon商品ページ（BSR/星含む）

3. `apps/worker/src/tasks/sales-fetch/parser.test.ts` を作成:
   - `parseKdpSalesHtml(sampleHtml, '2026-05')` が `KdpSalesRow[]` を返す
   - `royalty_jpy >= 0` かつ `asin` が `B0` で始まる形式
   - `parseKdpSalesHtml(emptyHtml, '2026-05')` が空配列を返す
   - `parseAmazonPublicPage(productPageHtml)` が `{ bsr, avg_stars, review_count }` を返す
   - HTML 構造が壊れていても throw しない

**対象ファイル**
- `apps/worker/src/tasks/sales-fetch/parser.ts`（新規）
- `apps/worker/src/tasks/sales-fetch/parser.test.ts`（新規）
- `tests/fixtures/kdp-report/sample-report.html`（新規、ダミー）
- `tests/fixtures/kdp-report/empty-report.html`（新規）
- `tests/fixtures/kdp-report/amazon-product-page.html`（新規、ダミー）

**受け入れ基準**
- `pnpm --filter apps/worker vitest run src/tasks/sales-fetch/parser.test.ts` が全 PASS
- `parseKdpSalesHtml` が実 KDP へのネットワーク接続を一切行わない（純関数）
- fixture HTML に対し `royalty_jpy`, `asin`, `year_month` が正しく抽出される

**依存**: T-12-01 の後でよいが独立実行可

---

### T-12-03 `fetchKdpReportHtml` DI 境界インターフェース + ダミー実装

**目的**
Playwright でのブラウザ操作部分を DI 境界としてインターフェース化し、テストではfixture HTMLを返すダミー実装を注入できる構成にする。Phase 3 の本番実装はこのインターフェースを満たすように実装する。

**参照**
- `docs/dev-plan.md §4`（SP-14 で Playwright + stealth と共通基盤化する言及）
- `apps/worker/src/tasks/catalog-fetch.ts`（`ProviderFetcher` DI 境界のパターン参照）
- `docs/05 §5.3.14`（`sales.fetch` の実行内容）

**実装内容**

1. `apps/worker/src/tasks/sales-fetch/browser-port.ts` を新規作成:

```typescript
/**
 * KDP ブラウザ操作の抽象ポート（DI 境界）[F-038]
 *
 * 本 SP-12 では実 Playwright を使わない。
 * Phase 3 (SP-14) で `BrowserPort` を満たす実装（Playwright + stealth）を提供する。
 *
 * HARD RULE: このファイルに `playwright` の import を書いてはならない。
 * Playwright 依存は Phase 3 のみ。
 */

export interface KdpCredentials {
  email: string
  password: string
  totp_secret?: string  // TOTP 2FA シークレット（任意）
}

export interface FetchReportHtmlArgs {
  credentials: KdpCredentials
  yearMonth: string      // "YYYY-MM"
  /** タイムアウト ms (既定 60_000) */
  timeoutMs?: number
}

export type FetchReportHtmlResult =
  | { ok: true; html: string; source: 'kdp_report_page' }
  | { ok: false; reason: '2fa_required' | 'login_failed' | 'timeout' | 'unknown'; message: string }

/**
 * KDP レポートページの HTML を取得するブラウザポート。
 * テストではフィクスチャHTMLを返すダミー、本番(Phase 3)ではPlaywright実装を注入。
 */
export type BrowserPort = {
  fetchReportHtml(args: FetchReportHtmlArgs): Promise<FetchReportHtmlResult>
}

/**
 * Fixture HTML を返すダミー実装（単体テスト・E2E fixture テスト用）。
 * ネットワーク/ブラウザ不使用。
 */
export function createFixtureBrowserPort(fixtureHtml: string): BrowserPort {
  return {
    async fetchReportHtml(_args) {
      return { ok: true, html: fixtureHtml, source: 'kdp_report_page' }
    },
  }
}

/**
 * 常に 2FA 要求を返すダミー（2FA ハンドリングテスト用）。
 */
export function create2faBrowserPort(): BrowserPort {
  return {
    async fetchReportHtml(_args) {
      return { ok: false, reason: '2fa_required', message: '2FA required (test dummy)' }
    },
  }
}
```

2. `apps/worker/src/tasks/sales-fetch/browser-port.test.ts` を作成:
   - `createFixtureBrowserPort(html)` が `{ ok: true, html }` を返す
   - `create2faBrowserPort()` が `{ ok: false, reason: '2fa_required' }` を返す

**対象ファイル**
- `apps/worker/src/tasks/sales-fetch/browser-port.ts`（新規）
- `apps/worker/src/tasks/sales-fetch/browser-port.test.ts`（新規）

**受け入れ基準**
- `BrowserPort` インターフェースが export されている
- `createFixtureBrowserPort` / `create2faBrowserPort` の両ダミーが動作する
- ファイル内に `playwright` の import が一切ない
- 単体テスト全 PASS

**依存**: T-12-02 と並列実行可

---

### T-12-04 `sales.fetch` ワーカタスク本体（DI 注入版）

**目的**
`apps/worker/src/tasks/sales-fetch.ts` を placeholder から本実装に置き換える。
`BrowserPort` を依存注入し、実ブラウザなしで単体テスト可能にする。

**参照**
- `docs/05-program-design.md §5.3.14`（SalesFetchPayload, タイムアウト 20 分, max_attempts 2, priority 40）
- `apps/worker/src/tasks/catalog-fetch.ts`（DI パターン, 冪等設計のモデル）
- `packages/db/schema.prisma`（`SalesRecord`, `SalesFetchRun`, `Kdp2FaCode`, `accounts.kdp_credentials_enc`）
- `packages/crypto/`（`encryptAES256GCM` / `decryptAES256GCM` — KDP 認証情報の復号）
- `docs/05 §3`（`AppSettings.sales_auto_fetch_cron` の cron 文字列）

**実装内容**

1. `apps/worker/src/tasks/sales-fetch.ts` を本実装に書き換える。

`runSalesFetch(deps)` 純ロジック関数を設計:

```typescript
export const SalesFetchPayload = z.object({
  account_id: z.string(),
  year_month: z.string().regex(/^\d{4}-\d{2}$/),
})
export type SalesFetchPayload = z.infer<typeof SalesFetchPayload>

export interface SalesFetchDeps {
  payload: SalesFetchPayload
  /** ブラウザポート（テストではダミーを注入） */
  browserPort: BrowserPort
  /** Prisma クライアント（テストではモックを注入） */
  prisma?: SalesFetchPrisma
  /** ロガー差し替え */
  logger?: Logger
  /** 「今」を固定（テスト用） */
  now?: () => Date
}

export interface SalesFetchResult {
  ok: boolean
  recordsUpserted: number
  runId: string
  reason?: '2fa_required' | 'login_failed' | 'no_credentials' | 'parse_error' | 'unknown'
}

export async function runSalesFetch(deps: SalesFetchDeps): Promise<SalesFetchResult>
```

実行フロー:
1. `SalesFetchRun` INSERT (status=running)
2. `accounts.kdp_credentials_enc` を取得 → 未設定なら `{ ok: false, reason: 'no_credentials' }` で return（run status=failed）
3. `decryptAES256GCM(enc)` で認証情報を復号
4. `deps.browserPort.fetchReportHtml(args)` を呼ぶ
   - `2fa_required` → `Kdp2FaCode` INSERT (status=awaiting) + `SalesFetchRun` status=`2fa_waiting` で一時停止（Phase 3 で 2FA ポーリング待機を追加）
   - その他 failure → run status=failed, return
5. `parseKdpSalesHtml(html, year_month)` でパース
6. 各 `KdpSalesRow` を `sales_records` upsert（`@@unique([book_id, year_month])`、ASIN → book_id の変換は `books.asin` で lookup）
   - ASIN に対応する `books` が見つからない行はスキップ（warn ログ）
7. `SalesFetchRun` を status=done, records_upserted=N, finished_at=now() で UPDATE
8. `{ ok: true, recordsUpserted: N, runId }` を return

Prisma 最小インターフェース (`SalesFetchPrisma`) を定義し、本番時は `defaultPrisma` を使用。

2. 単体テスト `apps/worker/src/tasks/sales-fetch.test.ts`:
   - `createFixtureBrowserPort(sampleHtml)` を注入して `runSalesFetch` が `{ ok: true, recordsUpserted >= 1 }` を返す
   - `create2faBrowserPort()` を注入したとき `{ ok: false, reason: '2fa_required' }` を返す
   - `prisma` モックで `SalesFetchRun` の INSERT/UPDATE が呼ばれることを確認
   - 認証情報未設定のアカウントで `{ ok: false, reason: 'no_credentials' }` を返す
   - upsert 冪等性: 同じ `(book_id, year_month)` で 2 回呼んでも `SalesRecord` が 1 件のみ（`upsert` の `update` 側が呼ばれる）

**対象ファイル**
- `apps/worker/src/tasks/sales-fetch.ts`（既存 placeholder を本実装に置き換え）
- `apps/worker/src/tasks/sales-fetch/` ディレクトリ（parser, browser-port をサブモジュールとして import）
- `apps/worker/src/tasks/sales-fetch.test.ts`（新規）

**受け入れ基準**
- `pnpm --filter apps/worker vitest run src/tasks/sales-fetch.test.ts` が全 PASS
- `runSalesFetch` に `playwright` import が存在しない
- 2FA 経路で `Kdp2FaCode` が INSERT されること
- `ASIN → book_id` 変換で未知の ASIN はスキップして処理継続（throw しない）
- 冪等テスト PASS（同一 year_month で 2 回実行で records 重複なし）

**依存**: T-12-01, T-12-02, T-12-03

---

### T-12-05 crontab への `sales.fetch` エントリ追加 + `AppSettings` 反映

**目的**
`apps/worker/src/crontab.ts` に `sales.fetch` の CronItem を追加し、`AppSettings.sales_auto_fetch_enabled` が true のときのみ有効になるロジックを実装する。

**参照**
- `docs/05-program-design.md §5.4`（`0 17 * * *` UTC = JST 02:00、`$ALL` → 全 active アカウント展開）
- `apps/worker/src/crontab.ts`（既存 CRON_ITEMS, コメントに `SP-08` 予定として既存エントリあり）
- `apps/worker/src/tasks/catalog-fetch.ts`（`resolveCatalogFetchCron` パターン参照）

**実装内容**

1. `apps/worker/src/crontab.ts` の末尾コメント（`SP-08: { task: 'sales.fetch'... }`）を本実装に置き換える:

```typescript
// crontab.ts 追加エントリ（SP-12 T-12-05）
export const SALES_FETCH_CRON_DEFAULT = '0 17 * * *'; // 02:00 JST

export function resolveSalesFetchCron(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.SALES_FETCH_CRON;
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return SALES_FETCH_CRON_DEFAULT;
}
```

CronItem は `sales_auto_fetch_enabled` を実行時に DB から確認する形ではなく、worker 起動時に `AppSettings` を読んで有効/無効を切り替える設計にする（graphile-worker の cron は静的定義のため）:

```typescript
// worker.ts (main) で AppSettings を読んで cron を動的に組み立てる
// buildCronItemsWithSettings(settings: AppSettings): CronItem[]
```

2. `apps/worker/src/worker.ts`（または起動エントリポイント）で起動時に `AppSettings` を読み、`sales_auto_fetch_enabled === true` のときのみ `sales.fetch` を CRON_ITEMS に追加する関数 `buildCronItemsWithSettings` を実装する。

3. `apps/worker/src/tasks/sales-fetch-dispatcher.ts` を作成:
   - `sales.fetch` cron が発火すると呼ばれるタスク
   - DB から `accounts.status = 'active'` を全件取得
   - 各アカウントに対し `addJob('sales.fetch', { account_id, year_month: currentYearMonth() })` を enqueue（`$ALL` 展開ロジック）
   - タスク名: `sales.fetch.dispatch`

4. `crontab.ts` を `sales.fetch.dispatch` を cron で起動するよう設定する。

5. 単体テスト:
   - `resolveSalesFetchCron` の env 解決テスト
   - `buildCronItemsWithSettings({ sales_auto_fetch_enabled: false })` が `sales.fetch.dispatch` を含まない
   - `buildCronItemsWithSettings({ sales_auto_fetch_enabled: true })` が `sales.fetch.dispatch` を含む

**対象ファイル**
- `apps/worker/src/crontab.ts`
- `apps/worker/src/tasks/sales-fetch-dispatcher.ts`（新規）
- `apps/worker/src/tasks/sales-fetch-dispatcher.test.ts`（新規）
- `apps/worker/src/worker.ts`（起動エントリ、`buildCronItemsWithSettings` 追加）

**受け入れ基準**
- `AppSettings.sales_auto_fetch_enabled = false` のとき worker 起動時に `sales.fetch.dispatch` が CRON_ITEMS に含まれない
- `AppSettings.sales_auto_fetch_enabled = true` のとき含まれる
- cron 発火で全 active アカウント分の `sales.fetch` が enqueue される
- 単体テスト全 PASS

**依存**: T-12-04

---

### T-12-06 Server Action `triggerSalesFetch` (手動実行)

**目的**
S-017 の「手動更新ボタン」から呼び出す Server Action を実装する。即時で `sales.fetch` ジョブを enqueue し、`SalesFetchRun` の最新状態を返す。

**参照**
- `docs/04-ui-design.md S-017`（「手動更新ボタン」の UX 仕様）
- `docs/05-program-design.md §4.3.13`（既存 `upsertSales` / `importSalesCsv` の Action パターン参照）
- `docs/05-program-design.md §4.1`（Server Action の zod parse + getSessionOrThrow パターン）

**実装内容**

1. `apps/web/src/app/(protected)/sales/actions.ts`（既存ファイルがあれば追記、なければ新規）に追加:

```typescript
// 手動で sales.fetch をキックする [F-038 S-017]
export const triggerSalesFetchInput = z.object({
  account_id: z.string(),
  year_month: z.string().regex(/^\d{4}-\d{2}$/).optional(), // 省略時は当月
})
export async function triggerSalesFetch(
  input: z.infer<typeof triggerSalesFetchInput>
): Promise<ActionResult<{ job_id: string; run_id: string }>>
```

実装:
- `getSessionOrThrow()`
- `year_month` 未指定なら `new Date()` から `YYYY-MM` 生成
- `SalesFetchRun` INSERT (status=running)
- `addJob('sales.fetch', { account_id, year_month }, { jobKey: \`sales-fetch-${account_id}-${year_month}\` })` で enqueue（jobKey で重複防止）
- `revalidatePath('/sales')`
- `return { job_id, run_id }`

2. 最新 `SalesFetchRun` を取得する RSC 用ヘルパ:

```typescript
// sales-fetch-status.ts  
export async function getLatestSalesFetchRun(
  accountId: string
): Promise<SalesFetchRun | null>
```

3. 単体テスト `triggerSalesFetch.test.ts`:
   - 認証なし → `{ error: 'unauthorized' }` を返す
   - `account_id` が無効 → zod バリデーションエラー
   - 正常系: `SalesFetchRun` が INSERT され、`addJob` が呼ばれる
   - 同じ `account_id + year_month` で 2 回呼んだとき jobKey 重複で 1 ジョブのみ enqueue

**対象ファイル**
- `apps/web/src/app/(protected)/sales/actions.ts`（新規または追記）
- `apps/web/src/app/(protected)/sales/sales-fetch-status.ts`（新規）
- `apps/web/src/app/(protected)/sales/actions.test.ts`（新規または追記）

**受け入れ基準**
- 同一 `account_id + year_month` への重複呼び出しで graphile-worker ジョブが 1 件のみ INSERT される（jobKey 制御確認）
- 単体テスト全 PASS

**依存**: T-12-01, T-12-04

---

### T-12-07 S-017 自動取得ステータスバナー + 手動更新ボタン UI

**目的**
`docs/04 S-017` の「自動取得ステータス表示 + 手動更新ボタン」を実装する。

**参照**
- `docs/wireframes/S-017-sales-kpi/prompt.md`（ワイヤーフレーム）
- `docs/04-ui-design.md §S-017`（「自動取得のステータス表示 + 手動更新ボタン」「エラー時はバナー表示」）
- T-12-06 の `getLatestSalesFetchRun` と `triggerSalesFetch`

**実装内容**

1. `apps/web/src/app/(protected)/sales/page.tsx` の既存 S-017 ページに `SalesFetchStatusBanner` コンポーネントを追加する。

`SalesFetchStatusBanner` の仕様:
- Props: `{ latestRun: SalesFetchRun | null; accountId: string }`
- `latestRun === null`: 「まだ自動取得を実行していません」+ 「今すぐ取得」ボタン
- `latestRun.status === 'running'`: 「取得中...」スピナー（Skeleton）+ 「更新」ボタン無効
- `latestRun.status === 'done'`: `✓ 最終取得: {finished_at の相対時刻}（{records_upserted} 件更新）` + 「再取得」ボタン
- `latestRun.status === 'failed'`: 赤バナー `エラー: {error_message}` + 「再試行」ボタン
- `latestRun.status === '2fa_waiting'`: 橙バナー「2FA 認証待ち — メールで承認してください」（ボタン無し）

ボタン押下で `triggerSalesFetch({ account_id: accountId, year_month: currentYearMonth() })` を Server Action として呼ぶ。

2. 「取得中」状態は 5 秒ポーリング（`useEffect` + `router.refresh()`）で自動更新（または `revalidatePath` のみで十分な場合は RSC のリロードで対応）。

3. S-017 の RSC 側で `getLatestSalesFetchRun(accountId)` を呼び props に渡す。

**対象ファイル**
- `apps/web/src/app/(protected)/sales/page.tsx`（追記）
- `apps/web/src/components/sales-fetch-status-banner.tsx`（新規）

**受け入れ基準**
- `docs/wireframes/S-017-sales-kpi/prompt.md` のワイヤーフレームに従ったレイアウト
- status=done 時に「最終取得: X 分前」と「N 件更新」が表示される
- status=failed 時に赤バナーとエラーメッセージが表示される
- status=2fa_waiting 時に橙バナーが表示される
- 「今すぐ取得」ボタン押下で `triggerSalesFetch` が呼ばれジョブが enqueue される（E2E で確認）

**依存**: T-12-06

---

### T-12-08 S-027 `sales_auto_fetch_enabled` / cron トグル UI

**目的**
S-027 設定画面の「売上自動取得設定」セクション（Phase 2 以降, `docs/04 S-027` §4）を実装する。

**参照**
- `docs/wireframes/S-027-settings/prompt.md`（ワイヤーフレーム）
- `docs/04-ui-design.md §S-027`（「売上自動取得設定 ON/OFF、実行時刻」セクション）
- `docs/05-program-design.md §4.3.15`（`updateSettings` Server Action、`sales_auto_fetch_enabled` / `sales_auto_fetch_cron`）

**実装内容**

1. `apps/web/src/app/(protected)/settings/page.tsx` の既存設定ページに「売上自動取得」セクションを追加。

セクション仕様:
- **トグルスイッチ**: `sales_auto_fetch_enabled` ON/OFF
- **cron 設定フィールド**: `sales_auto_fetch_cron`（テキスト入力、例 `0 17 * * *`）+ 「JST 02:00 毎日」のような人間可読なラベル表示
- ON にすると「次回実行: {next cron time in JST}」を表示
- OFF のとき cron フィールドはグレーアウト（input disabled）

2. cron 文字列から「次回実行時刻（JST）」を計算するヘルパ（サーバーサイド）:

```typescript
// apps/web/src/lib/cron-utils.ts
export function nextCronRunJst(cronExpression: string): string
// 例: '0 17 * * *' → '毎日 02:00 JST'
```

3. Server Action `updateSettings` は既存定義（`docs/05 §4.3.15`）を使い追加実装不要。

4. 「設定を保存」ボタン押下 → `updateSettings({ sales_auto_fetch_enabled, sales_auto_fetch_cron })` → worker を再起動せずに次回 cron 発火から反映（worker 起動時に DB から読む設計のため、設定変更は worker 再起動時に反映される旨を UI に注意書きとして表示）。

**対象ファイル**
- `apps/web/src/app/(protected)/settings/page.tsx`（追記）
- `apps/web/src/components/sales-auto-fetch-settings.tsx`（新規）
- `apps/web/src/lib/cron-utils.ts`（新規）

**受け入れ基準**
- `docs/wireframes/S-027-settings/prompt.md` のワイヤーフレームに従ったレイアウト
- トグル ON/OFF が `AppSettings.sales_auto_fetch_enabled` に保存される
- cron 設定が保存され、`apps/worker` の次回起動時に新しい cron が有効になる
- 「worker 再起動で反映」の注意書きが表示される
- invalid な cron 文字列（例: `* * * *`（フィールド不足））は保存前にバリデーションエラー

**依存**: T-12-05（crontab 設計が確定してからUIに注意書きの内容を確定）

---

### T-12-09 E2E: fixture HTML サーバ + `sales.fetch` 統合テスト

**目的**
Playwright で実 KDP を使わずに `sales.fetch` の完全な動作を E2E テストする。ローカルの Express/Next サーバが fixture HTML を返すエンドポイントを立て、`BrowserPort` の実装として「fixture サーバからHTML を取得する軽量 fetch ベース実装」を注入する。

**参照**
- `tests/e2e/` 以下の既存 Playwright spec（SP-09/SP-11 で確立したパターン）
- `playwright.config.ts`（chromium spec / runtime spec のパターン踏襲）
- `docs/02 F-038`（受け入れ基準: 日次自動実行・2FA push-and-wait）
- T-12-02, T-12-04, T-12-07 の成果物

**実装内容**

1. `tests/fixtures/kdp-report/server.ts` を作成:
   - Next.js dev サーバ or `playwright/test` の `server` オプションで、ローカル fixture HTML ファイルをサーブするミニサーバ（`/kdp/report.html`, `/amazon/product.html` 等のルート）
   - `playwright.config.ts` の `webServer` または `globalSetup` で起動

2. `tests/e2e/sales-auto-fetch.spec.ts` を作成（chromium spec）:

**テストシナリオ A: 正常系 — ダッシュボードから手動取得**
1. S-017 `売上・KPI` ページを開く
2. `SalesFetchStatusBanner` が「まだ取得していません」状態であることを確認
3. 「今すぐ取得」ボタンをクリック
4. ステータスが「取得中...」に変わることを確認（Skeleton 表示）
5. ジョブが完了し（fixture BrowserPort → fixture HTML → parse → upsert）ステータスが「最終取得: N 件更新」に変わることを確認
6. `sales_records` テーブルに少なくとも 1 件が存在することを DB 直接確認

**テストシナリオ B: S-027 設定トグル**
1. S-027 設定ページを開く
2. `sales_auto_fetch_enabled` が OFF（初期）であることを確認
3. トグルを ON にして「保存」
4. トグルが ON のまま再読み込みされることを確認
5. cron 文字列フィールドが有効になっていることを確認

**テストシナリオ C: 2FA 発生時のバナー表示**
1. `create2faBrowserPort()` を返す設定（テスト用フラグ or env）で `sales.fetch` を実行
2. S-017 で `SalesFetchStatusBanner` が橙バナー「2FA 認証待ち」になることを確認
3. `sales_fetch_runs` テーブルで status=`2fa_waiting` を確認

**対象ファイル**
- `tests/e2e/sales-auto-fetch.spec.ts`（新規）
- `tests/fixtures/kdp-report/server.ts`（新規、fixture サーバ）
- `playwright.config.ts`（必要に応じて webServer 追記）

**受け入れ基準**
- `pnpm exec playwright test tests/e2e/sales-auto-fetch.spec.ts` が全 PASS（chromium）
- 実 KDP へのネットワーク接続が一切発生しない
- シナリオ A で `sales_records` に upsert が確認できる
- シナリオ B で設定の永続化が確認できる
- シナリオ C で 2FA バナーが表示される

**依存**: T-12-01, T-12-04, T-12-05, T-12-06, T-12-07, T-12-08

---

## 5. テスト計画

### 5.1 Vitest 単体テスト

| テストファイル | カバー対象 | 必須/任意 |
|---|---|---|
| `apps/worker/src/tasks/sales-fetch/parser.test.ts` | `parseKdpSalesHtml`, `parseAmazonPublicPage` | 必須 |
| `apps/worker/src/tasks/sales-fetch/browser-port.test.ts` | `createFixtureBrowserPort`, `create2faBrowserPort` | 必須 |
| `apps/worker/src/tasks/sales-fetch.test.ts` | `runSalesFetch` DI 注入、冪等性、2FA 経路 | 必須 |
| `apps/worker/src/tasks/sales-fetch-dispatcher.test.ts` | `buildCronItemsWithSettings`, `$ALL` 展開 | 必須 |
| `apps/web/src/app/(protected)/sales/actions.test.ts` | `triggerSalesFetch` jobKey 重複、認証チェック | 必須 |

### 5.2 Playwright E2E

| spec | シナリオ | ブラウザ |
|---|---|---|
| `tests/e2e/sales-auto-fetch.spec.ts` | A: 正常手動取得, B: 設定トグル, C: 2FA バナー | chromium |

### 5.3 テスト非対象（本スプリント外）

- 実 KDP への認証・レポート取得の実走（→ §7 人間ゲート申し送り）
- 2FA プッシュ通知・承認フローの完全な E2E（Resend + メール受信は Phase 3 で実施）
- Playwright + stealth の本番ブラウザ実装（Phase 3 SP-14）

---

## 6. 完了判定

以下をすべて満たしたとき本スプリントを完了とする:

1. T-12-01〜T-12-09 の全タスクが「完了」
2. `pnpm --filter apps/worker vitest run` が全 PASS（parser / browser-port / sales-fetch / sales-fetch-dispatcher の各テストを含む）
3. `pnpm --filter apps/web vitest run` が全 PASS（actions.test.ts を含む）
4. `pnpm exec playwright test tests/e2e/sales-auto-fetch.spec.ts` が全 PASS（chromium、実 KDP 不使用）
5. `SalesFetchRun` テーブルがマイグレーション済みで `prisma migrate status` が clean
6. `apps/worker/src/tasks/sales-fetch.ts` に `playwright` の import が存在しない
7. `apps/worker/src/tasks/sales-fetch/browser-port.ts` に `playwright` の import が存在しない
8. S-017 で手動更新ボタンが動作し、状態が `done` / `failed` / `2fa_waiting` に遷移する
9. S-027 で `sales_auto_fetch_enabled` / `sales_auto_fetch_cron` が保存される
10. pm `MODE: REVIEW TARGET: SP-12` で `## PHASE_COMPLETE`

---

## 7. 申し送り（次フェーズ・人間ゲート）

### 7.1 人間/実環境ゲート（本スプリントのコード完了条件に含めない）

以下は T-09-08（Phase 1 実走）と同種の人間タスクとして別管理する。
コード完了後に人間が手動で実施し、成功を確認すること。

| # | 内容 | 担当 | 前提 |
|---|---|---|---|
| HG-12-01 | 実 KDP アカウントの KDP 認証情報（email / password）を `accounts.kdp_credentials_enc` に設定する（S-004 の「KDP 認証情報」フィールドから入力） | 人間（運営者） | SP-12 コード完了後 |
| HG-12-02 | `sales_auto_fetch_enabled = true` で cron または手動トリガーにより実 KDP レポートページへのアクセスを実施し、`SalesRecord` が upsert されることを確認する | 人間（運営者） | HG-12-01 完了後、実 KDP アカウントと ASIN 登録書籍が存在すること |
| HG-12-03 | 実 KDP で 2FA が発生した場合、Resend メール経由で承認フローが機能することを確認する（Phase 3 の 2FA 実装と接続テスト） | 人間（運営者） | Phase 3 SP-15 の Resend `kdp-2fa` メールテンプレ実装後 |

### 7.2 Phase 3 (SP-14) への申し送り

- `BrowserPort` インターフェース（`apps/worker/src/tasks/sales-fetch/browser-port.ts`）が Phase 3 の KDP 自動入稿（F-041）でも共通利用可能な設計になっている。SP-14 では `BrowserPort` を満たす Playwright + stealth 実装を `packages/browser/` に配置し、`sales.fetch` タスクと `kdp.submit` タスクの両方から注入できるようにすること。
- 2FA ハンドリング（`Kdp2FaCode` INSERT → ポーリング待機 → Resend メール送信）は SP-12 では 2FA 発生の検出と `SalesFetchRun.status = '2fa_waiting'` への更新まで実装済み。SP-15 でポーリング待機と Resend `kdp-2fa` テンプレを実装すること。
- `Kdp2FaCode` テーブルは Phase 1 で先取りスキーマとして存在（`docs/05 §3`）。

### 7.3 SP-13 への申し送り

- `SalesRecord.source = 'auto'` で自動取得データが入るため、SP-13 のモデル A/B 比較ビュー（S-021）で売上起因の比較に利用可能。

---

## 8. 依存関係サマリー

```
T-12-01 (スキーマ)
  └→ T-12-04 (タスク本体)
       ├→ T-12-05 (crontab)
       │    └→ T-12-08 (設定UI)
       └→ T-12-06 (Server Action)
            └→ T-12-07 (ステータスUI)
                  └→ T-12-09 (E2E)

T-12-02 (パーサ) ─→ T-12-04
T-12-03 (DI境界)  ─→ T-12-04
```

### 並列実行可能グループ

| グループ | タスク | 前提 |
|---|---|---|
| **Group A（初手並列）** | T-12-01, T-12-02, T-12-03 | なし |
| **Group B（T-12-01〜03 完了後）** | T-12-04 | T-12-01, T-12-02, T-12-03 |
| **Group C（T-12-04 完了後、並列）** | T-12-05, T-12-06 | T-12-04 |
| **Group D（T-12-05 完了後）** | T-12-08 | T-12-05 |
| **Group E（T-12-06 完了後）** | T-12-07 | T-12-06 |
| **Group F（全完了後）** | T-12-09 | T-12-01〜T-12-08 |
