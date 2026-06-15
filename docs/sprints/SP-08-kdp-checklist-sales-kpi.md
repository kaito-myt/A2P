# SP-08 kdp-checklist-sales-kpi

## 1. 目的

KDP 入稿チェックリスト (F-020) で運営者が手動で KDP に入稿する流れを支援し、売上手動入力 (F-037) + CSV インポートと売上 KPI ダッシュボード (F-039) を実装する。長期出版プラン (F-002) もここで仕上げ、Phase 1 のビジネスループ（出版 → 売上記録 → 分析）を運用可能状態にする。

## 2. 対応機能 ID

- **F-002** マーケター: アカウント別長期出版プラン提案
- **F-020** KDP 入稿チェックリスト（手動転記支援）
- **F-037** 売上・レビュー手動入力
- **F-039** 書籍別 KPI ダッシュボード
- 対応画面: **S-005** 長期出版プラン、**S-015** KDP 入稿チェックリスト、**S-017** 売上・KPI ダッシュボード、**S-018** 売上手動入力

## 3. タスク一覧

| ID | 状態 | タスク | 概要 | 対応機能/画面 | 工数 |
|---|---|---|---|---|---|
| T-08-01 | ✅ | Marketer エージェント（長期プラン） | `packages/agents/marketer/plan.ts` で publishing_plans 生成 | F-002 | M |
| T-08-02 | ✅ | `regeneratePlan` SA + S-005 UI | PlanCalendar / SeriesGraph (mermaid) / RegeneratePlanButton + 月セルから F-001 起動 | F-002, S-005 | L |
| T-08-03 | ✅ | S-015 KDP 入稿チェックリスト UI | SubmissionChecklistTable + CopyToClipboardButton + BlockReasonBanner (must コメント残) + SubmitToKdpButton (Phase 3 までは disabled) | F-020, S-015 | L |
| T-08-04 | ✅ | `updateChecklist` SA + KdpSubmissionProgress 永続化 | フィールド単位の copied/checked 状態 + ブラウザリロード後も保持 | F-020 | S |
| T-08-05 | ✅ | `upsertSales` / `importSalesCsv` SA | 単件 upsert + CSV インポート（行番号付きエラー） | F-037 | M |
| T-08-06 | ✅ | S-018 売上手動入力 UI | SalesInputForm + CsvImportButton + テンプレート DL | F-037, S-018 | M |
| T-08-07 | ✅ | S-017 売上・KPI ダッシュボード | 期間/アカウント/ジャンルフィルタ / KpiStripe / SalesTrendChart / BooksKpiTable / GenreMonthHeatmap | F-039, S-017 | L |
| T-08-08 | ✅ | 書籍 KPI 集計クエリ + 100 冊 2 秒検証 | SalesRecord + TokenUsage + EvalResult を JOIN 集計、必要に応じてマテリアライズドビュー検討 | F-039 受け入れ基準 | M |
| T-08-09 | ✅ | S-015 → S-016 ハンドオフ枠 (Phase 3 準備) | 「自動入稿」ボタンを Phase 3 で有効化するための SA `submitToKdp` の I/F 定義（実装は SP-15） | F-041 (枠), F-020 連携 | S |

合計 **9 タスク**、すべて完了。

---

## 4. タスク詳細（要点）

### T-08-01 Marketer エージェント（長期プラン）

- `packages/agents/marketer/plan.ts` に `generatePlan(input: { account_id, months, target_count })`
- アカウント既出版実績 + 売上トレンドを DB から取得 → prompt 注入
- structured output: `{ months: Array<{ ym, planned_count, theme_categories, series_candidates }> }`
- 期間内総冊数が target ±20% に収まること（受け入れ基準）
- 既存シリーズあれば続編候補 1 つ以上
- 参照: `docs/05 §6.3.1` / `docs/02 F-002`
- 完了判定: 単体テスト PASS

### T-08-02 regeneratePlan SA + S-005 UI

- `apps/web/app/actions/plans.ts` の `regeneratePlan`（`docs/05 §4.3.2`）
- `apps/web/app/(app)/accounts/[id]/plans/page.tsx` (S-005)（route は柔軟に）
- PlanCalendar: 月セルにテーマカテゴリ + シリーズ候補
- SeriesGraph: mermaid で系統図
- 月セルの「テーマ生成」→ SP-03 の `generateThemes` SA を月ジャンルで呼出 → S-006 へ遷移
- 参照: `docs/wireframes/S-005-publishing-plan/prompt.md`
- 完了判定: プラン生成 + 月セル CTA 動作

### T-08-03 S-015 KDP 入稿チェックリスト UI

- `apps/web/app/(app)/kdp/checklist/page.tsx` (S-015)
- SubmissionChecklistTable: 行 = 1 書籍、列 = タイトル/サブタイトル/著者/紹介文/カテゴリ1/2/キーワード7/価格/カバー URL/本文 URL
- 各セルに CopyToClipboardButton + Checkbox
- BlockReasonBanner: `Book.has_blocking_comments=true` ならブロック + 「コメント一覧へ」リンク (S-013)
- SubmitToKdpButton: Phase 3 まで disabled + tooltip 表示
- 「KDP を新規タブで開く」ボタン: `https://kdp.amazon.co.jp/bookshelf` リンク
- 参照: `docs/wireframes/S-015-kdp-checklist/prompt.md`
- 完了判定: 5 書籍のチェック進捗が保存されリロード後も表示

### T-08-04 updateChecklist SA

- `apps/web/app/actions/kdp-checklist.ts` の `updateChecklist`（`docs/05 §4.3.16`）
- `KdpSubmissionProgress.checklist_state_json` を partial update
- 完了判定: 単一フィールド更新 + 既存状態保持

### T-08-05 売上 SA

- `apps/web/app/actions/sales.ts` の `upsertSales` / `importSalesCsv`（`docs/05 §4.3.13`）
- CSV: ヘッダ `book_id,year_month,royalty_jpy,review_count,avg_stars,bsr` + 行番号付きエラー
- 完了判定: CSV 100 行で 100 件 upsert / 不正行はエラー

### T-08-06 S-018 売上手動入力 UI

- `apps/web/app/(app)/sales/manual/page.tsx` (S-018)
- SalesInputForm + CsvImportButton + テンプレート DL
- 参照: `docs/wireframes/S-018-sales-manual/prompt.md`
- 完了判定: 1 件入力 + CSV 一括入力

### T-08-07 S-017 売上・KPI ダッシュボード

- `apps/web/app/(app)/sales/page.tsx` (S-017)
- 期間/アカウント/ジャンルフィルタ
- KpiStripe (累計売上 / 累計冊数 / 平均 1 冊 / 平均星 / コスト/売上比)
- SalesTrendChart（月次積み上げ recharts）
- BooksKpiTable: サムネ/タイトル/出版日/ASIN/月次/累計/順位/星/Quality/コスト/ROI
- GenreMonthHeatmap
- 「売上を手動入力」CTA → S-018
- 自動取得は Phase 2 のため「F-038 未有効」表示
- 参照: `docs/wireframes/S-017-sales-kpi/prompt.md`
- 完了判定: 100 冊規模で 2 秒以内表示

### T-08-08 書籍 KPI 集計クエリ + 性能検証

- `getBooksKpiList({ accountId, period, genre })` で SalesRecord + TokenUsage + EvalResult を JOIN
- 100 冊 × 12 ヶ月 seed で 2 秒以内（F-039 受け入れ基準）
- 超過時はマテリアライズドビュー `sales_kpi_monthly_mv` を検討（OQ-D-08 同様）
- 完了判定: ベンチ PASS

### T-08-09 S-015 → S-016 ハンドオフ枠

- `submitToKdp` SA（`docs/05 §4.3.16`）の I/F だけ定義（Phase 3 で worker タスク実装）
- S-015 の SubmitToKdpButton は Phase 3 まで disabled、tooltip「Phase 3 で有効化」
- 完了判定: 型定義のみ

---

## 5. テスト計画

### 5.1 Vitest

| ファイル | 対象 | 内容 |
|---|---|---|
| `packages/agents/marketer/__tests__/plan.test.ts` | T-08-01 | target_count ±20% / 続編候補 |
| `apps/web/__tests__/actions/sales.test.ts` | T-08-05 | upsert + CSV import |
| `apps/web/__tests__/actions/kdp-checklist.test.ts` | T-08-04 | partial update |
| `apps/web/__tests__/queries/books-kpi.test.ts` | T-08-08 | 100 冊 2 秒 |

### 5.2 Playwright（E2E）

- `tests/e2e/sp08-kdp-checklist.spec.ts`: 出版済み 3 冊で S-015 → コピー操作 → 全チェック → 「KDP 開く」リンク確認
- `tests/e2e/sp08-sales-input.spec.ts`: S-018 で CSV 10 行 import → S-017 グラフ反映

---

## 6. 完了判定

1. 全 9 タスク `## DONE`
2. S-015 で 5 冊の入稿チェックがブラウザリロード後も保持
3. must コメント残時に S-015 がブロック (SP-06 連携)
4. S-018 で CSV 100 行 import 成功
5. S-017 KPI が 100 冊で 2 秒以内表示
6. S-005 長期プラン → S-006 テーマ生成のハンドオフ動作
7. **完了確認**: pm `MODE: REVIEW TARGET: SP-08` で `## PHASE_COMPLETE`
