# S-010 書籍詳細・章エディタ — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-010
- 画面名: 書籍詳細・章エディタ
- 対応機能 ID: F-003, F-004, F-005, F-008, F-012-F-015, F-018, F-033, F-049
- 元設計書: `docs/04-ui-design.md` §4 S-010
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（章本文タブ）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 章本文未生成（Writer ジョブ進行中）
  - `loading.png` — タブ別 lazy load
  - `error.png` — タブ取得失敗

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This screen is COMMENT-CENTRIC:
- 章本文の各段落右側に小さな `[+]` コメントアフォーダンスを置く（5 段落以上）
- 既存コメントは段落右側にバッジ表示（must=赤 / should=黄 / may=青、文字 + 数字）
- カバー画像上は座標領域指定可（点線枠で例示）
- メタデータ各フィールド横にも `[+]` アフォーダンス
- 右側に CommentDrawer（折りたたみ可、開時 360px 幅）

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

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "書籍ライブラリ"]

Main content area (2 カラム: 左 70%、右 30% CommentDrawer):

### Section 1: 書籍ヘッダー（全幅）
- パンくず: "ホーム > 書籍 > {タイトル}"
- タイトル: "{副業 × AI で月 5 万円稼ぐ実践ガイド}"
- サブタイトル: "{初心者でも今日から始められる実践 7 ステップ}"
- バッジ行: アカウント "{ペンネーム}" / ジャンル "ビジネス書" / ステータス StatusBadge "published" / Quality "82.3" / ASIN "B0XXXX"
- 累計コスト: "¥432" + バー "/ ¥500 閾値"（500 円閾値線を赤で表示、750 円も）
- 右側アクション群: `[ 成果物ダウンロード ▾ ]` `[ KDP 入稿準備 ]` `[ コメント一括反映 ]` `[ 再生成 ▾ ]` `[ アーカイブ ]`

### Section 2: タブナビゲーション
- 横並びタブ: アウトライン / 章本文 (active) / カバー / メタデータ / 評価履歴 / コスト内訳 / ジョブ履歴 / コメント
- 各タブにバッジ（例: コメント "12 (must:3)"）

### Section 3: 章本文タブのコンテンツ（中央メイン領域）
- 上部左に章セレクタ: `[第 3 章: AI ツールの選定 ▾]` (全 7 章)
- 中央 Markdown ビュー（仕切り線 + 5-7 段落のテキスト枠、各段落右端に `[+]` コメントアフォーダンス）
- いくつかの段落に既存コメントバッジ
  - 段落 2 行末: "must 1"（赤）
  - 段落 4 行末: "should 2"（黄）
- 段落の左端に小さな ModelBadge "Claude Opus 4.7"
- 下部に "章コスト: ¥61 / トークン: in 5,200 out 32,400" の TokenMeter

### Section 4: CommentDrawer（右カラム、常設）
- 見出し "コメント (12) — must: 3"
- フィルタ: `[全て ▾]` `[優先度 ▾]` `[ステータス ▾]`
- 既存コメント 5 件カード:
  - 各カード: 対象種別アイコン (章/カバー/メタ) + 対象範囲スニペット + 本文 + 優先度バッジ + ステータス pending/applied
- 下部に新規コメント入力:
  - 対象種別 `[章本文 ▾]` + 対象範囲 (選択中段落表示)
  - 優先度 `[must ▾]`
  - 本文 textarea (3 行)
  - `[ コメント追加 ]`
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. 書籍ヘッダー（タイトル + バッジ群、コスト進捗）
2. タブナビ（横スクロール、active=章本文）
3. 章セレクタプルダウン
4. 章本文 Markdown ビュー（各段落右に `[+]` 縦長 → 段落下にコメントバッジ）
5. 章コスト TokenMeter
6. CommentDrawer は下部に縮めたフローティングボタン `[💬 12 (must:3)]`
   - タップで全画面ドロワー展開
7. 画面下部固定アクションバー: `[ ⋯ ]` メニュー（ダウンロード/入稿/反映/再生成）
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference (章本文未生成):
- ヘッダー / タブ / 章セレクタはそのまま
- 章本文 Markdown ビュー領域に skeleton + 中央に:
  - メッセージ: "Writer ジョブ進行中..."
  - 進捗バー (45%)
  - 経過時間 "12:34" / 推定残り "8:12"
  - サブ: "完了すると自動更新されます" + `[ ジョブ詳細へ ]` リンク
- CommentDrawer 領域もコメント 0 件: "コメントを追加して品質を改善できます"
```

---

## loading.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー、タブナビは描画
- タブ本文（章本文ビュー）は skeleton: 章セレクタ + 5 段落分の薄グレー帯
- CommentDrawer 領域も skeleton
- タブ別 lazy load を表現するため、右上に小さなスピナー
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / タブはそのまま
- 章本文タブ領域に ErrorBoundary:
  - 中央メッセージ: "章本文の取得に失敗しました"
  - `[ 再読み込み ]` ボタン
- 他タブ（コスト内訳、ジョブ履歴）はバッジで読める状態を示唆
- 画面右下にトースト: "一部データの取得に失敗"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- 書籍 1 冊の全成果物に到達できる "中心ハブ" 画面。タブ 8 個で領域を切り分け、章本文タブを既定とする（実務で最頻アクセス）。
- 段落単位 CommentAffordance は F-049 の核心。F-049 受け入れ基準「AI 出力の任意位置にコメント」を視覚化。
- 累計コスト表示に 500/750 円閾値線を明示し（F-034）、運用者がコスト感覚を持って章レビューできるようにする。
- ModelBadge を段落左端に置くことで、A/B 配信時のモデル特定が容易（F-031 連動）。
