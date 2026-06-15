# SP-02 llm-core-cost-foundation

## 1. 目的

マルチプロバイダ LLM 二層クライアント（`AISdkClient` + `AgentSdkClient`） / `withTokenLogging` ミドルウェア / `BookLock` 排他制御 / モデル単価カタログ日次取得 / 為替日次取得 / モデル割当 UI を実装し、**以降のすべての LLM 呼び出しが `token_usage` に自動記録され、書籍排他が安全に取れる土台** を作る。コスト追跡と LLM 抽象化の核となるスプリント。

## 2. 対応機能 ID

- **F-022** 役割×ジャンル単位のモデル割当
- **F-023** UI からの役割別モデル切替
- **F-024** モデル単価カタログの日次自動取得バッチ
- **F-025** モデル単価カタログのダッシュボード表示
- **F-032** 全 LLM/画像 API 呼び出しのトークン使用量記録
- **F-051** API キー UI 設定（DB 暗号化保存基盤、UI 部分は SP-07 S-027）
- `docs/03 §10` 申し送り 1, 2, 4（task_identifier 命名）, 6 (PDF ベンチは SP-05)
- `docs/05 §13` 申し送り 4 (audit_log), 5 (冪等性), 6 (createAgentClient 経由のみ)
- 対応画面: **S-019** モデル割当、**S-020** モデル単価カタログ

## 3. タスク一覧

| ID | 状態 | タスク | 概要 | 対応機能/画面 | 工数 |
|---|---|---|---|---|---|
| T-02-01 | ✅ | LLM クライアント抽象 + 統一インターフェース | `packages/agents/lib/llm-client.ts` の `LLMClient` interface + `LLMCompleteArgs/Result` 型 + `AgentRole` `Genre` 共通型 | docs/03 A-01, docs/05 §6.1 | S |
| T-02-02 | ✅ | AISdkClient (Vercel AI SDK 実装) | Anthropic/OpenAI/Google の 3 provider 対応 + structured output (zod) + p-retry | A-01, A-04 | L |
| T-02-03 | ✅ | AgentSdkClient (Anthropic Agent SDK 実装) | `@anthropic-ai/claude-agent-sdk` で Web Search server tool 利用版 | A-02, F-001 (Marketer 用) | M |
| T-02-04 | ✅ | withTokenLogging ミドルウェア + createAgentClient ファクトリ | `token_usage` 自動 INSERT / `Book.cost_jpy_total` atomic increment / ファクトリで二層を切替 | F-032, docs/05 §6.2 | M |
| T-02-05 | ✅ | prompt-loader.ts | `prompts` テーブルから active 版取得 (genre 指定優先) + プレースホルダ差込 | F-027 (loader 部) | S |
| T-02-06 | ✅ | image-gen.ts + sharp 後処理 (枠) | OpenAI gpt-image-1 呼出 + image_count 記録 (sharp 後処理は SP-05) | F-032 (image 部) | M |
| T-02-07 | ✅ | BookLock 取得/解放ヘルパ + 期限切れ掃除 | `packages/agents/lib/book-lock.ts` の acquire/release/sweep / expires_at 自動解放 cron | docs/05 §14 #4, OQ-D-05 | M |
| T-02-08 | ✅ | fx.fetch タスク + ModelCatalog 永続化 | exchangerate.host から USD/JPY 取得 → 後段 catalog.fetch で参照 | B-04, F-024 (fx 部) | S |
| T-02-09 | ✅ | catalog.fetch タスク + スクレイピング + 単価変動アラート | 3 provider 公式 SDK + cheerio で価格抽出 → `ModelCatalog` upsert + ±10% 超変動で Alert + Resend `pricing-changed` | F-024, B-01〜B-05 | L |
| T-02-10 | ✅ | S-020 モデル単価カタログ UI + 手動更新 | RSC で ModelCatalog 一覧 + ManualRefreshButton + CSV エクスポート + 手動編集 SA `editCatalogEntry` | F-025, B-03 | M |
| T-02-11 | ✅ | S-019 モデル割当 UI + 切替 SA + 履歴 | AssignmentMatrix + AssignmentEditor + `upsertModelAssignment` `revertModelAssignment` SA + audit_log | F-022, F-023, docs/05 §13 #4 | M |
| T-02-12 | ✅ | CI ガード: 生クライアント禁止 + token_usage 必須 | `scripts/check-llm-client-usage.ts` で `packages/agents/lib/` 以外での `AISdkClient`/`AgentSdkClient` import を fail | docs/05 §10.1 | S |
| T-02-13 | ✅ | ApiCredential DB 基盤 + getApiKey ヘルパ + env zod 任意化 | `ApiCredential` model 追加マイグ / `actions/api-credentials.ts` の `setApiCredential` `revokeApiCredential` `testApiCredential` SA / `packages/agents/lib/get-api-key.ts` (DB 優先 + env フォールバック + 60s LRU キャッシュ) / `env.ts` で 4 プロバイダキーを `.optional()` 化 / Vitest で各 SA + getApiKey 経路カバー（S-027 設定 UI は SP-07 T-07-XX で実装） | **F-051, F-052** (DB/SA 基盤部) | M |
| T-02-14 | ✅ | Playwright E2E 基盤（SP-09 から前倒し） | `playwright.config.ts`（baseURL=http://localhost:3001、storageState 戦略、reporter）/ `tests/e2e/fixtures/{db.ts,auth.ts}` (DB クリーンアップ + 認証 helper) / `tests/e2e/smoke-login-dashboard.spec.ts` (T-01-09/T-01-10 検証) / `apps/web/` ログインフォーム + ダッシュボード代表要素に `data-testid` 付与 / CI ジョブに `pnpm exec playwright test` 追加（実 PG + 実 Web に対して実行） | docs/05 §11, **以降の SP の E2E 受入条件を実E2Eで担保するための土台** | M |

合計 **14 タスク**、すべて完了。

---

## 4. タスク詳細

### T-02-01 LLM クライアント抽象 + 統一インターフェース

**何を実装するか**:
- `packages/agents/lib/llm-client.ts` に `docs/05 §6.1` のコード片そのまま:
  - `LLMCompleteArgs` / `LLMCompleteResult<T>` / `LLMClient` interface
  - `AgentRole` 型: `'marketer' | 'writer' | 'editor' | 'judge' | 'thumbnail_text' | 'thumbnail_image' | 'optimizer' | 'revision'`
  - `Genre` 型: `'practical' | 'business' | 'self_help'`
- `packages/contracts/agents/index.ts` から再 export
- 実装はまだ書かない（次タスクで）

**参照すべき設計書セクション**:
- `docs/05 §6.1` `docs/03 §A-01`

**完了の判定方法**: 型のみで `pnpm typecheck` PASS。`packages/contracts` 外からは `LLMClient` interface だけが見える。

---

### T-02-02 AISdkClient (Vercel AI SDK 実装)

**何を実装するか**:
- `packages/agents/lib/ai-sdk-client.ts` に `AISdkClient` クラス
- コンストラクタ: `{ provider, model }`
- `provider` に応じて `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google` を選択
- `complete()`: `generateText` または `generateObject`（`responseSchema` 指定時）。usage → `LLMCompleteResult.usage`
- `stream()`: `streamText`
- `cost_jpy` は `model_catalog.find` で取得した最新単価 × usage で算出（fetchPriceSnapshot ヘルパ）
- リトライ: `p-retry` で 3 回 (RateLimit/5xx のみ)、指数バックオフ
- 単体テスト: msw で 3 provider の応答をモックして `complete()` の usage / cost 計算を検証

**参照すべき設計書セクション**:
- `docs/03 §A-01, A-04`
- `docs/05 §6.1.1`

**完了の判定方法**:
- msw mock で 3 provider 全てが usage を返す
- RateLimit 429 で 3 回まで自動リトライ

---

### T-02-03 AgentSdkClient (Anthropic Agent SDK 実装)

**何を実装するか**:
- `packages/agents/lib/agent-sdk-client.ts` に `AgentSdkClient`
- `@anthropic-ai/claude-agent-sdk` を使い、`tools: ['web_search_20250305']` を許可
- Marketer 役（F-001）からのみ使われる前提
- `complete()` は agent loop 完了後にテキストを返す
- usage は SDK の集計を使用
- 単体テスト: msw で `web_search` tool 呼出を含む応答をモック

**参照すべき設計書セクション**:
- `docs/03 §A-02 §C-05 §C-06`
- `docs/05 §6.1.1`

**完了の判定方法**:
- `web_search` を含む応答をパースしてテキスト + usage を返す
- model が anthropic 以外なら `ConfigError` throw

---

### T-02-04 withTokenLogging ミドルウェア + createAgentClient ファクトリ

**何を実装するか**:
- `packages/agents/lib/with-token-logging.ts` に `docs/05 §6.2` のコード片そのまま実装
  - Proxy で `complete` 呼出を intercept
  - 完了後に `prisma.tokenUsage.create()` + `updateBookCost(bookId, costJpy)` (atomic increment)
- `packages/agents/lib/llm-client-factory.ts` に `createAgentClient(role, genre, ctx)`:
  - DB から `ModelAssignment` を引く（`docs/05 §6.1.2`）
  - 二層判定: `role === 'marketer' && provider === 'anthropic'` → `AgentSdkClient`
  - それ以外 → `AISdkClient`
  - `withTokenLogging(client, ctx)` でラップして返却
- `updateBookCost` ヘルパは `UPDATE books SET cost_jpy_total = cost_jpy_total + $1 RETURNING cost_jpy_total` の atomic クエリ
- 単体テスト: 1 回 complete 呼出で `token_usage` 1 行が必ず INSERT される / `Book.cost_jpy_total` が増加

**参照すべき設計書セクション**:
- `docs/05 §6.2` 全文
- `docs/05 §14 #8` atomic increment
- `CLAUDE.md` Hard Rule 5

**完了の判定方法**:
- Vitest で 1 complete = 1 INSERT を assert
- Book.cost_jpy_total が同時並列 5 呼出後に正確に加算される（並列テスト）

---

### T-02-05 prompt-loader.ts

**何を実装するか**:
- `packages/agents/lib/prompt-loader.ts` に `loadActivePrompt(role, genre)`:
  - 第一優先: `prompts WHERE role=? AND genre=? AND status='active'`
  - フォールバック: `genre IS NULL` の active
  - 見つからなければ `ConfigError`
- `fillPlaceholders(template, data)`: `{title}` 等を data から差込
- 単体テスト: 4 ケース（genre 指定あり active / なし fallback / 両方なし throw / プレースホルダ差込）

**参照すべき設計書セクション**:
- `docs/02 F-027` 受け入れ基準
- `docs/05 §6.3` 全エージェントが使う

**完了の判定方法**: 4 ケースのテスト PASS

---

### T-02-06 image-gen.ts + sharp 後処理 (枠)

**何を実装するか**:
- `packages/agents/tools/image-gen.ts`: OpenAI gpt-image-1 を `openai` SDK で呼出
- 入力: `{ prompt, width, height, count }` → 出力: `{ images: Buffer[], cost_jpy }`
- `withTokenLogging` 相当の image 用ヘルパ `withImageLogging` を実装（`role: 'thumbnail_image'`, `image_count`）
- sharp 後処理（KDP 寸法へのアップスケール）は **このタスクでは枠だけ**（SP-05 で本実装）
- 単体テスト: msw で OpenAI image API モック → cost_jpy 算出 + token_usage INSERT 検証

**参照すべき設計書セクション**:
- `docs/03 §C-07 §E-04`
- `docs/05 §10.1` image 用ヘルパ
- `docs/05 §12 OQ-D-08` 画像単価

**完了の判定方法**:
- mock 画像生成 1 回で `token_usage` 1 行（`image_count=1`, `role='thumbnail_image'`）

---

### T-02-07 BookLock 取得/解放ヘルパ + 期限切れ掃除

**何を実装するか**:
- `packages/agents/lib/book-lock.ts` に `acquireBookLock(bookId, holder, ttlMin = 30)` / `releaseBookLock(bookId)` / `sweepExpiredLocks()`
- acquire: `INSERT INTO book_locks (...) ON CONFLICT (book_id) DO NOTHING RETURNING *`。NULL なら衝突として `ConflictError`
- release: `DELETE WHERE book_id AND holder = $`（他 holder のロックは解放しない）
- sweep: `DELETE WHERE expires_at < now()` を 1 時間 cron で実行（`apps/worker/src/tasks/locks.sweep.ts`）
- crontab に追記: `0 * * * * locks.sweep`
- 単体テスト: 同時 2 並列 acquire で 1 つだけ成功 / expires 後に再 acquire 可能 / 他 holder release 不可

**参照すべき設計書セクション**:
- `docs/05 §14 #4` BookLock
- `docs/05 §12 OQ-D-05`

**完了の判定方法**: 並列テスト含む 3 ケース PASS

---

### T-02-08 fx.fetch タスク + ModelCatalog 永続化

**何を実装するか**:
- `apps/worker/src/tasks/fx.fetch.ts`: `FX_RATE_API_URL` (`open.er-api.com/v6/latest/USD`) から USD/JPY 取得
- 結果を一時保存（`AppSettings.id='singleton'` に `latest_fx_rate` 列を追加するか、または in-memory KV 風に `ModelCatalog` の最新行参照）→ シンプルに `app_settings.latest_fx_rate Decimal(10,4)` 列を追加（マイグ）
- 失敗時は前回値継続使用 + warn ログ
- `docs/05 §5.4` crontab に既に `55 18 * * * fx.fetch` がある
- 単体テスト: msw で API 応答モック / 失敗時の継続使用

**参照すべき設計書セクション**:
- `docs/03 §B-04`
- `docs/05 §5.3.13`

**完了の判定方法**: msw テスト PASS / `app_settings.latest_fx_rate` が更新される

---

### T-02-09 catalog.fetch タスク + スクレイピング + 単価変動アラート

**何を実装するか**:
- `apps/worker/src/tasks/catalog.fetch.ts`:
  1. Anthropic / OpenAI / Google の SDK `models.list()` 呼出
  2. 各 provider の pricing ページから `cheerio` で `input_price_per_mtok_usd` / `output_price_per_mtok_usd` / `image_price_per_image_usd` 抽出
  3. `app_settings.latest_fx_rate` を `fx_rate_usd_jpy` として使用
  4. `ModelCatalog` upsert: 既存最新行を `is_current=false` 化、新行を `is_current=true` で INSERT（`@@unique([provider, model, fetched_at])` で重複防止）
  5. 前日同モデルと比較し ±10% 超変動なら `Alert` INSERT + `sendMail({ template: 'pricing-changed' })`
  6. スクレイピング失敗時は前日値継続使用 (`is_current` 変更せず) + `catalog_fetch_failed` Alert
- ソース文字列規約: `anthropic_pricing_page_v1` / `openai_pricing_v2` / `google_pricing_v1`
- 単体テスト: 3 provider 全成功 / 1 provider 失敗で前日値継続 / ±10% 変動でアラート

**参照すべき設計書セクション**:
- `docs/03 §B-01〜B-05`
- `docs/05 §5.3.12`

**完了の判定方法**:
- 3 ケースの統合テスト PASS（Testcontainers + msw）
- 実装後に手動で `pnpm exec tsx apps/worker/src/tasks/catalog.fetch.ts` 実行できる

---

### T-02-10 S-020 モデル単価カタログ UI + 手動更新

**何を実装するか**:
- `apps/web/app/(app)/models/catalog/page.tsx` (S-020):
  - RSC で `prisma.modelCatalog.findMany({ where: { is_current: true } })`
  - CatalogTable: 列 [provider / model / 入力単価/1k / 出力単価/1k / 1 冊予測コスト / 更新日時 / ソース / 前回比 ±%]
  - ソート（列クリック）+ フィルタ（provider）
  - CsvExportButton: GET `/api/model-catalog/export.csv`
  - ManualRefreshButton: SA `refreshModelCatalog()` → `graphileWorker.add_job('catalog.fetch', { trigger: 'manual' })`
  - PriceChangeHistory: 過去 30 日の Alert 一覧
- `apps/web/app/actions/model-catalog.ts` に `refreshModelCatalog()` と `editCatalogEntry()` SA（`docs/05 §4.3.10` 完全準拠）
- 編集 SA は `audit_log` に before/after 記録
- 参照: `docs/wireframes/S-020-model-catalog/prompt.md`

**参照すべき設計書セクション**:
- `docs/04 S-020`
- `docs/05 §4.3.10`

**完了の判定方法**:
- S-020 で全行表示 + ソート/フィルタ動作
- ManualRefresh で job が enqueue され、完了後にテーブル再描画
- 手動編集が `audit_log` に記録

---

### T-02-11 S-019 モデル割当 UI + 切替 SA + 履歴

**何を実装するか**:
- `apps/web/app/(app)/models/assignments/page.tsx` (S-019):
  - AssignmentMatrix: 縦 = 役割 7 件 × 横 = ジャンル 4 列（default + 3 ジャンル）。各セルに「provider/model + 単価」
  - ModelCatalogSidePane: 右側に `ModelCatalog (is_current=true)` リスト
  - AssignmentEditor (Drawer): セルクリックで開く。provider / model プルダウン + 「変更前後コスト差」プレビュー（過去 30 日 token_usage 集計）
  - AssignmentHistoryTable: `ModelAssignment WHERE role=?, genre=?` を `activated_at DESC` で
  - 「過去版に戻す」ボタン → `revertModelAssignment(id)` SA
- `apps/web/app/actions/model-assignments.ts` に `upsertModelAssignment` / `revertModelAssignment` SA（`docs/05 §4.3.9`）
- upsert SA は active 切替時に旧 active を `archived` に + `audit_log` 記録 + トースト「次回ジョブから適用されます」
- 参照: `docs/wireframes/S-019-model-assignments/prompt.md`

**参照すべき設計書セクション**:
- `docs/04 S-019`
- `docs/05 §4.3.9`
- `docs/02 F-022 F-023` 受け入れ基準
- `docs/05 §13 #4` audit_log

**完了の判定方法**:
- 7 役 × 4 列の matrix 表示
- セル編集 → upsert → 進行中ジョブは旧モデル、次回から新モデル
- 過去版に戻すで履歴から復元
- audit_log に before/after 記録

---

### T-02-12 CI ガード: 生クライアント禁止 + token_usage 必須

**何を実装するか**:
- `scripts/check-llm-client-usage.ts`:
  - `grep -r "new AISdkClient\|new AgentSdkClient" --include="*.ts"` を実行
  - `packages/agents/lib/` 配下と `__tests__/` 以外で見つかったら exit 1
- GitHub Actions CI に `pnpm exec tsx scripts/check-llm-client-usage.ts` ジョブ追加
- `docs/05 §10.1` の規約をリポジトリの `CONTRIBUTING.md` に追記

**参照すべき設計書セクション**:
- `docs/05 §10.1` トークン記録漏れ防止
- `CLAUDE.md` Hard Rule 5

**完了の判定方法**:
- 意図的に `apps/web/lib/foo.ts` で `new AISdkClient()` を書くと CI fail
- 削除すると PASS

---

### T-02-13 ApiCredential DB 基盤 + getApiKey ヘルパ + env zod 任意化

**背景**:
- 当初 4 プロバイダ API キーは `.env.local` 経由のみだったが、F-051/F-052 で UI 設定（S-027）対応が決まった
- S-027 UI 本体は SP-07 で実装するが、**取得 API（`getApiKey('anthropic')`）と DB スキーマは SP-02 序盤で確立** しておかないと、後続 T-02-03/04/06/09 が env 直読みで書かれて手戻りが発生する
- 同時に `env.ts` の optional フィールド（TAVILY_API_KEY / SENTRY_DSN / NEXTAUTH_URL / KDP_CRED_KEY）が **空文字列を `.min(1)` で弾く既知バグ** を解消する（Sprint 1 終了時に手動で `.env.local` から行を削除して回避中）

**何を実装するか**:

1. **Prisma スキーマ追加** (`packages/db/schema.prisma`)
   ```prisma
   model ApiCredential {
     id                    String    @id @default(cuid())
     provider              String    @unique  // 'anthropic' | 'openai' | 'google'
     key_enc               String    @db.Text  // AES-256-GCM 暗号化（KDP_CRED_KEY と同一鍵 or 別鍵）
     key_mask              String    // 表示用マスク "sk-...AbCd" (先頭3 + 末尾4)
     set_at                DateTime  @default(now())
     set_by                String    // User.id
     last_tested_at        DateTime?
     last_test_result_json Json?     // { ok: bool, message: string, http_status?: number, latency_ms?: number }
     @@map("api_credentials")
   }
   ```
   - Prisma migration 1 本: `add_api_credentials`
   - 暗号化は `packages/crypto/src/api-credentials.ts` 新規（KDP_CRED_KEY 流用 or 別環境変数 `API_CRED_KEY` を新設 — **後者推奨**、責務分離のため `.env.example` / `env.ts` にも追記）

2. **暗号化ヘルパ** (`packages/crypto/src/api-credentials.ts`)
   - `encryptApiKey(plain: string): string` — base64(iv ‖ authTag ‖ ciphertext)
   - `decryptApiKey(enc: string): string`
   - `maskApiKey(plain: string): string` — `'sk-...AbCd'` 形式
   - 既存 `kdp-credentials.ts` のパターン踏襲、`ValidationError` を継承

3. **Server Actions** (`apps/web/app/actions/api-credentials.ts`) — UI は SP-07 だが SA は今作る
   - `setApiCredential({ provider, key })` — 暗号化して upsert + audit_log
   - `revokeApiCredential({ provider })` — delete + audit_log
   - `testApiCredential({ provider })` — 該当 provider の `models.list` を叩き `last_test_result_json` 更新（Anthropic は `client.models.list()` / OpenAI 同 / Google は `ai.models.list()`）
   - すべて zod 入力検証 + `auth()` ガード

4. **getApiKey ヘルパ** (`packages/agents/lib/get-api-key.ts`)
   - シグネチャ: `async function getApiKey(provider: 'anthropic' | 'openai' | 'google'): Promise<string>`
   - 1st: `prisma.apiCredential.findUnique({ where: { provider } })` → 復号して返す
   - 2nd: `process.env[mapEnv(provider)]` を返す（フォールバック）
   - どちらも無ければ `ConfigError`
   - **60秒 LRU キャッシュ**（`lru-cache` パッケージ、key=provider）— UI 更新時にキャッシュ無効化する `invalidateApiKeyCache(provider)` も export
   - 4 プロバイダ目（TAVILY）は将来追加なので今は 3 種のみ対応

5. **env.ts 修正** (`packages/contracts/src/env.ts`)
   - 4 プロバイダキー（ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / TAVILY_API_KEY）を `.optional()` 化（DB 経由優先になるため）
   - **全 optional フィールドで空文字列を undefined にする preprocess を追加**（Task #41 のスコープ統合）：
     ```ts
     const emptyToUndef = (schema: z.ZodTypeAny) =>
       z.preprocess((v) => (v === '' ? undefined : v), schema);
     ```
     対象: TAVILY_API_KEY / SENTRY_DSN / NEXTAUTH_URL / KDP_CRED_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
   - `.env.example` の TAVILY_API_KEY と SENTRY_DSN のコメント更新（「空文字でも未設定扱いになる」と明記）
   - `.env.local` のコメントアウトしている `# TAVILY_API_KEY=` / `# SENTRY_DSN=` をそのまま空文字復活させても動くようになる（運営者の利便性向上）

6. **API_CRED_KEY env 追加** (`.env.example`, `packages/contracts/src/env.ts`, `scripts/check-env-example.ts`)
   - `KDP_CRED_KEY` と同様、`API_CRED_KEY=<64-hex-chars>` を追加（32 bytes hex、暗号化鍵）
   - Phase 1 で必須（Phase 3 KDP より早い）

7. **Vitest テスト**
   - `packages/crypto/__tests__/api-credentials.test.ts` — encrypt/decrypt round-trip / mask 形式 / 改ざん検知
   - `apps/web/__tests__/actions/api-credentials.test.ts` — set/revoke/test SA / 認可 / audit_log
   - `packages/agents/__tests__/get-api-key.test.ts` — DB 優先 / env フォールバック / LRU キャッシュ動作 / invalidate / ConfigError
   - `packages/contracts/__tests__/env.test.ts` — 空文字 → undefined preprocess の挙動（既存テストに追加）

8. **既存 .env.local の整理**
   - `.env.local` の `TAVILY_API_KEY=` (空) / `SENTRY_DSN=` (空) のコメントアウトを解除（行を復活）— preprocess で undefined 扱いされるので OK
   - `.env.local` に `API_CRED_KEY=<生成済み 64-hex>` を追加（programmer が openssl で生成して書き込む）

**参照すべき設計書セクション**:
- `docs/02 F-051 F-052` 受け入れ基準
- `docs/03 §5` env 一覧（API_CRED_KEY 追加）
- `docs/05 §3` ApiCredential model（既存 30 model + 1 で 31 model に）
- `docs/05 §4.3.X` （F-051 SA）
- `docs/05 §6.X` getApiKey ヘルパ位置付け
- `packages/crypto/src/kdp-credentials.ts` 既存パターン（GCM 形式 / ValidationError 階層）

**完了の判定方法**:
- Prisma migration が clean apply（既存マイグから追加で 1 本のみ）
- `getApiKey('anthropic')` を DB 未登録状態で呼ぶと env フォールバックで `sk-ant-...` を返す
- `setApiCredential` で DB 登録後、次回 `getApiKey` 呼び出し（60秒以内）は DB 経路で返る（暗号化解除値）
- `invalidateApiKeyCache('anthropic')` で即座に DB 再読みに切替わる
- env.ts の preprocess で TAVILY_API_KEY=（空文字）が optional パスで通る（既存 `.env.local` のコメントを外して動作確認）
- 全 Vitest PASS
- `pnpm check:env` が 29 keys（28 + API_CRED_KEY）で OK
- 既存の Worker が再起動後も `.env.local` の `TAVILY_API_KEY=`（空）を空文字 → undefined 経由で受け入れて起動できる

---

### T-02-14 Playwright E2E 基盤（SP-09 から前倒し）

**背景**:
- SP-01 では Vitest 単体テストのみで T-01-09 (ログイン) / T-01-10 (レイアウト) を検証し、ブラウザ動作は手動確認した
- 以降の SP で UI を含む受入条件を Playwright で **真の E2E** として確認できる土台を SP-02 序盤で整える
- これにより SP-02 T-02-10 / T-02-11 (S-019/S-020 UI) の Playwright スペックも実コードに対して実行可能になる

**何を実装するか**:

1. **依存追加**
   - `apps/web` または ルートに `@playwright/test` (devDependencies) を追加
   - `pnpm exec playwright install chromium` を CI でキャッシュ

2. **`playwright.config.ts`** (ルート)
   ```ts
   export default defineConfig({
     testDir: './tests/e2e',
     baseURL: 'http://localhost:3001',
     workers: 1,            // 単一ユーザー前提、並列なし
     reporter: [['list'], ['html', { open: 'never' }]],
     use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
     projects: [
       { name: 'setup',  testMatch: /global\.setup\.ts/ },
       { name: 'chromium', use: { ...devices['Desktop Chrome'], storageState: 'tests/e2e/.auth/user.json' }, dependencies: ['setup'] },
     ],
   });
   ```

3. **`tests/e2e/global.setup.ts`**: 起動時に `operator` / `Miyata11` 相当でログイン → `storageState` を `tests/e2e/.auth/user.json` に保存（以降の spec は認証済みコンテキストで実行）

4. **`tests/e2e/fixtures/db.ts`**: テスト前に `truncate` 系のクリーンアップ helper（`User` `AppSettings` `Prompt` `ModelAssignment` は維持、Book/Project 等のみクリア）

5. **`tests/e2e/fixtures/auth.ts`**: テスト内で SA 経由のログアウト/ロックアウト動作確認用 helper（必要に応じて storageState を一時破棄）

6. **`tests/e2e/smoke-login-dashboard.spec.ts`** (最初の本物 E2E)
   - ログイン画面表示
   - 正規認証情報でログイン → ダッシュボード遷移
   - 誤認証情報 → エラーメッセージ表示
   - ロックアウト発火（5 連続失敗 → 423 ロック画面）

7. **`apps/web/` の `data-testid` 付与**
   - ログインフォーム: `data-testid="login-username"` / `login-password` / `login-submit` / `login-error`
   - ダッシュボード: `data-testid="dashboard-root"` / `sidebar-nav`

8. **CI ジョブ**: `.github/workflows/ci.yml` に `test-e2e` ジョブ追加
   - 前提: PostgreSQL service container 起動、`prisma migrate deploy` + `seed`
   - `pnpm --filter @a2p/web build && pnpm --filter @a2p/web start &` で Web 起動
   - `pnpm exec playwright test`
   - 失敗時 `playwright-report/` を artifact として upload

**参照すべき設計書セクション**:
- `docs/05 §11` テスト戦略
- `docs/02` 機能要件のユースケース（ログインのハッピー/エラーパス）

**完了の判定方法**:
- `pnpm exec playwright test smoke-login-dashboard` がローカルで PASS
- CI で同 spec が PASS
- 以降の SP で新規 spec を追加するだけで実行できる土台がある

---

## 5. テスト計画

### 5.1 Vitest

| ファイル | 対象 | 内容 |
|---|---|---|
| `packages/agents/__tests__/ai-sdk-client.test.ts` | T-02-02 | msw 3 provider mock / RateLimit リトライ / cost_jpy 計算 |
| `packages/agents/__tests__/agent-sdk-client.test.ts` | T-02-03 | web_search tool 含む応答パース |
| `packages/agents/__tests__/with-token-logging.test.ts` | T-02-04 | 1 complete = 1 INSERT / 並列 Book.cost_jpy_total atomic |
| `packages/agents/__tests__/llm-client-factory.test.ts` | T-02-04 | Marketer+Anthropic → AgentSdk / それ以外 → AISdk |
| `packages/agents/__tests__/prompt-loader.test.ts` | T-02-05 | 4 ケース fallback |
| `packages/agents/tools/__tests__/image-gen.test.ts` | T-02-06 | image_count=1 で token_usage INSERT |
| `packages/agents/__tests__/book-lock.test.ts` | T-02-07 | 並列 acquire 1 だけ成功 / expires 再 acquire |
| `apps/worker/__tests__/tasks/fx.fetch.test.ts` | T-02-08 | API 成功/失敗 |
| `apps/worker/__tests__/tasks/catalog.fetch.test.ts` | T-02-09 | 3 provider 成功 / 1 失敗継続 / ±10% アラート |
| `apps/web/__tests__/actions/model-assignments.test.ts` | T-02-11 | upsert + audit_log / revert |

### 5.2 Playwright（E2E）

- `tests/e2e/sp02-model-catalog.spec.ts`: S-020 表示 → 手動更新 → 完了確認
- `tests/e2e/sp02-model-assignments.spec.ts`: S-019 で Writer × default の provider 切替 → 履歴に追加 → 過去版に戻す

---

## 6. 完了判定

1. 全 14 タスクが `## DONE` まで到達
2. **マルチプロバイダ二層** (`AISdkClient` + `AgentSdkClient`) が動作し、`createAgentClient` 経由で `token_usage` が 100% 記録される
3. `catalog.fetch` が 3 provider 全件取得 + ±10% 変動アラート発火を確認
4. S-019 / S-020 が動作し、運営者がモデル切替操作で `audit_log` に記録される
5. CI ガードが「`packages/agents/lib/` 外の生クライアント」を検出して fail する
6. `BookLock` の acquire/release/sweep が並列テストで安全
7. `docs/03 §10` 申し送り 1, 2 と `docs/05 §13` 申し送り 4, 6 が反映済み
8. **Playwright 基盤** (T-02-14) が動作し、`smoke-login-dashboard.spec.ts` がローカル + CI で PASS。S-019/S-020 の Playwright spec (§5.2) も実コードに対して実行・PASS
9. **完了確認**: pm を `MODE: REVIEW TARGET: SP-02` で再起動し `## PHASE_COMPLETE` が返る
