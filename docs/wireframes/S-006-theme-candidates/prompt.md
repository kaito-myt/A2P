# S-006 テーマ候補一覧（バルク承認） — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-006
- 画面名: テーマ候補一覧（バルク承認）
- 対応機能 ID: F-001, F-017
- 元設計書: `docs/04-ui-design.md` §4 S-006
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（バルク選択中）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — テーマ未生成
  - `loading.png` — テーマ生成中
  - `error.png` — 個別行失敗

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントプロンプトを結合してコピー
3. ChatGPT に貼り付けて画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This is a BULK OPERATION screen. The following bulk-op patterns are MANDATORY:
- 各テーブル行の先頭にチェックボックス列を必ず描画する
- ページ最上部または最下部に **BulkActionBar** を固定表示: "N 件選択中 / [一括承認] [一括却下] [選択解除]"
- BulkActionBar に件数バッジを目立つ位置に描画
- ヘッダー行にも「全選択」チェックボックスを置く

Style rules:
- Pure black-and-white, light gray for de-emphasis.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 8–12 rows. No rounded corners or shadows.
- Realistic info density. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "テーマ候補"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 出版パイプライン > テーマ候補"
- タイトル: "テーマ候補一覧"
- 右側: `[ + 新規テーマ生成 ]`（プライマリ、クリックで生成数指定モーダル）

### Section 2: フィルタバー
- 横並び: `[アカウント ▾]` `[ジャンル ▾]` `[生成日: 今週 ▾]` `[ステータス: pending ▾]` 検索ボックス
- 右端: "全 124 件 / pending 32 件 / accepted 76 件"

### Section 3: テーマ候補テーブル
- ヘッダー行: チェックボックス（全選択）| タイトル | 想定読者 | 差別化要素 | 競合 ASIN/URL | 想定売上シグナル | 生成日時 | ステータス
- 10 行表示。**3 行目までチェック ON** にして "選択中" 状態を可視化
- 各行例:
  - "{副業 × AI で月 5 万円稼ぐ実践ガイド}" / "20-40代 副業初心者" / "AI 活用法に特化" / "B0X..., B0Y..." / "★★★☆☆" / "2026-05-20 23:45" / StatusBadge pending
- 行クリックで S-007 詳細
- ステータスバッジ: pending=灰 / accepted=緑枠 / rejected=赤枠

### Section 4: BulkActionBar（画面下部固定、目立つ太枠）
- 左: "3 件選択中" バッジ
- 右: `[ 一括採用 ]`（プライマリ）`[ 一括却下 ]`（destructive）`[ 採用してバッチ計画へ ]`（プライマリ） `[ コメント追加 ]` `[ 選択解除 ]`

### Section 5: ページネーション
- テーブル下に "1 - 10 / 124 件" + `[← 前]` `[次 →]`
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー（タイトル + `[+]` 右上）
2. フィルタチップ（横スクロール）
3. テーマ候補カード（テーブルでなくカード形式、各カード先頭にチェックボックス）
   - タイトル / 想定読者 / 差別化要素 / バッジ
   - 6 枚表示
4. 画面下部に BulkActionBar 固定:
   - "3 件選択中" / `[採用]` `[却下]` `[バッチへ]`
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタバーはそのまま
- テーブル領域に EmptyState:
  - イラスト枠 "no themes"
  - メッセージ: "テーマ候補がまだありません"
  - サブメッセージ: "アカウントとジャンルを選んで生成を実行してください"
  - CTA: `[ + 新規テーマ生成 ]`
- BulkActionBar は非表示
```

---

## loading.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタバー / BulkActionBar はそのまま
- テーブル領域は skeleton: 列ヘッダーのみ、各行は薄グレー帯
- テーブル上部に進捗バー + ラベル "テーマ生成中: 12 / 30"
- 右端に "推定残り 1 分 20 秒"
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- テーブルは描画されているが、2 行・5 行・8 行目に赤系の警告バッジ "生成失敗" + 行末に `[ リトライ ]` ボタン
- ページ上部に "3 件の生成に失敗しました" 赤バナー + `[ まとめてリトライ ]`
- 他の行は通常表示
```

---

## 設計意図メモ（ChatGPT には渡さない）

- バルクオペレーション画面の典型。3 行目までチェック ON にし「選択中の見え方」を ChatGPT に明示。
- F-017 受け入れ基準「20 件以上を 1 操作で承認」を満たすため、ヘッダー行に全選択を置く + BulkActionBar に件数バッジを目立たせる。
- 「採用してバッチ計画へ」CTA を BulkActionBar に併設することで、UC-01 の S-006 → S-008 ハンドオフを 1 クリックに短縮。
- 生成中は別行で進捗バー表示（既存テーブルの上に薄く重ねる）。
