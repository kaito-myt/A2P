# S-002 ダッシュボード（ホーム） — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-002
- 画面名: ダッシュボード（ホーム）
- 対応機能 ID: F-008, F-010, F-011, F-016, F-032, F-034, F-035, F-036, F-039, F-045, F-049, F-050
- 元設計書: `docs/04-ui-design.md` §4 S-002
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 初回起動（アカウント未登録）
  - `loading.png` — 各セクション skeleton
  - `error.png` — 一部セクション失敗

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 下記「共通プロンプト」と任意の「{バリアント} プロンプト」を結合してコピー
3. ChatGPT に貼り付けて画像生成
4. 出力 PNG を本ディレクトリに上記ファイル名で保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

Output as a single wireframe image with the following style rules:
- Pure black-and-white. Use light gray only for de-emphasis (placeholders, disabled states). No other colors.
- Use rectangular blocks for sections. Label each section with a Japanese heading.
- Buttons: rendered as `[ボタン名 ]` (square brackets, text only).
- Input fields: rendered as horizontal lines `_______` with label above.
- Dropdowns: rendered as `[ラベル ▾]`.
- Avatars/icons: placeholder squares with one-letter labels (e.g. `[A]`).
- Tables: show realistic row count (8–12 rows), not 2–3.
- Lists: show 5–10 items where applicable.
- Annotations and labels: **all in Japanese**.
- No real photos, no logos, no decorative graphics.
- No specific colors, no shadows, no rounded corners (sharp rectangles only).
- Show realistic information density. Avoid empty whitespace unless the variant is the empty state.

Persistent UI elements that MUST appear on every screen except login:
- Top header (64px): 左 = "A2P" ワードマーク、中央 = グローバル検索 `[書籍タイトル/ASIN/テーマID を検索 ____]`、右 = CostMeter（当月コスト進捗バー、例: "3.2万/5万 [緑]"）、AlertBadge（ベルアイコン + 数値 "3"）、CommentBadge（吹出 + 数値 "12 (must:4)"）、設定アイコン、ユーザーメニュー `[A ▾]`
- Left sidebar (240px): 階層ナビ
  - ホーム
  - 出版パイプライン
    - テーマ候補
    - 新規プロジェクト/バッチ計画
    - アウトライン承認
    - サムネ承認
    - KDP 入稿
  - 書籍
    - 書籍ライブラリ
    - 修正コメント
  - 分析
    - 売上・KPI
    - コスト詳細
  - モデル & プロンプト
    - モデル割当
    - モデルカタログ
    - A/B 比較
    - プロンプト管理
    - 改訂承認
  - 運用
    - ジョブログ
    - アラート
    - KDP 自動入稿
    - 監査ログ
    - アカウント管理
    - 設定
- Sidebar 下部に **JobTicker**: "実行中 3 / 上限 5" のチップ
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header および Sidebar は共通プロンプトの通り。アクティブナビは "ホーム"]

Main content area:

### Section 1: トップ KPI ストリップ（横一列、5 枚）
- 配置: 上端
- カード 5 枚（横幅均等）:
  1. 当月出版数: "12 / 100 冊"（小さい棒進捗）
  2. 当月売上: "¥48,200 / ¥150,000"
  3. 当月コスト: "¥32,150 / ¥50,000"（バー進捗、現在 64%）
  4. 平均 Quality スコア: "78.4"（前月比 +2.1）
  5. 進行中ジョブ: "3 / 5 並列"

### Section 2: アクション要求カード（最優先表示、横並び 6 枚）
- 配置: KPI ストリップの直下
- 各カードに件数バッジと CTA ボタン:
  1. "テーマ候補 8 件 未承認" `[ 承認画面へ ]`
  2. "アウトライン 5 件 承認待ち" `[ 承認画面へ ]`
  3. "サムネ 4 件 採用待ち" `[ 採用画面へ ]`
  4. "修正コメント 12 件 未反映（must 4）" `[ コメント一覧へ ]`
  5. "プロンプト改訂提案 1 件" `[ 確認 ]`
  6. "KDP 入稿待ち 2 冊" `[ チェックリストへ ]`

### Section 3: 進行中ジョブ（左 60%、上下中段）
- ヘッダー "進行中ジョブ (3)"
- 各行: 書籍タイトル + フェーズ表示 `Marketer ✓ → Writer ●進行中 → Editor → Thumbnail → Judge` の横ステッパー
- 進捗バー (例: 45%) + 経過時間 "12:34"
- 3 行表示

### Section 4: 未読アラート（右 40%、上下中段）
- ヘッダー "未読アラート (5)"
- 上位 5 件、各行: 種別アイコン + 1 行サマリ + 発生時刻
- 例: "{書籍タイトル} 1 冊コスト ¥520（500 円超過）"

### Section 5: 最近の本（下段、テーブル）
- ヘッダー "最近の本"
- 列: サムネ(プレースホルダ枠) / タイトル / ステータス（StatusBadge） / Quality スコア / 累計コスト / 最終更新
- 10 行表示

### Section 6: コスト推移ミニグラフ（下段右、Section 5 の右）
- ヘッダー "当月コスト推移"
- 折れ線または棒の小グラフ + 5 万円上限ライン点線
- 当日累計 + 予測ライン
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels (iPhone portrait), single column.

Header: 共通プロンプト通り、ロゴ + ハンバーガー + CostMeter（小型化）+ ベル + 吹出
Sidebar: 非表示（ハンバーガー展開時に上から覆い被さる）

Main content（縦に積む）:
1. トップ KPI ストリップ（2 列 x 3 行のグリッドカード、6 枚すべて）
2. アクション要求カード（縦に 6 枚積む、件数 + CTA）
3. 進行中ジョブ（3 行、各行 1 カード）
4. 未読アラート（上位 3 件）
5. 最近の本（5 行、コンパクト表示）
6. コスト推移ミニグラフ
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- Header / Sidebar はそのまま
- Main content area には KPI / カード等を出さず、中央に大きな EmptyState を 1 つ:
  - イラスト枠 (空の四角に "no data")
  - メッセージ: "最初のアカウントを登録しましょう"
  - サブメッセージ: "ペンネームとジャンル方針を登録すると、テーマ生成が可能になります"
  - CTA: `[ アカウントを登録 ]`（プライマリ）
```

---

## loading.png プロンプト

```
Layout: same as desktop.png

Difference:
- 各セクション枠は描画するが、中身はすべて skeleton（薄グレー横帯）
- KPI ストリップ 5 枚: それぞれ 2 行の薄グレー帯
- アクション要求カード 6 枚: タイトル枠と CTA 枠のみ
- 進行中ジョブ 3 行: ステッパーと進捗バーは枠だけ、テキストなし
- 最近の本テーブル: 列ヘッダーは描画、行はすべて skeleton
- Header の CostMeter, バッジは数値の代わりに "—"
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- ほとんどのセクションは正常表示
- 「進行中ジョブ」セクションだけが ErrorBoundary 表示:
  - セクション枠内に "データ取得に失敗しました" メッセージ + `[ 再読み込み ]` ボタン
- 「最近の本」セクションも同様にエラー表示
- 他セクション（KPI, アクション要求, アラート, コスト）は通常表示
- 画面右下に小さなトースト: "一部データの取得に失敗しました"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- ホームは「30 秒で次にやるべきことを把握」する HUD。アクション要求カード列を KPI の直下に配置し、最初に視線が落ちる位置とする。
- 6 種のアクションカード（テーマ/アウトライン/サムネ/コメント/プロンプト/KDP）は UC-01 〜 UC-06 のエントリーポイントを 1 画面で集約する設計。
- CostMeter / AlertBadge / CommentBadge をヘッダー右に固定。3 つとも数値 + 色変化で「常に視界に入る」必須要件（業務要件 §3.3）。
- ErrorBoundary がセクション単位（§6.7 エラー設計指針）なので error バリアントでも全体は崩れない。
