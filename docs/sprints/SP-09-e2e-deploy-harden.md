# SP-09 e2e-deploy-harden

## 1. 目的

Phase 1 のラストスプリント。E2E テスト（UC-01 / UC-04 / UC-06）と運用補助 UI（S-025 ジョブログ / S-026 ジョブ詳細 / S-029 監査ログ）、`archive.jobs` cron、Railway 本番デプロイ手順固め、1 冊実走によるコスト・リードタイム実測と運用ハンドブック化を行い、Phase 1 MVP を「副業 100 冊/月運用が始められる状態」で確定させる。

## 2. 対応機能 ID

- **F-045** ジョブ実行ログ閲覧 UI
- **F-046** 失敗ジョブのリトライ操作 UI
- 観測 / 運用 / 監査全般
- 対応画面: **S-025** ジョブログ一覧、**S-026** ジョブ詳細、**S-029** 監査ログ

## 3. タスク一覧

| ID | 状態 | タスク | 概要 | 対応機能/画面 | 工数 |
|---|---|---|---|---|---|
| T-09-01 | ✅ | S-025 ジョブログ一覧 + `bulkRetryJobs` SA | フィルタ + JobsTable (直近 1000 件) + BulkRetryButton + JobStatsCard | F-045, F-046, S-025 | M |
| T-09-02 | ✅ | S-026 ジョブ詳細 + `cancelJob` SA + `retryJob from_step` | JobHeader / PayloadJsonViewer / LogStreamViewer / ErrorDetail / TokenUsageInline / ActionGroup | F-016, F-045, F-046, S-026 | L |
| T-09-03 | ✅ | S-029 監査ログ + JsonDiffExpander | フィルタ + AuditLogTable + 行展開で before/after diff | F-029, F-030, F-046, S-029 | M |
| T-09-04 | ✅ | `archive.jobs` 週次 cron 実装 | 90 日超 Job 行を R2 退避 + DB 削除 + 削除件数 metric | docs/05 §5.3.18, docs/05 §5.4 | M |
| T-09-05 | ✅ | UC-01 E2E spec | 5 冊夜間バッチ → 朝完成までのフル E2E（LLM/画像 msw、R2 LocalStack、時間圧縮フラグ） | UC-01 | L |
| T-09-06 | ✅ | UC-04 E2E spec | コスト超過 → 自動ポーズ → 続行/モデル切替 | UC-04 | M |
| T-09-07 | ✅ | UC-06 E2E spec（SP-06 で書いた spec の本格化） | コメント記入 → 一括反映 → diff → ロールバック → 再ループ | UC-06 | M |
| T-09-08 | ⏳ | 1 冊実走計測 + コスト/リードタイム実測レポート | 本番環境（Railway）で 1 冊実 LLM で完走させ、コスト・リードタイム・PDF 生成時間を計測しレポート (`docs/operations/phase1-real-run.md` 新規)（人間タスク: 本番実走待ち。計測ハーネス `scripts/measure-real-run.ts` とレポート骨格 `docs/operations/phase1-real-run.md` は整備済み） | R-01, R-02, OQ-01 確定, docs/dev-plan §6 | L |
| T-09-09 | ✅ | Railway デプロイ手順固め + 運用ハンドブック | `docs/operations/runbook.md` 新規: デプロイ手順 / 環境変数チェックリスト / 障害復旧 / pg_dump 復元手順 / モニタリング指針 | R-05, R-12 | M |
| T-09-10 | ✅ | Phase 1 PHASE_COMPLETE 全件確認 | pm `MODE: REVIEW TARGET: Phase 1` を実行、未消化があれば該当タスクへ差戻し | Phase 1 完了判定 | S |

合計 **10 タスク**（T-09-08 は本番実走待ちの人間タスク。他 9 タスク完了）。

---

## 4. タスク詳細（要点）

### T-09-01 S-025 ジョブログ一覧

- `apps/web/app/(app)/jobs/page.tsx` (S-025)
- フィルタ（kind / status / 期間 / book_id）
- JobsTable: 直近 1000 件、ページネーション
- BulkRetryButton: `bulkRetryJobs` SA（`docs/05 §4.3.14`）
- JobStatsCard: 直近 24 時間の成功率 / 平均実行時間 / 失敗件数
- 参照: `docs/wireframes/S-025-jobs/prompt.md`
- 完了判定: 1000 件 seed でページネーション + 一括リトライ動作

### T-09-02 S-026 ジョブ詳細

- `apps/web/app/(app)/jobs/[id]/page.tsx` (S-026)
- JobHeader / PayloadJsonViewer (折りたたみ) / LogStreamViewer (SSE で tail) / ErrorDetail (stack trace + スクショ) / TokenUsageInline / ActionGroup
- 「ステップから再開」: `retryJob({ from_step: 'this_step' })`
- 「中止」: `cancelJob` SA + Book.status='cancelled'
- 参照: `docs/wireframes/S-026-job-detail/prompt.md`
- 完了判定: 失敗ジョブを開いて「ステップから再開」で再走

### T-09-03 S-029 監査ログ

- `apps/web/app/(app)/audit/page.tsx` (S-029)
- フィルタ (actor / action / target_kind / 期間)
- AuditLogTable: 時刻 / actor / action / target / before→after 要約
- JsonDiffExpander: 行展開で詳細
- 参照: `docs/wireframes/S-029-audit/prompt.md`
- 完了判定: SP-02/06/07 で記録した audit 全種を表示可能

### T-09-04 archive.jobs cron

- `apps/worker/src/tasks/archive.jobs.ts`（`docs/05 §5.3.18`）
- 毎週日曜 03:00 JST (`crontab.ts` に既出)
- `Job WHERE created_at < now() - retention_days` を R2 `archive/jobs/{yyyy-mm}.jsonl.gz` に gzip 書き出し
- 完了後に DB から削除
- 削除件数を logger.info で記録
- 完了判定: テストで 100 行 archive + DB 削除

### T-09-05 UC-01 E2E

- `tests/e2e/uc01-batch-night.spec.ts`（`docs/05 §11.2` 準拠）
- seed: account 1 + テーマ 20 件
- スクリプト:
  1. ログイン
  2. S-006 で 5 件一括採用 → 「採用してバッチ計画へ」
  3. S-008 で「即時キック」
  4. SSE で 5 冊の進捗を確認 → 全 done まで待機（msw で時間圧縮）
  5. S-009 で 5 冊 ダウンロード可能
  6. S-012 でサムネ 1 件採用（再生成テスト含む）
- アサーション: 5 冊 × 3 artifacts = 15 件 / 各 cost_jpy < 500 / Quality (Phase 2 では) スキップ
- 完了判定: spec PASS

### T-09-06 UC-04 E2E

- `tests/e2e/uc04-cost-alert.spec.ts`（SP-07 でほぼ完成、ここで微調整）
- 1 書籍に token_usage を seed で 450/500/750 円段階投入 → アラート発火順序を assertion
- 完了判定: UC-04 シーケンス完走

### T-09-07 UC-06 E2E

- `tests/e2e/uc06-revision-run.spec.ts`（SP-06 spec の本格化）
- 5 冊 + 章コメント 10 + サムネコメント 5 → 一括反映 → diff → 1 件ロールバック → 追加コメントで再ループ
- 完了判定: spec PASS

### T-09-08 1 冊実走計測レポート

- 本番 Railway 環境で 1 冊実 LLM で生成
- 計測項目: total cost_jpy / リードタイム (queue → done) / 各フェーズ時間 / PDF 生成時間
- レポート `docs/operations/phase1-real-run.md` 新規作成
- OQ-01 (PDF 性能) の最終判断記録（Puppeteer フォールバック要否）
- 月次コスト換算 100 冊で 5 万円以内に収まるか試算記録
- 完了判定: レポート存在 + 判断記録

### T-09-09 Railway デプロイ手順固め + 運用ハンドブック

- `docs/operations/runbook.md` 新規作成
- セクション: デプロイ手順 / 環境変数チェックリスト (28 項目) / `prisma migrate deploy` 失敗時 / `pg_dump` 復元手順 / モニタリング指針 / KDP 規約変更時の AI 開示文更新手順
- README から runbook へリンク
- 完了判定: ハンドブックレビュー OK

### T-09-10 Phase 1 PHASE_COMPLETE 確認

- pm を `MODE: REVIEW TARGET: Phase 1` で起動
- 検証項目:
  - SP-01 〜 SP-09 全タスク `## DONE`
  - P0 機能 (F-001〜F-007, F-010〜F-025, F-027〜F-028, F-032〜F-037, F-039〜F-040, F-043〜F-046, F-049〜F-050) が grep でコード参照あり
  - Vitest + Playwright 全 PASS
  - 月額コスト試算が 5 万円以内（T-09-08 のレポート参照）
- 未消化があれば該当タスクへ差戻し
- 完了判定: `## PHASE_COMPLETE` 出力

---

## 5. テスト計画

### 5.1 Vitest

| ファイル | 対象 | 内容 |
|---|---|---|
| `apps/worker/__tests__/tasks/archive.jobs.test.ts` | T-09-04 | 100 行 archive + DB 削除 |
| `apps/web/__tests__/actions/jobs.test.ts` (拡張) | T-09-01, T-09-02 | bulk retry / cancel |

### 5.2 Playwright（E2E）

- `tests/e2e/uc01-batch-night.spec.ts` (T-09-05)
- `tests/e2e/uc04-cost-alert.spec.ts` (T-09-06)
- `tests/e2e/uc06-revision-run.spec.ts` (T-09-07)
- スモーク全件再走

---

## 6. 完了判定

1. 全 10 タスク `## DONE`
2. UC-01 / UC-04 / UC-06 の E2E spec が PASS
3. S-025 / S-026 / S-029 が動作
4. `archive.jobs` 週次 cron 設定済み
5. 本番 1 冊実走でコスト・リードタイム実測完了、`docs/operations/phase1-real-run.md` 作成
6. `docs/operations/runbook.md` 作成、運用手順が再現可能
7. Phase 1 対象の **全 P0 機能** がコードに反映（F-001〜F-007, F-010〜F-025, F-027〜F-028, F-032〜F-037, F-039〜F-040, F-043〜F-046, F-049〜F-050）
8. `docs/01` 申し送り 7 項 + `docs/03` 申し送り 7 項 + `docs/05` 申し送り 10 項 全て対応済み
9. **Phase 1 完了判定**: pm `MODE: REVIEW TARGET: Phase 1` で `## PHASE_COMPLETE`
10. Phase 2 開始時に pm 計画モードを再起動して SP-10 以降を詳細化する旨を本ファイルに明記
