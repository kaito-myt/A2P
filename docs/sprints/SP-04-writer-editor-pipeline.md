# SP-04 writer-editor-pipeline

## 1. 目的

Writer エージェント（アウトライン生成 + 章単位執筆）と Editor エージェント（校閲 + AI 開示文挿入）を実装し、書籍ジョブが **Marketer → Writer (outline → chapters 並列) → Editor** まで自走する状態を作る。アウトライン承認の人間介入ポイント (S-011) と、章エディタ (S-010) の読み取り側も同時に整える。修正コメント反映時の Writer/Editor 再呼出 I/F も先取りする。

## 2. 対応機能 ID

- **F-003** ライター: アウトライン生成
- **F-004** ライター: 本文章単位執筆
- **F-005** エディター: 校閲・体裁統一
- **F-011** 並列ジョブ実行（書籍 5 × 章 4）
- **F-016** パイプライン途中失敗時のリトライ・部分再開
- **F-018** アウトラインのバルク承認/差戻し
- **F-027** DB ベースの動的プロンプトテンプレ（loader 経由）
- **F-028** プロンプトバージョン履歴 (DB 構造を活かす段階。UI は SP-11)
- 対応画面: **S-010** 書籍詳細・章エディタ、**S-011** アウトライン承認

## 3. タスク一覧

| ID | 状態 | タスク | 概要 | 対応機能/画面 | 工数 |
|---|---|---|---|---|---|
| T-04-01 | ✅ | Writer エージェント（アウトライン） | `packages/agents/writer/outline.ts` で WriterOutlineInput/Output 準拠 | F-003 | M |
| T-04-02 | ✅ | Writer エージェント（章執筆） | `packages/agents/writer/chapter.ts` で WriterChapterInput/Output 準拠 + feedback 引数対応 | F-004, F-050 (用 I/F) | M |
| T-04-03 | ✅ | Editor エージェント | `packages/agents/editor/index.ts`。AI 開示文を `AppSettings.ai_disclosure_text` から取得して巻末挿入 | F-005, R-05 | M |
| T-04-04 | ✅ | `pipeline.book.writer.outline` タスク | アウトライン生成 → `Outline(status=pending_review)` INSERT → 承認待ち停止 | F-003 | M |
| T-04-05 | ✅ | `pipeline.book.writer.chapter` タスク + p-limit 並列 | 章 1 件タスク + 親で `p-limit(4)` 制御 + 完了監視で次フェーズ enqueue | F-004, F-011 | L |
| T-04-06 | ✅ | `pipeline.book.editor` タスク | 全章統合 → 校閲 → `Chapter.body_md` 更新 (version++) + `ChapterRevision` 退避 | F-005, F-016 | M |
| T-04-07 | ✅ | `bulkApproveOutlines` / `bulkRejectOutlines` SA | F-018 SA + 承認時に Writer.chapter を enqueue / 差戻し時に reject_note 付きで Writer.outline を再 enqueue | F-018 | M |
| T-04-08 | ✅ | S-011 アウトライン承認 UI | OutlineCardGrid + BulkActionBar + 差戻しコメント入力 + OutlineEditDrawer (`updateOutline` SA) | F-018, S-011 | L |
| T-04-09 | ✅ | S-010 書籍詳細・章エディタ（読取側） | BookHeader + TabbedContent (Outline / Chapters / Cover / Metadata / 評価 / コスト / Job 履歴 / コメント) | F-003〜F-005, S-010 | L |
| T-04-10 | ✅ | S-010 章 Markdown ビューア + コスト内訳タブ | ChapterMarkdownViewer + CostBreakdownTable (F-033 の最小集計を SP-04 から提供) | S-010 | M |
| T-04-11 | ✅ | F-016 リトライ・部分再開 + `retryJob` SA | 中間成果物 (Chapter / Outline) を再利用、Editor から再開する `from_step` ロジック | F-016, F-046 | M |

合計 **11 タスク**、すべて完了。

---

## 4. タスク詳細（programmer 渡し用の指示は SP-01/02/03 と同様の粒度で記述）

### T-04-01 Writer エージェント（アウトライン）

- `packages/agents/writer/outline.ts` に `generateOutline(input: WriterOutlineInput): Promise<WriterOutlineOutput>`
- `createAgentClient('writer', input.genre, ctx)` でクライアント取得
- `loadActivePrompt('writer', genre)` + `reject_note` (差戻し時) を prompt 注入
- structured output zod で 7〜10 章、各章想定文字数の合計が 45000〜55000 字 ±15% 範囲を **自動検証**（範囲外なら AgentError）
- 参照: `docs/05 §6.3.2` / `docs/02 F-003`
- 完了判定: 7〜10 章で文字数合計が範囲内のテスト PASS

### T-04-02 Writer エージェント（章執筆）

- `packages/agents/writer/chapter.ts` に `writeChapter(input: WriterChapterInput): Promise<WriterChapterOutput>`
- `previous_summary` を context に注入して文体一貫性を保つ
- `feedback?` (F-050 用) を「Previous feedback」セクションとして prompt に注入
- 実文字数を `body_md` から計算し `char_count` 返却。target ±20% 範囲チェック → 範囲外は AgentError + リトライ対象
- 参照: `docs/05 §6.3.2` / `docs/02 F-004` 受け入れ基準
- 完了判定: 5000 字想定で 4000〜6000 字が返るテスト PASS / feedback 付き呼出で内容反映

### T-04-03 Editor エージェント

- `packages/agents/editor/index.ts` に `editBook(input: EditorInput): Promise<EditorOutput>`
- 表記ゆれ統一 / 章間整合 / 「ですます/だである」混在検出 → 警告を `diff_summary` に含める
- 巻末に `AppSettings.ai_disclosure_text` を必ず挿入し `ai_disclosure_appended: true`
- `feedback?` (F-050) 対応
- 参照: `docs/05 §6.3.3` / `docs/02 F-005`
- 完了判定: AI 開示文が含まれる / 「ですます/だである」混在を検出

### T-04-04 `pipeline.book.writer.outline` タスク

- 完全実装: `WriterOutlineInput` を組み立て → `generateOutline()` 呼出 → `Outline INSERT(status=pending_review)`
- `pg_notify('jobs', { phase: 'awaiting_outline_approval' })`（**ADR-001**: `docs/05 §16` でチャネル名 `'jobs'` 統一）
- ユーザー承認待ちで停止（次タスクは SA から enqueue）
- 参照: `docs/05 §5.3.3`
- 完了判定: outline INSERT + 自動で次タスク起動しない

### T-04-05 `pipeline.book.writer.chapter` タスク + p-limit 並列

- 1 タスク = 1 章
- 親 outline の全章数 N を取得し、`p-limit(env.WORKER_CHAPTER_CONCURRENCY=4)` で `Promise.all` 風に enqueue（実体はそれぞれ独立 graphile-worker タスク）
- 各章タスクは `Chapter INSERT` + `Job.children` で親紐付け
- 親 Job 内で `child.status='done'` カウントが N に達したら `pipeline.book.editor` を enqueue
- `previous_summary` は直前章の `body_md` から要約抽出（簡易実装可、Phase 1 は最初の 200 字でも OK）
- 参照: `docs/05 §5.3.4`、`docs/03 §JQ-02`
- 完了判定: 8 章本を kick → 4 並列で実行 → 完了で Editor enqueue

### T-04-06 `pipeline.book.editor` タスク

- 全章を `index ASC` で取得 → `editBook()` 呼出 → 章ごとに `Chapter.body_md` 更新 + version+1 + `ChapterRevision` に旧版退避
- 完了で `pipeline.book.thumbnail.text` enqueue（SP-05 で実装、ない場合はログのみ）
- 参照: `docs/05 §5.3.5`
- 完了判定: 章 version++ / chapter_revisions 行追加 / AI 開示文挿入確認

### T-04-07 `bulkApproveOutlines` / `bulkRejectOutlines` SA

- `apps/web/app/actions/outlines.ts` で `docs/05 §4.3.5` 準拠
- 承認: `Outline.status='approved'` + `approved_at=now()` + 関連 `Book.status='running'` + `pipeline.book.writer.chapter` × 章数を enqueue（章 index 順）
- 差戻し: 各 outline に `reject_note` 必須 + `Outline.status='rejected'` + `pipeline.book.writer.outline` を `reject_note` payload 付きで再 enqueue
- 完了判定: 5 outlines 一括承認 → 各書籍で章タスク起動 / 差戻しで Writer 再走

### T-04-08 S-011 アウトライン承認 UI

- `apps/web/app/(app)/outlines/page.tsx` (S-011)
- OutlineCardGrid: 1 カード = 1 outline。章リスト + 想定文字数 + コメント数バッジ（コメントは SP-06 で本実装、ここでは 0 でも OK）
- BulkApproveButton / BulkRejectModal（コメント入力必須）
- OutlineEditDrawer: 単冊編集モード → `updateOutline` SA
- 参照: `docs/wireframes/S-011-outlines-bulk/prompt.md` / `docs/04 S-011`
- 完了判定: 5 件一括承認 + 1 件差戻しが SA 経由で動作

### T-04-09 S-010 書籍詳細・章エディタ（読取側）

- `apps/web/app/(app)/books/[id]/page.tsx` (S-010)
- BookHeader（タイトル / status / Quality / コスト + 500/750 円ライン表示）
- TabbedContent: 「アウトライン」「章本文」「カバー（SP-05 で内容）」「メタデータ」「評価履歴（SP-10 で内容）」「コスト内訳」「ジョブ履歴」「コメント（SP-06 で内容）」
- 章本文タブは次タスクで Markdown ビューア
- 参照: `docs/wireframes/S-010-book-detail/prompt.md`
- 完了判定: 全タブ表示 + アウトラインタブで承認/差戻し動作

### T-04-10 S-010 章 Markdown ビューア + コスト内訳タブ

- ChapterMarkdownViewer: 章セレクタ + Markdown レンダリング（`react-markdown` 等）
- CommentAffordance のアンカー位置だけ用意（クリックは SP-06 で実装）
- CostBreakdownTable: `prisma.tokenUsage.groupBy({ where: { book_id }, by: ['provider', 'model', 'role'] })` で 1 秒以内（F-033 の先行実装）
- 参照: `docs/04 S-010` セクション 4, 8
- 完了判定: 章を切替表示 + コスト集計が provider×model×role 別に表示

### T-04-11 F-016 リトライ・部分再開 + `retryJob` SA

- `apps/web/app/actions/jobs.ts` の `retryJob` SA（`docs/05 §4.3.14`）
- `from_step: 'auto'`: 失敗ステップから再開（Outline 完了済みなら Writer.chapter から、Chapter 一部完了なら未完了分のみ再 enqueue）
- `from_step: 'this_step'`: そのステップだけ再実行
- `Job.retries++` + `audit_log` 記録
- 単体テスト: Editor 失敗 → retry で Writer 出力を再利用して Editor だけ再走
- 参照: `docs/02 F-016 F-046` / `docs/05 §4.3.14`
- 完了判定: 3 ケースのリトライテスト PASS

---

## 5. テスト計画

### 5.1 Vitest

| ファイル | 対象 | 内容 |
|---|---|---|
| `packages/agents/writer/__tests__/outline.test.ts` | T-04-01 | 7-10 章 / 文字数範囲 |
| `packages/agents/writer/__tests__/chapter.test.ts` | T-04-02 | feedback 反映 / char_count 範囲 |
| `packages/agents/editor/__tests__/index.test.ts` | T-04-03 | AI 開示文挿入 / 表記ゆれ検出 |
| `apps/worker/__tests__/tasks/pipeline.book.writer.outline.test.ts` | T-04-04 | 承認待ちで停止 |
| `apps/worker/__tests__/tasks/pipeline.book.writer.chapter.test.ts` | T-04-05 | 4 並列で 8 章処理 |
| `apps/worker/__tests__/tasks/pipeline.book.editor.test.ts` | T-04-06 | version++ + revision 退避 |
| `apps/web/__tests__/actions/outlines.test.ts` | T-04-07 | bulk approve/reject |
| `apps/web/__tests__/actions/jobs.test.ts` | T-04-11 | retry 3 ケース |

### 5.2 Playwright（E2E）

- `tests/e2e/sp04-writer-pipeline.spec.ts`: SP-03 のテーマ採用 → kick → Outline 承認 → Chapter 並列実行完了 → Editor 完了 → S-010 で全章表示 + コスト内訳

---

## 6. 完了判定

1. 全 11 タスク `## DONE`
2. 1 冊が **Marketer → Writer.outline → 承認 → Writer.chapter ×8 並列 → Editor** まで自走（E2E）
3. S-010 で全タブ閲覧可能 / S-011 で 5 件一括承認
4. Editor 失敗 → retryJob で Writer 結果を再利用して Editor だけ再走（F-016）
5. AI 開示文が `AppSettings.ai_disclosure_text` から挿入（R-05）
6. `prompts` テーブルから loader 経由でのみ system prompt 取得（コード直書きが grep で 0 件）
7. **完了確認**: pm `MODE: REVIEW TARGET: SP-04` で `## PHASE_COMPLETE`
