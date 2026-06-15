# S-007 テーマ候補詳細 — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-007
- 画面名: テーマ候補詳細
- 対応機能 ID: F-001, F-017, F-049
- 元設計書: `docs/04-ui-design.md` §4 S-007
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `error.png` — 重複テーマ検出時の警告モーダル

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントプロンプトを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This screen includes COMMENT AFFORDANCES on the AI output:
- 各 AI 生成要素（差別化要素、競合分析、Web 検索結果スニペット等）の右側に小さな `[+ コメント]` アフォーダンスを置く
- 既存コメントがある場合はバッジを表示（must=赤 / should=黄 / may=青、文字 + 数字併記）
- 右側に CommentPanel（300px 幅のドロワー風セクション）を常設または開閉可

Style rules:
- Pure black-and-white, light gray for de-emphasis.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 8–12 rows. No rounded corners or shadows. Realistic info density. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り]

Main content area (2 カラム: 左 70% コンテンツ、右 30% CommentPanel):

### Section 1: ページヘッダー（全幅）
- パンくず: "ホーム > 出版パイプライン > テーマ候補 > 詳細"
- タイトル: "{副業 × AI で月 5 万円稼ぐ実践ガイド}"
- 右側アクション:
  - `[ 採用 ]`（プライマリ）
  - `[ 却下 ]`（destructive）
  - `[ バッチ計画へ追加 ]`
  - `[ 再生成 ]`（メニュー奥）

### Section 2: テーマヘッダー情報（左カラム上）
- 横並び: 想定読者 "20-40代 副業初心者" / ジャンル "ビジネス書" / アカウント "{ペンネーム}" / 生成日時 "2026-05-20 23:45"

### Section 3: 差別化要素（左カラム）
- セクション見出し "差別化要素" + 右端に `[+ コメント]`
- 本文（3〜5 段落、各段落に行末 `[+]` コメントアフォーダンス）
- 既存コメントバッジ: "must 1"（赤）

### Section 4: 競合本リスト（左カラム）
- セクション見出し "競合本（5 件）" + `[+ コメント]`
- テーブル: ASIN / タイトル / 順位 / 平均レビュー星 / レビュー要約スニペット
- 5 行

### Section 5: Web Search スニペット（左カラム）
- セクション見出し "Web 検索取得スニペット (8 件)" + `[+ コメント]`
- リスト形式: URL + タイトル + 抜粋 2 行
- 各項目に `[+]` コメントアフォーダンス
- 8 件表示

### Section 6: 想定売上シグナル（左カラム下）
- セクション見出し "想定売上シグナル"
- 横並び: 検索ボリューム / 競合密度 / 平均価格 / 想定 1 ヶ月売上 (¥)
- グラフ風枠 + 数値

### Section 7: CommentPanel（右カラム、常設）
- 見出し "コメント (3)"
- フィルタ: `[全て ▾]` `[優先度 ▾]`
- 既存コメント 3 件（各カードに優先度バッジ must/should/may、対象セクション名、本文、作成日）
- 下部に新規コメント入力欄:
  - 対象セクション: `[差別化要素 ▾]`
  - 優先度: `[must ▾]`
  - 本文 textarea (3 行)
  - `[ コメント追加 ]` ボタン
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー（タイトル + 右上 `[⋯]` メニュー）
2. テーマヘッダー情報（チップ群）
3. 差別化要素 + `[+ コメント]`
4. 競合本リスト（カード形式、5 枚）
5. Web 検索スニペット（5 件）
6. 想定売上シグナル
7. CommentPanel（折りたたみセクション、展開すると下方向に伸びる）
8. 画面下部固定アクションバー: `[ 採用 ]` `[ 却下 ]` `[ ⋯ ]`
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- 画面中央に ConfirmModal を重ねる:
  - タイトル: "重複テーマを検出しました"
  - 本文: "同アカウントで既に承認済みのテーマ {重複テーマタイトル} と類似度 87% です"
  - ボタン: `[ キャンセル ]` `[ それでも採用 ]`（destructive）
- モーダル背景は半透明グレーで他要素を覆う
```

---

## 設計意図メモ（ChatGPT には渡さない）

- F-049 のコメント機能を「テーマ候補」段階から有効化（target_kind=theme として拡張）。CommentPanel を右側に常設し、左で読みながら右で記入できるエディター志向 UX。
- 各セクションに `[+ コメント]` アフォーダンスを散りばめ、AI 出力のどこにでもコメントできることを視覚的に示す。
- 「採用」と「バッチ計画へ追加」を別ボタンにすることで、後段 S-008 への遷移を明示。
