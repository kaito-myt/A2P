# SP-05 thumbnail-export-artifacts

## 1. 目的

Thumbnail Designer（カバーテキスト + gpt-image-1 画像生成）と Export 工程（docx / PDF / KDP 寸法 PNG）を実装し、Phase 1 のパイプラインを **「Editor 完了 → カバー候補 3 件生成 → サムネ承認 → Export → R2 永続化 → S-009 でダウンロード可能」** まで完走させる。OQ-01 (PDF 性能ベンチ) もここで実測する。

## 2. 対応機能 ID

- **F-006** カバーテキスト案生成
- **F-007** カバー画像生成（OpenAI gpt-image-1）
- **F-012** Word (.docx) 出力
- **F-013** PDF 出力（@react-pdf/renderer）
- **F-014** カバー PNG 出力（KDP 寸法）
- **F-015** R2 永続化
- **F-019** サムネ候補のバルク採用/再生成
- 対応画面: **S-009** 書籍ライブラリ、**S-012** サムネ承認

## 3. タスク一覧

| ID | 状態 | タスク | 概要 | 対応機能/画面 | 工数 |
|---|---|---|---|---|---|
| T-05-01 | ✅ | Thumbnail Designer エージェント（テキスト） | `packages/agents/thumbnail/text.ts` で `ThumbnailTextInput/Output` 準拠 (3〜5 案) | F-006 | S |
| T-05-02 | ✅ | Thumbnail Designer（画像生成 + sharp 後処理） | `packages/agents/thumbnail/image.ts`。SP-02 の image-gen.ts を活用 + sharp で 2560×1600 リサイズ + ICC 設定 | F-007, F-014 (リサイズ部) | M |
| T-05-03 | ✅ | `pipeline.book.thumbnail.text` タスク | text 案 3 件 INSERT → 各案で `pipeline.book.thumbnail.image` を 3 並列 enqueue | F-006 | S |
| T-05-04 | ✅ | `pipeline.book.thumbnail.image` タスク | gpt-image-1 → R2 raw key 保存 → `Cover` INSERT → 全候補完了で `pipeline.book.export` enqueue | F-007, F-015 | M |
| T-05-05 | ✅ | `packages/output/word` docx ビルダ | Heading1 = 章 / 目次自動 / Noto Sans JP フォント埋込 | F-012 | M |
| T-05-06 | ✅ | `packages/output/pdf` @react-pdf/renderer + 性能ベンチ | 5 万字 200 ページ生成 + 30 秒以内ベンチ + 結果を Alert 記録 (OQ-01) | F-013, OQ-01, R-02 | L |
| T-05-07 | ✅ | `packages/output/image` sharp + KDP 寸法 PNG | 採用カバーを 2560×1600 にトリム/アップスケール → `Artifact` INSERT | F-014 | M |
| T-05-08 | ✅ | `pipeline.book.export` タスク | docx / pdf / png_cover の 3 種を順次生成 → R2 PUT → `Artifact` × 3 INSERT → `Book.status='done', done_at=now()` → BookLock 解放 + 完了メール送信 | F-012〜F-015 | M |
| T-05-09 | ✅ | `bulkAdoptCovers` / `regenerateCover` / `regenerateCoverText` SA | F-019 SA + 採用時に `pipeline.book.export` 起動 / 再生成時に該当タスク再 enqueue | F-019 | M |
| T-05-10 | ✅ | S-012 サムネ承認 UI（バルク + 単冊） | ThumbnailGrid / ThumbnailComparator / CoverTextProposalsList / RegenerateThumbnailButton | F-019, S-012 | L |
| T-05-11 | ✅ | S-009 書籍ライブラリ + ダウンロード | BooksTable（100 冊 2 秒目標）+ ArtifactDownloadGroup + BulkActionBar + `/api/artifacts/[id]/download` RH + `/api/artifacts/zip` RH | F-015, F-039 (準備), S-009 | L |

合計 **11 タスク**、すべて完了。

---

## 4. タスク詳細

### T-05-01 Thumbnail Designer エージェント（テキスト）

- `packages/agents/thumbnail/text.ts` に `generateCoverText(input)`
- 3〜5 案を structured output で生成
- 参照: `docs/05 §6.3.4` / `docs/02 F-006`
- 完了判定: 3 案以上を返すテスト PASS

### T-05-02 Thumbnail Designer（画像生成）

- `packages/agents/thumbnail/image.ts` に `generateCoverImage(input: ThumbnailImageInput): Promise<ThumbnailImageOutput>`
- SP-02 の `image-gen.ts` を呼出 → 生画像 Buffer 取得
- R2 `books/{book_id}/covers/raw/{cover_id}.png` に PUT
- `Cover` INSERT（`r2_key`, `width`, `height`, `prompt_used`, `generation_meta_json`, `status='generated'`）
- 参照: `docs/05 §6.3.4` / `docs/02 F-007`
- 完了判定: 1 件 = 1 画像 + 1 Cover + 1 token_usage

### T-05-03/T-05-04 thumbnail タスク

- T-05-03: `pipeline.book.thumbnail.text` 完全実装。3 件 `CoverTextProposal` INSERT → 各案で `pipeline.book.thumbnail.image` を 3 並列 enqueue
- T-05-04: `pipeline.book.thumbnail.image` 完全実装。全候補完了で `pipeline.book.export` enqueue（親 Job.children カウント）
- 参照: `docs/05 §5.3.6 §5.3.7`
- 完了判定: 1 冊で 3 covers / 3 token_usage(role=thumbnail_image)

### T-05-05 `packages/output/word` docx ビルダ

- `buildDocx(book: Book, chapters: Chapter[]): Promise<Buffer>`
- 章ごとに Heading1 + body_md パース（marked-style）
- 目次自動生成 (`TableOfContents`)
- Noto Sans JP フォント埋め込み（`apps/worker/fonts/` に配置）
- 参照: `docs/03 §E-01 §E-05` / `docs/02 F-012`
- 完了判定: docx-validator で構造検証 PASS

### T-05-06 `packages/output/pdf` + 性能ベンチ

- `buildPdf(book, chapters): Promise<Buffer>`
- A5 KDP 標準 / 章扉 / ページ番号
- 章テキストは Markdown → ReactPDF 要素ツリー
- **性能ベンチ**: テストで 5 万字 8 章のサンプルを 30 秒以内に生成できるか測定。超過した場合は `Alert(kind='pdf_perf_warning', payload=detail)` を INSERT + `docs/dev-plan.md` に再評価フラグ記録（OQ-01）
- 参照: `docs/03 §E-02 §E-03` / `docs/02 F-013` / `docs/05 §12 OQ-01`
- 完了判定: ベンチ実測 + Alert 動作

### T-05-07 sharp + KDP 寸法 PNG

- `resizeCover(buffer: Buffer, width=2560, height=1600): Promise<Buffer>`
- bicubic upscale + ICC profile (sRGB)
- 第三者商標含まないかの簡易チェックは Phase 4 課題（実装しない）
- 参照: `docs/03 §E-04` / `docs/02 F-014`
- 完了判定: 出力サイズが 2560×1600 + sharp metadata 検証

### T-05-08 `pipeline.book.export` タスク

- 完全実装: docx / pdf / png_cover を順次（章数次第で並列も可）
- 各成果物を R2 PUT し `Artifact` INSERT
- `Book.status='done', done_at=now()`, `cost_status` 確認
- `BookLock` 解放
- `sendMail({ template: 'book-done', data })`（SP-06 の revision-run-completed と同じ仕組み）
- Phase 2 では Judge 経由になるが、Phase 1 はサムネ完了で直接呼ばれる
- 参照: `docs/05 §5.3.9` / `docs/02 F-012〜F-015`
- 完了判定: 3 Artifacts INSERT + Book.status='done'

### T-05-09 サムネ系 SA

- `apps/web/app/actions/covers.ts` で `bulkAdoptCovers` / `regenerateCover` / `regenerateCoverText`（`docs/05 §4.3.6`）
- 採用時: 該当 Cover.status='adopted' + その他は rejected + KDP 寸法 PNG 生成 + Export 後段呼出
- 完了判定: 5 件一括採用 / 再生成で job_id 返却

### T-05-10 S-012 サムネ承認 UI

- `apps/web/app/(app)/covers/page.tsx` (S-012)
- 表示モード: バルクグリッド / 単冊詳細
- ThumbnailGrid + ThumbnailComparator + CoverTextProposalsList
- BulkActionBar: 一括採用 / 全候補再生成 / カバーテキスト再生成
- CommentAffordance の座標領域選択（実体は SP-06）
- 参照: `docs/wireframes/S-012-covers/prompt.md` / `docs/04 S-012`
- 完了判定: 単冊比較 + バルク一括採用が動作

### T-05-11 S-009 書籍ライブラリ + ダウンロード

- `apps/web/app/(app)/books/page.tsx` (S-009)
- BooksTable: 100 冊規模 2 秒目標。仮想スクロール
- フィルタ: account/genre/status/quality/cost/期間/コメント有無/KDP 状況
- BulkActionBar: 「KDP 入稿チェックリストへ」「一括 zip ダウンロード」「コメント一括反映へ（SP-06）」
- ArtifactDownloadGroup: docx/pdf/png 各リンク → `/api/artifacts/[id]/download` RH（302 → 署名付き R2 URL）
- `/api/artifacts/zip?bookIds=...` RH: streaming zip
- 参照: `docs/wireframes/S-009-books/prompt.md` / `docs/04 S-009` / `docs/05 §4.2`
- 完了判定: 100 冊 seed で 2 秒以内表示 / zip ダウンロード成功

---

## 5. テスト計画

### 5.1 Vitest

| ファイル | 対象 | 内容 |
|---|---|---|
| `packages/agents/thumbnail/__tests__/text.test.ts` | T-05-01 | 3+ 案生成 |
| `packages/agents/thumbnail/__tests__/image.test.ts` | T-05-02 | R2 PUT + Cover INSERT + token_usage |
| `packages/output/word/__tests__/build.test.ts` | T-05-05 | docx-validator 検証 |
| `packages/output/pdf/__tests__/perf.test.ts` | T-05-06 | 5 万字 30 秒ベンチ |
| `packages/output/image/__tests__/resize.test.ts` | T-05-07 | sharp metadata |
| `apps/worker/__tests__/tasks/pipeline.book.export.test.ts` | T-05-08 | 3 Artifacts INSERT |
| `apps/web/__tests__/actions/covers.test.ts` | T-05-09 | 一括採用 |

### 5.2 Playwright（E2E）

- `tests/e2e/sp05-thumbnail-export.spec.ts`: Editor 完了 → サムネ 3 件生成 → 1 件採用 → docx/pdf/png 生成 → S-009 でダウンロード可能 → Book.status=done

---

## 6. 完了判定

1. 全 11 タスク `## DONE`
2. 1 冊が **Editor 完了 → サムネ 3 候補 → 採用 → Export → R2 永続化** まで完走
3. PDF ベンチが実施され OQ-01 の判断材料が `Alert` または `dev-plan.md` メモに残る
4. S-009 で 100 冊規模を 2 秒以内に表示
5. S-012 でバルク採用 + 再生成 + コメント座標領域指定（実体は SP-06）
6. `docs/03 §10` 申し送り 5 (R2 キー設計) と 6 (PDF ベンチ) 反映
7. **完了確認**: pm `MODE: REVIEW TARGET: SP-05` で `## PHASE_COMPLETE`
