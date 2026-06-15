# SP-03 marketer-themes-bulk

## 1. 目的

Marketer エージェントによるテーマ候補生成 (F-001) と KDP メタデータ生成 (F-040) を実装し、テーマバルク承認 UI (F-017) と夜間バッチ計画 UI (F-021) を経由して `Book` レコード + `pipeline.book.kickoff` ジョブが起動する一連の入口フローを完成させる。SP-04 以降の Writer/Editor パイプラインに「採用済みテーマ」を流し込む基盤。

## 2. 対応機能 ID

- **F-001** マーケター: テーマ候補生成（Web Search 利用）
- **F-010** 書籍ジョブの作成・キック
- **F-017** テーマ候補のバルク採用/却下
- **F-021** 夜間バッチ計画 UI
- **F-040** KDP 入稿用メタデータ生成
- 対応画面: **S-006** テーマ候補一覧、**S-007** テーマ候補詳細、**S-008** 新規プロジェクト/夜間バッチ計画

## 3. タスク一覧

| ID | 状態 | タスク | 概要 | 対応機能/画面 | 工数 |
|---|---|---|---|---|---|
| T-03-01 | ✅ | Marketer エージェント実装（テーマ生成） | `packages/agents/marketer/theme.ts` で `MarketerThemeInput/Output` zod 準拠の関数 | F-001 | M |
| T-03-02 | ✅ | Marketer エージェント実装（KDP メタデータ） | `packages/agents/marketer/metadata.ts` で `MarketerMetadataInput/Output` 準拠 | F-040 | M |
| T-03-03 | ✅ | Tavily フォールバックアダプタ（I/F のみ） | `packages/agents/tools/web-search.ts` で Anthropic 内蔵/Tavily を切替する I/F。実装は Anthropic 側のみ | A-03, R-04 | S |
| T-03-04 | ✅ | `pipeline.book.marketer` ワーカタスク | `apps/worker/src/tasks/pipeline.book.marketer.ts` 完全実装。テーマ精査 + メタデータ生成 → `KdpMetadata` INSERT | F-001, F-040 | M |
| T-03-05 | ✅ | `pipeline.book.kickoff` ワーカタスク | `apps/worker/src/tasks/pipeline.book.kickoff.ts` 完全実装。`Book` 作成 + `model_assignment_snapshot` 確定 + `pipeline.book.marketer` 子 enqueue | F-010 | M |
| T-03-06 | ✅ | テーマ生成 SA + `generateThemes` ジョブ | `actions/themes.ts` の `generateThemes` SA。`theme_session_id` 発行 → 単発 worker タスク `pipeline.theme.generate` 起動 → `ThemeCandidate` 一括 INSERT | F-001 | M |
| T-03-07 | ✅ | S-006 テーマ候補一覧 + バルク承認 SA | RSC で一覧 + ThemeCandidatesTable + BulkActionBar + `bulkDecideThemes` / `acceptThemesAndStageBatch` SA | F-017, S-006 | L |
| T-03-08 | ✅ | S-007 テーマ候補詳細 | ThemeDetailHeader + CompetitorsTable + WebSearchSnippetList + ActionButtonGroup（コメント機能枠は SP-06） | S-007 | M |
| T-03-09 | ✅ | S-008 夜間バッチ計画 UI + 予測コスト計算 | SelectedThemesList + BatchScheduleForm + ModelAssignmentPreview + CostForecastCard + `createBatchPlan` `kickBatchNow` SA | F-010, F-021, S-008 | L |
| T-03-10 | ✅ | バッチ計画スケジューラ（cron + planned_at 起動） | crontab `* * * * *` で `BatchPlan WHERE status='scheduled' AND planned_at <= now()` を一括 kick | F-021 | M |
| T-03-11 | ✅ | SSE 進捗配信 `/api/sse/jobs` 基本実装 | `pg_notify` 購読 → SSE 形式で配信 / 認証チェック / ハートビート 30 秒 | docs/05 §1.4, §4.2.1 | M |

合計 **11 タスク**、すべて完了。

---

## 4. タスク詳細

### T-03-01 Marketer エージェント実装（テーマ生成）

**何を実装するか**:
- `packages/agents/marketer/theme.ts` に `generateThemes(input: MarketerThemeInput): Promise<MarketerThemeOutput>`
- `createAgentClient('marketer', null, { themeSessionId })` で client 取得
- `loadActivePrompt('marketer', genre)` でプロンプト取得 → プレースホルダ差込
- `exclude_titles_recent` を prompt に含めて重複回避
- `client.complete({ responseSchema: MarketerThemeOutput })` で structured output
- 失敗時は `AgentError` throw
- 単体テスト: msw mock で 10 件生成 / 重複タイトル除外 / token_usage 記録

**参照すべき設計書セクション**:
- `docs/05 §6.3.1` Marketer
- `docs/02 F-001` 受け入れ基準
- `docs/05 §14 #6` theme_session_id

**完了の判定方法**:
- 10 件生成テスト PASS
- 各テーマに competitor 1 件以上 URL
- token_usage が `theme_session_id` 紐付けで記録

---

### T-03-02 Marketer エージェント実装（KDP メタデータ）

**何を実装するか**:
- `packages/agents/marketer/metadata.ts` に `generateMetadata(input: MarketerMetadataInput): Promise<MarketerMetadataOutput>`
- `Book` 行と関連テーマを DB から取得 → prompt 注入
- structured output で description / categories / keywords / suggested_price_jpy
- KDP 上限値検証（description ≤ 4000 文字、keywords ≤ 7 個、categories = 2 個）。違反は AgentError
- 単体テスト: 上限値ケース / 違反ケース

**参照すべき設計書セクション**:
- `docs/05 §6.3.1` Marketer (Metadata)
- `docs/02 F-040` 受け入れ基準

**完了の判定方法**: 単体テスト PASS

---

### T-03-03 Tavily フォールバックアダプタ（I/F のみ）

**何を実装するか**:
- `packages/agents/tools/web-search.ts` に `searchWeb(query: string): Promise<WebSearchResult[]>`
- 実装は Anthropic 内蔵を `AgentSdkClient` 経由でしか使わないため、Tavily 側は **I/F + 環境変数 `TAVILY_API_KEY` チェック** のみ
- 関数本体は throw `not_implemented`（Phase 2 で実装）
- 切替判定: `model_assignments` の Marketer が anthropic 以外なら Tavily（将来用）

**参照すべき設計書セクション**:
- `docs/03 §A-03`
- `docs/05 §6.3.1`

**完了の判定方法**: I/F 定義のみ + Tavily 呼出ケースで NotImplementedError

---

### T-03-04 `pipeline.book.marketer` ワーカタスク

**何を実装するか**:
- `apps/worker/src/tasks/pipeline.book.marketer.ts` を完全実装
- `PipelineBookMarketerPayload` で受信
- `acquireBookLock(book_id, 'pipeline:<job_id>', 30)` → 失敗時は再キュー
- `generateMetadata(book_id)` 呼出 → `KdpMetadata` INSERT
- 完了時に `pipeline.book.writer.outline` 子 enqueue
- 失敗時は `Job.status='failed'`、`max_attempts=3` で再試行
- 冪等性: 開始時に `Job` 行を CAS で `running` 更新、既存 done ならスキップ

**参照すべき設計書セクション**:
- `docs/05 §5.2` 共通ポリシー
- `docs/05 §5.3.2` pipeline.book.marketer
- `docs/05 §13 #5` 冪等性チェックリスト

**完了の判定方法**:
- 同一 job_id を 2 回実行しても `KdpMetadata` は 1 件
- BookLock 取得 → 解放まで遷移

---

### T-03-05 `pipeline.book.kickoff` ワーカタスク

**何を実装するか**:
- `apps/worker/src/tasks/pipeline.book.kickoff.ts` 完全実装
- `PipelineBookKickoffPayload` で `theme_id` `account_id` `model_assignment_overrides` 受信
- DB トランザクション内で:
  1. `Book` INSERT（status=queued）
  2. 現在の `ModelAssignment` 一覧 + override をマージし `model_assignment_snapshot` JSON を確定
  3. 関連 `prompts` の active id を `prompt_version_ids_json` に snapshot
  4. `theme_candidates.status='accepted'` + `decided_at=now()`
  5. `BatchPlanItem.book_id` を紐付け（あれば）
- 完了時に `pipeline.book.marketer` 子 enqueue
- 単体テスト: 並列 5 kickoff で 5 冊作成 / snapshot が DB の現値と一致

**参照すべき設計書セクション**:
- `docs/05 §5.3.1` pipeline.book.kickoff
- `docs/02 F-010` 受け入れ基準

**完了の判定方法**: 5 冊並列キック → 5 books 作成 + 5 marketer 子 enqueue

---

### T-03-06 テーマ生成 SA + ジョブ

**何を実装するか**:
- `apps/web/app/actions/themes.ts` の `generateThemes` SA（`docs/05 §4.3.3` 準拠）
- `theme_session_id = cuid()` 発行 → worker タスク `pipeline.theme.generate` enqueue（新規追加）
- 新タスク `apps/worker/src/tasks/pipeline.theme.generate.ts`:
  - 既出版書籍タイトル取得（90 日以内）
  - `generateThemes()` 呼出
  - 結果を `ThemeCandidate` テーブルに一括 INSERT（`theme_session_id` 紐付け）
- SA 戻り値: `{ session_id, job_id }`
- 単体テスト: 10 件 INSERT / 重複除外 / token_usage 紐付け

**参照すべき設計書セクション**:
- `docs/05 §4.3.3` `docs/05 §6.3.1`
- `docs/02 F-001` 受け入れ基準

**完了の判定方法**: SA 呼出 → ジョブ完了で 10 件 INSERT

---

### T-03-07 S-006 テーマ候補一覧 + バルク承認 SA

**何を実装するか**:
- `apps/web/app/(app)/themes/page.tsx` (S-006):
  - フィルタバー（account / genre / 日時 / status）
  - GenerateThemesModal（生成数指定 → `generateThemes` SA）
  - ThemeCandidatesTable (DataTable with checkbox + pagination)
  - BulkActionBar 下部固定: 「採用」「却下」「採用してバッチ計画へ」
- SA: `bulkDecideThemes` / `acceptThemesAndStageBatch`（`docs/05 §4.3.3`）
- 「採用してバッチ計画へ」は採用後に `redirect_to: '/batches/new?theme_ids=...'` を返し UI でハンドオフ
- 1 操作で 20 件以上を承認できる（F-017 受け入れ基準）
- 参照: `docs/wireframes/S-006-themes-bulk/prompt.md`

**参照すべき設計書セクション**:
- `docs/04 S-006` / `docs/05 §4.3.3`

**完了の判定方法**:
- 20 件以上を一括承認可能（E2E）
- 「採用してバッチ計画へ」で S-008 に theme_ids 引き継ぎ

---

### T-03-08 S-007 テーマ候補詳細

**何を実装するか**:
- `apps/web/app/(app)/themes/[id]/page.tsx` (S-007):
  - ThemeDetailHeader / CompetitorsTable / WebSearchSnippetList / ActionButtonGroup
  - CommentPanel は **枠だけ**（SP-06 で本実装）
  - 採用ボタン → `bulkDecideThemes({ theme_ids: [id], decision: 'accept' })`
- 参照: `docs/wireframes/S-007-theme-detail/prompt.md`

**完了の判定方法**: 詳細表示 + 採用動作

---

### T-03-09 S-008 夜間バッチ計画 UI + 予測コスト

**何を実装するか**:
- `apps/web/app/(app)/batches/new/page.tsx` (S-008):
  - SelectedThemesList（query string `theme_ids` から復元）
  - BatchScheduleForm（start_at / concurrency 1-5 / deadline）
  - ModelAssignmentPreview（S-019 のサブセット + override option）
  - CostForecastCard: `sum(theme数 × 推定 1 冊コスト)` を `ModelCatalog` × `model_assignments` から算出
  - F-036 月次予算超過検出 → ボタン disabled + 強制続行スイッチ
  - 「バッチ保存」「即時キック」ボタン
- SA: `createBatchPlan` / `kickBatchNow`（`docs/05 §4.3.4`）
- 即時キック後は `/dashboard` に遷移
- 参照: `docs/wireframes/S-008-batch-plan/prompt.md`

**参照すべき設計書セクション**:
- `docs/04 S-008` / `docs/05 §4.3.4`
- `docs/02 F-021 F-036` 受け入れ基準

**完了の判定方法**:
- 5 件選択 + 並列度 5 + 予測コスト 500 円 表示
- 月次超過予測時に kick disabled

---

### T-03-10 バッチ計画スケジューラ

**何を実装するか**:
- 新タスク `apps/worker/src/tasks/batch.dispatch.ts`:
  - `BatchPlan WHERE status='scheduled' AND planned_at <= now()` を 1 分 cron でスキャン
  - 該当の各 `BatchPlanItem` に対し `pipeline.book.kickoff` を enqueue（payload に `theme_id`, `account_id`, `batch_plan_item_id`, `override_model_assignments`）
  - `BatchPlan.status='running'`, `kicked_at=now()` に遷移
- crontab に `* * * * * batch.dispatch` 追加
- `BatchPlanItem.status='kicked'` 遷移
- 単体テスト: 過去時刻のバッチが 1 分後 cron で kick される

**完了の判定方法**:
- planned_at 経過バッチが自動で kickoff 起動
- 並列度どおりに graphile-worker が同時実行

---

### T-03-11 SSE 進捗配信 `/api/sse/jobs` 基本実装

**何を実装するか**:
- `apps/web/app/api/sse/jobs/route.ts` を Node ランタイム RH で実装
- `pg.connect()` → `LISTEN jobs` で notify を受信 → `text/event-stream` で client にフォワード（**ADR-001**: `docs/05 §16` でチャネル名 `'jobs'` に統一済）
- イベント形式: `docs/05 §4.2.1` `SseJobEvent`
- 認証チェック: `getSessionOrThrow()` 実行（unauthorized なら 401）
- ハートビート 30 秒
- query `bookId` で書籍別フィルタ
- Worker 側（既存タスクに追加）: 状態変化時に `pg_notify('jobs', JSON)`
- 単体テスト: モック curl で SSE 受信 + heartbeat 検証

**参照すべき設計書セクション**:
- `docs/05 §1.4` `docs/05 §4.2 §4.2.1`

**完了の判定方法**: ブラウザで `/api/sse/jobs` を EventSource で開いてジョブ状態変化が届く

---

## 5. テスト計画

### 5.1 Vitest

| ファイル | 対象 | 内容 |
|---|---|---|
| `packages/agents/marketer/__tests__/theme.test.ts` | T-03-01 | msw mock で 10 件生成 / 重複除外 / token_usage |
| `packages/agents/marketer/__tests__/metadata.test.ts` | T-03-02 | KDP 上限検証 |
| `apps/worker/__tests__/tasks/pipeline.book.kickoff.test.ts` | T-03-05 | 並列 5 kickoff / snapshot 整合 |
| `apps/worker/__tests__/tasks/pipeline.book.marketer.test.ts` | T-03-04 | 冪等 / KdpMetadata INSERT |
| `apps/worker/__tests__/tasks/pipeline.theme.generate.test.ts` | T-03-06 | 10 件 INSERT / theme_session_id |
| `apps/worker/__tests__/tasks/batch.dispatch.test.ts` | T-03-10 | 過去時刻バッチが自動 kick |
| `apps/web/__tests__/actions/themes.test.ts` | T-03-06, T-03-07 | bulkDecideThemes / acceptThemesAndStageBatch |
| `apps/web/__tests__/actions/batches.test.ts` | T-03-09 | createBatchPlan / 月次超過時の rejection |

### 5.2 Playwright（E2E）

- `tests/e2e/sp03-themes-bulk.spec.ts`: テーマ生成 → 一覧表示 → 20 件一括採用 → バッチ計画へハンドオフ → kick → SSE で進捗確認

---

## 6. 完了判定

1. 全 11 タスク `## DONE`
2. **Marketer エージェント**がテーマ 10 件 + KDP メタデータを生成し `token_usage` 記録
3. S-006 で 20 件一括採用 → S-008 で「即時キック」5 件 → 5 並列で `pipeline.book.kickoff` が走る
4. SSE で進捗が UI に届く
5. `batch.dispatch` cron が planned_at 経過バッチを自動起動
6. 月次予算超過時にバッチ kick が disabled
7. **完了確認**: pm を `MODE: REVIEW TARGET: SP-03` で再起動し `## PHASE_COMPLETE` が返る
