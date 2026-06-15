# S-015 KDP 入稿チェックリスト — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-015
- 画面名: KDP 入稿チェックリスト
- 対応機能 ID: F-020, F-040, F-049
- 元設計書: `docs/04-ui-design.md` §4 S-015
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 入稿待ち書籍なし
  - `error.png` — メタデータ未生成 / must コメント残り

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This is a BULK OPERATION + COMMENT-CENTRIC screen:
- 各書籍チェックリストの先頭にチェックボックス
- 各メタデータフィールド右に `[コピー]` ボタンと チェックボックス（コピー時に自動 ON）
- 各メタデータフィールド横に `[+]` CommentAffordance（F-049）
- 画面下部 BulkActionBar: "N 冊選択中 / [自動入稿実行 (Phase 3)] [進捗保存] [選択解除]"
- **must コメントが残っている書籍はブロック表示** (赤バナー + コメント一覧リンク)

Style rules:
- Pure black-and-white, light gray for de-emphasis.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 8–12 rows. No rounded corners or shadows. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "KDP 入稿"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 出版パイプライン > KDP 入稿"
- タイトル: "KDP 入稿チェックリスト"
- 右側: `[ KDP を新規タブで開く ]`（外部リンクアイコン）

### Section 2: 書籍タブ（横並び、入稿対象 3 冊）
- タブ 1 (active): "{副業 × AI ...}" StatusBadge "ready"
- タブ 2: "{時間術}" StatusBadge "blocked: must 2 件"（赤）
- タブ 3: "{AI 副業}" StatusBadge "ready"

### Section 3: 選択中タブ内容（書籍 1: ready）
- 上部に書籍情報: サムネ枠 + タイトル + サブタイトル + 著者名

### Section 4: 入稿チェックリストテーブル
- 列: チェック | フィールド名 | 値 | コピー | コメント
- 行例 (10 行):
  - [ ] タイトル | "{副業 × AI で月 5 万円稼ぐ実践ガイド}" | `[コピー]` | `[+]`
  - [ ] サブタイトル | "{初心者でも今日から始められる実践 7 ステップ}" | `[コピー]` | `[+]`
  - [ ] 著者名 | "{ペンネーム}" | `[コピー]` | `[+]`
  - [ ] 紹介文 | "本書は副業を始めたいけれど..." (3 行 truncated) | `[コピー]` | `[+]`
  - [ ] カテゴリ 1 | "ビジネス・経済 > 個人投資・副業" | `[コピー]` | `[+]`
  - [ ] カテゴリ 2 | "コンピュータ・IT > 人工知能" | `[コピー]` | `[+]`
  - [ ] キーワード 1-7 | チップ "副業" "AI" "ChatGPT" "月 5 万" "実践" "初心者" "ガイド" | `[一括コピー]` | `[+]`
  - [ ] 価格 (JPY) | "¥499" | `[コピー]` | `[+]`
  - [ ] カバー URL | "https://r2.../..." | `[コピー]` `[ DL ]` | `[+]`
  - [ ] 本文 URL (docx/pdf) | "..." | `[コピー]` `[ DL ]` | `[+]`

### Section 5: 進捗保存ステータス
- 右上 small: "進捗自動保存済 (2026-05-20 23:45)"

### Section 6: アクションバー (下部固定)
- 左: "1 / 3 冊 入稿準備中" + チェック完了率 "8 / 10 項目"
- 右: `[ 進捗保存 ]` `[ 自動入稿を実行 (Phase 3) ]`（プライマリ、Phase 1 では disabled + ツールチップ "Phase 3 で有効化"）`[ 次の書籍へ → ]`
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー + `[KDP 新規タブ]`
2. 書籍タブ (横スクロール、3 冊)
3. 書籍情報（サムネ + タイトル）
4. チェックリスト (各項目縦に積む):
   - チェック + フィールド名
   - 値 (折りたたみ展開可)
   - `[コピー]` + `[+]`
5. 画面下部固定: `[ 進捗保存 ]` `[ 自動入稿 ]`
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダーはそのまま
- 書籍タブ領域に EmptyState:
  - イラスト枠 "no books"
  - メッセージ: "入稿待ち書籍がありません"
  - サブメッセージ: "書籍ライブラリで対象を選択してください"
  - CTA: `[ 書籍ライブラリへ ]` (→ S-009)
- アクションバー非表示
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- 書籍タブ 2 (must 2 件) を active にした状態
- 書籍情報直下に **赤い太枠 BlockReasonBanner**:
  - "❌ この書籍には must 優先度のコメントが 2 件残っています。入稿はブロックされています"
  - リスト表示: "・第 3 章 段落 4 (must)" / "・表紙タイトル領域 (must)"
  - CTA: `[ コメント一覧へ ]` (→ S-013)
- チェックリストは表示されるが、入稿ボタンが disabled
- もう 1 パターン: メタデータ未生成書籍ではチェックリスト領域に "F-040 メタデータ生成が未完了です" + `[ メタデータ再生成 ]`
```

---

## 設計意図メモ（ChatGPT には渡さない）

- Phase 1-2 は手動入稿支援、Phase 3 で F-041 自動入稿に拡張する 2 段運用を 1 画面で表現。
- must コメント残り時のブロック機構を強調（F-049 受け入れ基準: 品質ゲート）。
- チェック + コピーボタンの組み合わせは KDP 画面への手動転記を加速。チェックが自動 ON することで「次にどれをコピーするか」を視覚的に管理可能。
- 書籍タブで複数冊を順次入稿できる UX。進捗自動保存により中断 → 再開が容易。
