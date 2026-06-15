# S-003 アカウント一覧 — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-003
- 画面名: アカウント一覧
- 対応機能 ID: F-044, F-048
- 元設計書: `docs/04-ui-design.md` §4 S-003
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — アカウント未登録

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
- Pure black-and-white. Use light gray only for de-emphasis. No other colors.
- Use rectangular blocks for sections. Label each section with a Japanese heading.
- Buttons: `[ボタン名 ]`. Input fields: horizontal lines with label. Dropdowns: `[ラベル ▾]`.
- Tables: 8–12 rows. Lists: 5–10 items. Annotations: all in Japanese.
- No real photos, logos, or decorations. No rounded corners, no shadows.
- Show realistic information density.

Persistent UI elements (must appear):
- Top header (64px): 左 = "A2P" ワードマーク、中央 = グローバル検索、右 = CostMeter "3.2万/5万"、AlertBadge "3"、CommentBadge "12 (must:4)"、設定アイコン、ユーザーメニュー
- Left sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト/バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部に JobTicker: "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "アカウント管理"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > アカウント管理"
- タイトル: "アカウント一覧"
- 右上にプライマリボタン `[ + 新規アカウント追加 ]`

### Section 2: アカウントテーブル
- フィルタバー（タイトル下）: `[ジャンル ▾]` `[ステータス ▾]` 検索ボックス
- テーブル列:
  - ペンネーム
  - ジャンル方針（実用書/ビジネス書/自己啓発の比率を 3 セル並べたミニ表）
  - 累計出版数
  - 累計売上 (¥)
  - 平均 Quality
  - 最終出版日
  - アクション（`[ 編集 ]` `[ ⋯ ]`）
- 行数: 8 行（うち Phase 1 は通常 1 行運用）
- 右端のアクションカラムに「削除」を `[ ⋯ ]` メニュー内に格納

### Section 3: ページネーション
- テーブル下: "1 - 8 / 8 件" + `[← 前]` `[次 →]`
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header: ハンバーガー化、CostMeter 縮小表示、バッジ群
Sidebar: ハンバーガー展開

Main content（縦に積む）:
1. ページヘッダー（タイトル + `[+]` フローティングボタン）
2. フィルタチップ群（横スクロール）
3. アカウントカード一覧（テーブルでなくカード）
   - 各カード: ペンネーム / ジャンル比 / 累計冊数 + 売上 / 平均 Quality / `[ 編集 ]`
   - 5 枚表示
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- Header / Sidebar はそのまま
- Main content area: テーブル領域に中央配置の EmptyState
  - イラスト枠 (空の四角に "no data")
  - メッセージ: "アカウントを 1 つ登録してください"
  - サブメッセージ: "ペンネーム単位で書籍・売上・コストを管理します"
  - CTA: `[ + 新規アカウント追加 ]`（プライマリ、中央）
```

---

## 設計意図メモ（ChatGPT には渡さない）

- Phase 1 は 1 アカウント運用だが、F-048 のマルチアカウント対応を見据えてテーブル UI を採用。
- 各行の累計出版数 / 売上 / Quality はアカウント間比較が可能な KPI として配置。
- 削除はソフト削除のみだが UI からは `[ ⋯ ]` メニュー奥に隠して誤操作を防ぐ。
