# S-009 書籍ライブラリ（一覧） — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-009
- 画面名: 書籍ライブラリ（一覧）
- 対応機能 ID: F-008, F-012, F-013, F-014, F-015, F-033, F-039, F-049
- 元設計書: `docs/04-ui-design.md` §4 S-009
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（バルク選択中）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 書籍未生成
  - `loading.png` — 仮想スクロール skeleton
  - `error.png` — 個別サムネ取得失敗

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This is a BULK OPERATION screen. The following rules apply:
- 各テーブル行の先頭にチェックボックス列を必ず描画
- ページ最下部に BulkActionBar を固定: "N 件選択中 / [KDP 入稿チェックリストへ] [一括 zip ダウンロード] [コメント一括反映へ] [ステータス変更]"
- BulkActionBar に件数バッジを目立つ位置に
- ヘッダー行に全選択チェックボックス

Each book row shows COMMENT BADGE: "コメント N (must M)"
- must ありは赤背景バッジ、なしは灰
- クリックで S-013 へ

Style rules:
- Pure black-and-white, light gray for de-emphasis.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 10–12 rows (book library). No rounded corners or shadows. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "書籍ライブラリ"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 書籍 > 書籍ライブラリ"
- タイトル: "書籍ライブラリ"
- 右上: `[ + 新規プロジェクト ]`（→ S-008）

### Section 2: フィルタバー（2 行）
- 1 行目: `[アカウント ▾]` `[ジャンル ▾]` `[ステータス ▾]` `[KDP 入稿 ▾]`
- 2 行目: Quality 閾値スライダー (60 〜 100) / コスト範囲 (¥0 〜 ¥1,000) / 期間 / `[コメントあり ▾]`
- 右端: "全 142 冊 / 表示中 12"

### Section 3: 書籍テーブル
- ヘッダー: チェックボックス | サムネ | タイトル | アカウント | ジャンル | ステータス | Quality | 累計コスト | コメント | 最終更新 | ダウンロード | ASIN
- 10 行表示、3 行目までチェック ON で "選択中" 状態
- 各行例:
  - サムネプレースホルダ枠 (60x80)
  - タイトル: "{副業 × AI で月 5 万円稼ぐ実践ガイド}"
  - アカウント: "{ペンネーム}"
  - ジャンル: "ビジネス書"
  - ステータス: StatusBadge "published" / "draft" / "writing" / "judging" 等
  - Quality: "82.3"
  - 累計コスト: "¥432"（500 円超過は赤背景）
  - コメント: バッジ "12 (must:3)" 赤背景
  - 最終更新: "2026-05-20 14:32"
  - ダウンロード: `[docx]` `[pdf]` `[png]` の 3 リンクアイコン
  - ASIN: "B0XXXX"

### Section 4: BulkActionBar（画面下部固定）
- 左: "3 件選択中" バッジ
- 右: `[ KDP 入稿チェックリストへ ]` `[ 一括 zip ダウンロード ]` `[ コメント一括反映へ ]` `[ ステータス変更 ▾ ]` `[ 選択解除 ]`

### Section 5: ページネーション
- "1 - 12 / 142 件" + ページ遷移
- 100 冊規模を想定して "仮想スクロール対応" のヒント文 (small)
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー（タイトル + `[+]` 右上）
2. フィルタチップ（横スクロール）
3. 書籍カード一覧（テーブルでなくカード形式）
   - 各カード: チェックボックス + サムネ枠 + タイトル + ステータス + Quality + コスト + コメントバッジ
   - 6 枚表示
4. 画面下部に BulkActionBar:
   - "3 件選択中" / `[入稿チェック]` `[ ⋯ ]`（その他アクション）
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタバーはそのまま
- テーブル領域に EmptyState:
  - イラスト枠 "no books"
  - メッセージ: "最初の本を作成しましょう"
  - サブメッセージ: "夜セットを計画するとここに進行中の書籍が並びます"
  - CTA: `[ + 新規プロジェクト ]`（→ S-008）
- BulkActionBar は非表示
```

---

## loading.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタバーはそのまま
- テーブル: 列ヘッダーのみ描画、行は薄グレー帯 12 行 (skeleton)
- 各行にサムネ枠 (灰塗り) と複数の薄グレー帯
- 上部右に小さなスピナー + "読込中..."
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- 多くの行は通常表示
- 3 行のサムネ枠が "image error" プレースホルダ (X 印 + "サムネ取得失敗")
- 該当行のダウンロード列に「png」だけが灰色 disabled
- 他列は読める
- ページ上部に薄いトースト: "一部書籍のサムネを取得できませんでした"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- 100 冊規模の運用を前提 (F-039 受け入れ基準 2 秒以内表示)。テーブル列を絞らず全て表示することで「ライブラリ = データベース」と認識させる。
- コメントバッジ列を独立させ、must コメントの残存を一覧上で発見可能に（UC-06 のスタート地点）。
- ダウンロードリンクを 3 つ並べ、R2 署名付き URL 取得を 1 クリックで完結させる（F-015 連動）。
- BulkActionBar から S-015（入稿）/ S-013（コメント反映）への遷移を 1 操作で繋ぐ。
