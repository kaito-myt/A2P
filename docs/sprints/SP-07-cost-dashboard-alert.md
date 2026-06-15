# SP-07 cost-dashboard-alert

## 1. 目的

書籍別コスト集計 (F-033) / 1 冊 500/750 円アラート + 自動ポーズ (F-034) / 月次ダッシュボード (F-035) / 月次予測アラート (F-036) を実装し、運営者が「月 5 万円を超えない」ことをリアルタイムに可視化・制御できる状態にする。コスト常時可視化 (Header CostMeter) の本実装と、設定画面 (S-027) もここで仕上げる。

## 2. 対応機能 ID

- **F-033** 書籍 × プロバイダ × モデル粒度のコスト集計
- **F-034** 1 冊あたり 500 円超過アラート + 750 円停止
- **F-035** 月次コストダッシュボード
- **F-036** 月次コスト上限到達予測
- **F-046** 失敗ジョブのリトライ (S-024 paused ジョブの「続行」操作)
- 対応画面: **S-024** コスト詳細ダッシュボード、**S-027** 設定、**S-028** アラート一覧、Header **CostMeter** 本実装

## 3. タスク一覧

| ID | 状態 | タスク | 概要 | 対応機能/画面 | 工数 |
|---|---|---|---|---|---|
| T-07-01 | ✅ | F-033 書籍別コスト集計クエリ + index 検証 | `prisma.tokenUsage.groupBy` 集計 + 1 秒以内アサーション | F-033 | S |
| T-07-02 | ✅ | `alert.cost.check` per_book 実装 | 各 pipeline 完了時に enqueue / 500 円 = warn / 750 円 = pause + child job cancel + `Book.cost_status='paused'` `Book.status='paused_cost'` | F-034 | M |
| T-07-03 | ✅ | `alert.cost.check` monthly 実装 + cron | 毎時 cron / 線形外挿 / 80%/95%/100% 閾値 / 100% で SA 側で kick rejection | F-036 | M |
| T-07-04 | ✅ | Resend `cost-exceeded` + `monthly-budget-alert` テンプレ実装 | SP-01 の枠を本実装 + 重複送信抑止（同 book / 同月で 1 通） | F-034, F-036 | S |
| T-07-05 | ✅ | S-024 コスト詳細ダッシュボード | KPI ストリップ / DailyCostStackedChart / BreakdownCharts ×3 / PredictionAlertStrip / TopCostBooksTable / PausedJobsTable + CSV エクスポート | F-033, F-035, F-036, S-024 | L |
| T-07-06 | ✅ | Header CostMeter 本実装 + `/api/sse/cost` | 当月コスト + 上限 5 万円 + 残額表示 / 色変化 (緑/黄/橙/赤) | F-036, docs/04 §3.2 | M |
| T-07-07 | ✅ | `resumePausedBook` SA + S-024 内 PausedJobsTable | 「続行」「中止」操作 / 続行で `pipeline.book.*` 中断ステップから再 enqueue / audit_log | F-034, F-046 | M |
| T-07-08 | ✅ | S-028 アラート一覧 + markAlerts SA | フィルタ / BulkActionBar (既読/resolved) / 種別別件数 / リンク → S-024/S-026/S-020 | F-034, F-036, F-024 (Alert), S-028 | M |
| T-07-09 | ✅ | S-027 設定画面（通知・閾値・自動承認・データ管理・**API キー**） | NotificationSettingsForm / ThresholdSettingsForm / AutoApprovalToggle (Phase 2 用 toggle のみ) / DataRetentionForm / **ApiCredentialsList + ApiCredentialModal + ApiCredentialTestButton** (F-051/F-052、SP-02 T-02-13 の SA を呼ぶ) | F-030 (toggle), F-034, F-036, F-038 (toggle), **F-051, F-052**, S-027 | L |
| T-07-10 | ✅ | `createBatchPlan` 内の月次 100% kick rejection 強化 | SP-03 で実装した CostForecastCard と連動して月次レッド時に disabled + 強制続行スイッチ | F-036 | S |
| T-07-11 | ✅ | BookLock expires 掃除を alert.cost.check に相乗り | OQ-D-05: 期限切れロックを毎時 sweep | docs/05 §12 OQ-D-05, R-10 | S |

合計 **11 タスク**、すべて完了。

---

## 4. タスク詳細（要点）

### T-07-01 F-033 集計クエリ

- 関数 `getBookCostBreakdown(bookId)`: `prisma.tokenUsage.groupBy({ by: ['provider','model','role'], where: { book_id }, _sum: { cost_jpy: true, input_tokens: true, output_tokens: true, image_count: true } })`
- 1 秒以内（F-033 受け入れ基準）を Vitest で 100 冊 × 50 行/冊の seed データで計測
- index `token_usage_book_time_idx` の有効性も確認
- 完了判定: ベンチで 1 秒以内

### T-07-02 alert.cost.check per_book

- `apps/worker/src/tasks/alert.cost.check.ts` 完全実装（`docs/05 §5.3.17`）
- per_book scope: `Book.cost_jpy_total` を参照 → warn/pause 閾値判定
- warn: `Alert(kind='cost_per_book_warn', severity='warning')` INSERT + `Book.cost_status='warn'` + メール
- pause: `Book.cost_status='paused'` + `Book.status='paused_cost'` + 進行中 child Job を `cancelled` 化 + `BookLock` 解放しない（人手で resume するまで）+ メール
- 各 `pipeline.book.*` の完了 task 内で `enqueue('alert.cost.check', { scope: 'per_book', book_id })`
- 完了判定: 750 円到達で child job が cancel される

### T-07-03 alert.cost.check monthly + cron

- monthly scope: 月初〜現在の `SUM(token_usage.cost_jpy)` → 残日数で線形外挿 → 80%/95%/100% 判定
- 各閾値で対応する Alert + メール（重複抑止: 同月 1 通）
- 100% 到達で `AppSettings.force_continue=false` の場合 SA `createBatchPlan` `kickBatchNow` を `ConflictError` で拒否
- crontab に既に `0 * * * * alert.cost.check ?{"scope":"monthly"}`
- 完了判定: 各閾値での Alert + kick 拒否

### T-07-04 メールテンプレ本実装

- SP-01 で枠を作った `cost-exceeded.tsx` / `monthly-budget-alert.tsx` を本実装
- 件名・本文・関連 URL ボタン（S-024 / S-026）
- 重複送信抑止: `Alert` テーブルに `read_at IS NULL` で参照しメール 1 通/書籍 or 1 通/月で抑止
- 完了判定: テスト送信で Resend ログに 1 通

### T-07-05 S-024 コスト詳細ダッシュボード

- `apps/web/app/(app)/cost/page.tsx` (S-024)
- 期間セレクタ + フィルタ
- KPI ストリップ（当月実績 / 月末予測 / 残額 / 比率 / 1 冊平均）
- DailyCostStackedChart（recharts）
- BreakdownCharts × 3 (provider/model/role)
- PredictionAlertStrip（80/95/100 閾値）
- TopCostBooksTable（高コスト 20 冊 + 500 円バッジ）
- PausedJobsTable + 続行/中止ボタン
- CsvExportButton
- 参照: `docs/wireframes/S-024-cost/prompt.md`
- 完了判定: 全セクション動作 + 100 冊規模で 2 秒以内

### T-07-06 Header CostMeter 本実装

- `/api/sse/cost/route.ts`: monthly_cost_jpy + per_book warn/paused 配列を SSE 配信
- Header の CostMeter コンポーネント本実装（プレースホルダ → 本物）
- 色変化: 0-80%緑 / 80-95%黄 / 95-100%橙 / 100%+赤
- クリックで S-024
- 完了判定: コスト変動が 5 秒以内に Header に反映

### T-07-07 resumePausedBook SA

- `apps/web/app/actions/jobs.ts` の `resumePausedBook`（`docs/05 §4.3.14`）
- decision='continue': `Book.cost_status='normal'` + `Book.status` を直前の running 値に戻し + `pipeline.book.*` を該当ステップから再 enqueue
- decision='cancel': `Book.status='cancelled'` + BookLock 解放
- audit_log 記録
- 完了判定: 続行/中止両方で挙動どおり

### T-07-08 S-028 アラート一覧

- `apps/web/app/(app)/alerts/page.tsx` (S-028)
- AlertsTable + 種別アイコン + 重要度 + リンク（コスト系→S-024, ジョブ系→S-026, 単価系→S-020）
- BulkMarkButton（既読/resolved）→ `markAlerts` SA
- 種別別件数カウント
- 参照: `docs/wireframes/S-028-alerts/prompt.md`
- 完了判定: 一括既読が動作

### T-07-09 S-027 設定画面（含 API キー UI）

- `apps/web/app/(app)/settings/page.tsx` (S-027)
- NotificationSettingsForm (notification_email_to + 種別 ON/OFF)
- ThresholdSettingsForm (1 冊 warn/pause、月次 yellow/orange/red、catalog ±%)
- AutoApprovalToggle（Phase 2 で本実装、ここでは on/off のみ）
- DataRetentionForm (job_log_retention_days, R2 アーカイブ閾値)
- KdpSubmissionSettingsForm（Phase 3 のため disabled + 注記）
- **ApiCredentialsList (F-051)** — Anthropic/OpenAI/Google/Tavily 4 行表、各行に状態バッジ（DB ✅ / env ⚠️ / 未設定 ❌）+ プレビューマスク
- **ApiCredentialModal** — `<input type="password">` + プロバイダ別 prefix プレースホルダ + prefix 検証エラー表示
- **ApiCredentialTestButton (F-052)** — `testApiCredential` SA 呼出 (10s timeout) → 結果バッジ (OK + レイテンシ / NG + 理由 3 区分)
- 平文 API キーは画面に絶対表示しない（マスク `sk-ant-…••••` のみ、コピー機能無し）
- 削除 (`revokeApiCredential`) で env フォールバックに切替、warning バナーで「env 値を使用中」を可視化
- 保存で `updateSettings` / `setApiCredential` SA + audit_log（API キー平文は audit_log に残さない）
- 参照: `docs/wireframes/S-027-settings/prompt.md`
- 完了判定: 全項目保存 + audit_log 記録、API キー設定 → 接続テスト → DB 保存 → ApiCredentialsList に反映までが 1 サイクルで動く

### T-07-10 月次 100% kick rejection 強化

- SP-03 の `createBatchPlan` SA / `kickBatchNow` SA に F-036 月次レッド判定追加
- `AppSettings.monthly_cost_red_jpy` を超過予測なら `would_exceed_monthly=true` を返却
- 強制続行: payload に `force=true` で skip 可能
- S-008 の UI 側で表示
- 完了判定: 月次レッド時に kick が拒否される / force=true で通る

### T-07-11 BookLock 期限切れ掃除

- SP-02 で実装した `sweepExpiredLocks()` を `alert.cost.check (monthly)` cron に相乗り
- 期限切れロックを `DELETE WHERE expires_at < now()` で掃除
- 削除件数を debug ログ
- 完了判定: 期限超過ロックが 1 時間以内に解放

---

## 5. テスト計画

### 5.1 Vitest

| ファイル | 対象 | 内容 |
|---|---|---|
| `packages/db/__tests__/cost-aggregation.test.ts` | T-07-01 | 100 冊 × 50 行 seed で 1 秒以内 |
| `apps/worker/__tests__/tasks/alert.cost.check.test.ts` | T-07-02, T-07-03 | warn/pause / monthly 各閾値 |
| `apps/web/__tests__/actions/jobs.test.ts` (resume) | T-07-07 | 続行/中止 |
| `apps/web/__tests__/actions/settings.test.ts` | T-07-09 | 保存 + audit_log |
| `apps/web/__tests__/actions/batches.test.ts` (rejection) | T-07-10 | 100% 超過拒否 / force=true で通過 |

### 5.2 Playwright（E2E）

- `tests/e2e/uc04-cost-alert.spec.ts`: token_usage を直接 seed で投入し 500 円超過 → UI 赤バッジ → 750 円で paused → 続行で再開（UC-04 全シーケンス）

---

## 6. 完了判定

1. 全 11 タスク `## DONE`
2. 1 冊 500/750 円 + 月次 80/95/100% アラート全て発火確認
3. 月次 100% で `createBatchPlan` 拒否 / 強制続行で通過
4. Header CostMeter が SSE で 5 秒以内に更新
5. paused ジョブを S-024 から続行/中止可能
6. `docs/03 §10` 申し送り 7 のうち cost 系 2 テンプレ完成
7. **完了確認**: pm `MODE: REVIEW TARGET: SP-07` で `## PHASE_COMPLETE`
