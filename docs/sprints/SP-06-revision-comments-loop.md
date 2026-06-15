# SP-06 revision-comments-loop

## 1. 目的

F-049 修正コメント記録（章 / アウトライン / カバー / カバーテキスト / メタデータ / テーマを横断）と F-050 ユーザートリガー一括反映を実装し、UC-06「朝レビュー → コメント記入 → ボタン押下 → 一括反映 → diff レビュー」のループを完成させる。50 時間/月の操作時間制約を守る Phase 1 最大の差別化機能。

## 2. 対応機能 ID

- **F-049** AI 出力への修正コメント記録
- **F-050** 修正コメントの一括適用（ユーザートリガー）
- **F-016** ロールバック（`ChapterRevision` 退避からの復元）
- 対応画面: **S-013** 修正コメント一覧、**S-014** 修正一括反映 実行・進捗・diff レビュー、各画面の CommentAffordance 実体化

## 3. タスク一覧

| ID | 状態 | タスク | 概要 | 対応機能/画面 | 工数 |
|---|---|---|---|---|---|
| T-06-01 | ✅ | コメント SA（create/update/delete/bulkChangePriority） | `actions/comments.ts` 完全実装 + must コメントで `Book.has_blocking_comments=true` 自動更新 | F-049 | M |
| T-06-02 | ✅ | CommentAffordance / CommentDrawer 共通コンポーネント | 章本文段落 / カバー座標 / メタフィールド の各 target_kind に対応 | F-049 | M |
| T-06-03 | ✅ | S-010 章本文の段落アンカーコメント実装 | T-06-02 を章 Markdown に統合 + CommentBadge 表示 | F-049, S-010 | M |
| T-06-04 | ✅ | S-012 サムネ座標領域コメント実装 | T-06-02 を CoverViewer に統合（image_region 座標選択） | F-049, S-012 | M |
| T-06-05 | ✅ | S-011/S-015/S-007 コメント実装 | アウトライン / KDP 入稿チェック / テーマ詳細のコメント追加（共通コンポーネント再利用） | F-049, S-011, S-015, S-007 | S |
| T-06-06 | ✅ | S-013 修正コメント一覧（横断） | フィルタ / グルーピング / KPI / BulkActionBar / `createRevisionRun` SA 起動 | F-050, S-013 | L |
| T-06-07 | ✅ | `createRevisionRun` SA + 推定コスト計算 + 排他制御 | book_locks 検査で `blocked_books` 返却 + 推定コスト / 時間算出 | F-050 | M |
| T-06-08 | ✅ | `revision.book.apply` ワーカタスク | 種別ごとに Writer/Editor/Thumbnail/Marketer を再呼出 + Chapter 旧版退避 + applied/not_applicable 遷移 | F-050 | L |
| T-06-09 | ✅ | S-014 進捗・diff レビュー UI | RunHeader + BookProgressCardList + DiffReviewer (Markdown / 画像 / JSON) + ActionBar | F-050, S-014 | L |
| T-06-10 | ✅ | `/api/sse/revision-runs/[id]` SSE + 完了メール | run 進捗を SSE 配信 + 完了で `revision-run-completed` メール送信 | F-050, docs/03 申し送り 7 | M |
| T-06-11 | ✅ | `rollbackRevisionRun` SA + ChapterRevision 復元 | 章 / カバー / メタの旧版復元 + コメント status を pending に戻す | F-016 (ロールバック), F-050 | M |
| T-06-12 | ✅ | Header CommentBadge 本実装 + must コメントによる KDP ブロック | 未消化件数 + must 件数を SSE で配信 / S-015 入稿でブロック | F-049, S-015 連携 | S |

合計 **12 タスク**、すべて完了。

---

## 4. タスク詳細（要点）

### T-06-01 コメント SA

- `apps/web/app/actions/comments.ts` の `createComment` / `updateComment` / `deleteComment` / `bulkChangePriority`（`docs/05 §4.3.7` 準拠）
- `createComment` 内で同トランザクションで `Book.has_pending_comments=true` 更新 + must の場合 `has_blocking_comments=true`
- `deleteComment`/priority 変更後に上記フラグの再計算（must 残数）
- 完了判定: 単体テストで 3 ケース PASS

### T-06-02 CommentAffordance / CommentDrawer

- `components/comment-affordance.tsx`: 段落 hover / 画像領域 / フィールド横で「+ コメント」アイコン
- `components/comment-drawer.tsx`: 右スライドドロワー、`{ body, priority }` 入力 + 既存コメント一覧
- 完了判定: Storybook 風スナップショットで 3 種類のターゲットに対応

### T-06-03〜T-06-05 各画面コメント実装

- S-010 章本文: 段落番号 range で記録
- S-012 サムネ: 画像座標 (x, y, w, h) で記録
- S-011 アウトライン: 章 index range で記録
- S-015 KDP メタ: フィールド名で記録（target_kind='metadata'）
- S-007 テーマ: target_kind='theme'
- 完了判定: 各画面でコメント追加 → DB 反映確認

### T-06-06 S-013 修正コメント一覧

- `apps/web/app/(app)/comments/page.tsx` (S-013)
- フィルタバー / CommentsSummaryKpi (pending件数 / must 件数 / 推定コスト) / CommentsTable
- グルーピング（書籍別 / 種別別 / 優先度別）
- BulkActionBar: 「選択を一括反映」「対象書籍の全 pending を反映」「優先度変更」「削除」
- 「一括反映」→ 確認モーダル → `createRevisionRun` SA → S-014 へ遷移
- 参照: `docs/wireframes/S-013-comments/prompt.md`
- 完了判定: フィルタ + 一括反映 SA 呼出が動作

### T-06-07 `createRevisionRun` SA

- `apps/web/app/actions/revision-runs.ts` （`docs/05 §4.3.8` 準拠）
- `comment_ids` から `book_ids` 抽出 → 各書籍の `BookLock` 検査で `blocked_books` 確定
- 推定コスト: 種別ごとに `ModelAssignment` × 想定トークン数で算出
- `RevisionRun` INSERT(status=queued) → 書籍ごとに `revision.book.apply` を 1 タスク enqueue
- 戻り値: `{ run_id, blocked_books, estimated_cost_jpy, estimated_minutes }`
- 完了判定: 複数書籍 run で `blocked_books` 検出 + 1 書籍 = 1 タスク

### T-06-08 `revision.book.apply` ワーカタスク

- `apps/worker/src/tasks/revision.book.apply.ts` 完全実装（`docs/05 §5.3.10`）
- BookLock acquire (holder=`revision_run:<id>`) → 衝突なら `blocked_books` に追記して終了
- `target_kind` でグルーピング:
  - `chapter` → Writer.chapter (feedback 付き) → Chapter 旧版退避 + version+1
  - `outline` → Writer.outline (reject_note 風に feedback 注入)
  - `cover` → Thumbnail.image (feedback 付き) → 新 Cover INSERT, 旧 Cover status=rejected
  - `cover_text` → Thumbnail.text 再生成 → 新 CoverTextProposal INSERT
  - `metadata` → Marketer.metadata 再生成 → KdpMetadata 上書き
  - `theme` → Marketer.theme 1 件で feedback 注入し ThemeCandidate 更新
- 各コメントを `applied` または `not_applicable`（適用不可と判断時、reason 記録）に遷移
- 全コメント処理後 `BookLock` 解放、`RevisionRun.result_summary_json` 累積更新
- Phase 2 では Judge 再採点（このタスクではスキップ枝）
- priority=`5`（通常 10 より高い）
- 完了判定: 章/カバー混在の run で全コメント遷移、Chapter 旧版が `chapter_revisions` に退避

### T-06-09 S-014 進捗・diff レビュー UI

- `apps/web/app/(app)/revision-runs/[id]/page.tsx` (S-014)
- RunHeader / GlobalProgressBar / BookProgressCardList（SSE 購読）
- 完了後: DiffReviewer
  - 章本文: Markdown 行 add/del 色分け（`diff` ライブラリ）
  - サムネ: before/after 並列表示
  - メタデータ: JSON diff
- CostRecordTable（このランで消費した token_usage）
- ActionBar: 「承認」「追加コメント」「ロールバック」「書籍詳細へ」
- 参照: `docs/wireframes/S-014-revision-run/prompt.md`
- 完了判定: 進捗バー動作 + 完了後 diff 表示

### T-06-10 SSE + 完了メール

- `/api/sse/revision-runs/[id]/route.ts`: `pg_notify('revision_runs_progress', JSON)` を購読
- worker 側で各コメント処理ごとに notify 発火
- `RevisionRun.status='done'/'partial'` 遷移時に `sendMail({ template: 'revision-run-completed', data })`
- 完了判定: SSE 受信 + メール送信成功

### T-06-11 `rollbackRevisionRun` SA + 復元

- `apps/web/app/actions/revision-runs.ts` の `rollbackRevisionRun`（`docs/05 §4.3.8`）
- 部分ロールバック: `comment_ids` 指定で対象コメントだけ
- 章: `ChapterRevision` から最新（version-1）を取得 → `Chapter.body_md` 復元 + version+1
- カバー: 元採用 Cover の status=adopted に戻す + 新 Cover を rejected に
- メタ: 旧 JSON を `KdpMetadata` 上書き（履歴は audit_log で復元）
- 対象 `RevisionComment.status='pending'` に戻す
- `audit_log` に記録
- 完了判定: 章ロールバックで version 連番が正しい + コメントが pending に戻る

### T-06-12 CommentBadge 本実装 + KDP ブロック

- Header の `CommentBadge` を `/api/sse/comments`（簡易 polling 30 秒 でも可）で pending 件数 + must 件数を取得
- S-015 (SP-08 で本実装) の入稿チェック行で `Book.has_blocking_comments=true` ならボタン disabled + 警告バナー → S-013 のフィルタへリンク
- 完了判定: must コメント残時に KDP 入稿チェックの「進捗保存」ボタンがブロックされる

---

## 5. テスト計画

### 5.1 Vitest

| ファイル | 対象 | 内容 |
|---|---|---|
| `apps/web/__tests__/actions/comments.test.ts` | T-06-01 | has_blocking_comments の自動更新 |
| `apps/web/__tests__/actions/revision-runs.test.ts` | T-06-07, T-06-11 | blocked_books 検出 / ロールバック復元 |
| `apps/worker/__tests__/tasks/revision.book.apply.test.ts` | T-06-08 | 種別混在 run / 章 version 退避 / カバー差替 |

### 5.2 Playwright（E2E）

- `tests/e2e/uc06-revision-run.spec.ts`（UC-06 全シーケンス、SP-09 でも再利用）:
  - 既存 5 冊で章 + サムネにコメント 10 件記入 → S-013 で選択 → 一括反映 → S-014 で進捗 → 完了 diff → 1 件ロールバック → コメント pending 復帰 → 再ループ

---

## 6. 完了判定

1. 全 12 タスク `## DONE`
2. 5 冊 × 平均 3 コメントの一括反映が 1 回の実行で処理可能（F-050 受け入れ基準）
3. ブラウザクローズ後も worker は走り、完了で `revision-run-completed` メール送信
4. 章のロールバックで旧版を `chapter_revisions` から復元
5. must コメント残時に KDP 入稿チェック (SP-08 連携) がブロックされる
6. **自動スケジュール実行が提供されない**（コードに cron 起動がないことを grep で確認）
7. `docs/01 §申し送り 7` と `docs/03 §10 申し送り 7` (revision-run-completed テンプレ) 反映
8. **完了確認**: pm `MODE: REVIEW TARGET: SP-06` で `## PHASE_COMPLETE`
