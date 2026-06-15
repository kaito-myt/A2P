# S-013 修正コメント一覧（横断） — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-013
- 画面名: 修正コメント一覧（横断）
- 対応機能 ID: F-049, F-050
- 元設計書: `docs/04-ui-design.md` §4 S-013
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（バルク選択中）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 未消化コメントなし
  - `loading.png` — 推定コスト計算中
  - `error.png` — 推定コスト算出失敗

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This is THE PRIMARY BULK-APPLY screen for revision comments. Critical rules:
- 各行先頭にチェックボックス、ヘッダーに全選択チェックボックス
- 画面下部に BulkActionBar 固定。**「コメントを一括反映」プライマリボタンを極めて目立たせる**（他ボタンより大きく、色濃く太字）
- "N 件選択中" バッジを目立つ位置に
- **重要: この画面には「スケジュール実行」「自動反映」「定期実行」等の UI を一切描かないこと**。F-050 受け入れ基準により自動スケジュールは提供しない。常に運営者の明示クリックがトリガー
- 優先度バッジは色固定: must=赤、should=黄、may=青（文字 + 数字）
- 各書籍に CommentBadge

Style rules:
- Pure black-and-white, light gray for de-emphasis (badges are still B&W, indicated by text "[赤]" or fill pattern).
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 10–12 rows. No rounded corners or shadows. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "修正コメント"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 書籍 > 修正コメント"
- タイトル: "修正コメント一覧"
- 注記 (小さく): "自動スケジュール反映は提供されません。実行ボタン押下で開始します"

### Section 2: フィルタバー
- 横並び: `[書籍 ▾]` `[種別 ▾]`（chapter/outline/cover/cover_text/metadata/theme） `[優先度 ▾]`（must/should/may） `[ステータス: pending ▾]` `[作成日 ▾]`
- 右端にグルーピング切替: `( ● ) 書籍別  ( ) 種別別  ( ) 優先度別`

### Section 3: サマリ KPI カード列（横並び 5 枚）
- pending 件数: "12 件"
- うち must: "4 件"（赤系強調）
- 影響書籍数: "3 冊"
- 推定実行コスト: "¥420"
- 推定実行時間: "8 分"

### Section 4: コメントテーブル
- ヘッダー: チェックボックス | 書籍タイトル | 対象種別アイコン | 対象範囲スニペット | コメント本文 | 優先度 | 作成日 | ステータス
- 12 行表示、3 行目までチェック ON で "選択中" 状態
- 各行例:
  - 書籍: "{副業 × AI ...}"
  - 種別アイコン: "📝章" / "🖼カバー" / "🏷メタ" 等（テキストアイコン）
  - 対象範囲: "第 3 章 / 段落 4" or "表紙タイトル領域"
  - 本文: 1-2 行抜粋
  - 優先度バッジ: "must"(赤) / "should"(黄) / "may"(青)
  - 作成日: "2026-05-20 23:45"
  - ステータス: pending / applied / not_applicable
- グルーピング書籍別の場合、書籍タイトル行で折りたたみセクション
  - 例: "▼ {書籍タイトル} (5 件 / must:2)" + 配下に 5 行のコメント

### Section 5: BulkActionBar（画面下部固定、極めて目立たせる）
- 左: 大きな件数バッジ "3 件選択中 / 影響書籍 2 冊 / 推定 ¥110"
- 中央: **巨大プライマリボタン** `[ ▶ コメントを一括反映 (3 件) ]`（他ボタンの 2 倍サイズ）
- 右: `[ 対象書籍の全 pending を反映 ]`（プライマリ 2 番目）`[ 優先度変更 ▾ ]` `[ 削除 ]` `[ 選択解除 ]`
- 注記 (下部小): "押下後に確認モーダル → 実行進捗画面 (S-014) へ遷移"
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー + 注記 "自動スケジュール反映なし"
2. サマリ KPI カード（2 列 x 3 行）
3. フィルタチップ + グルーピング切替
4. コメントカード（書籍別折りたたみ）
   - 各書籍ヘッダー "▼ {書籍タイトル} (5 件)"
   - 配下 5 件のコメントカード（チェックボックス、優先度、本文抜粋）
5. 画面下部に大型 BulkActionBar 固定:
   - 大きく "3 件選択中"
   - 巨大プライマリ `[ ▶ 一括反映 ]`
   - サブ `[ ⋯ ]`
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタはそのまま
- サマリ KPI は全て 0
- テーブル領域に EmptyState:
  - イラスト枠 "all clear"
  - メッセージ: "未消化の修正コメントはありません"
  - サブメッセージ: "AI 出力にコメントを追加してから戻ってきてください"
  - CTA: `[ 書籍ライブラリへ ]` (→ S-009)
- BulkActionBar 非表示
```

---

## loading.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタはそのまま
- サマリ KPI のうち「推定実行コスト」「推定実行時間」は計算中スピナー + "計算中..."
- テーブルは描画済み（コメント自体は表示可）
- BulkActionBar 内の「推定 ¥110」が "計算中..."
- `[ 一括反映 ]` ボタンは押下可能だがツールチップ「コスト推定中」
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- サマリ KPI のうち「推定実行コスト」「推定実行時間」が "概算なし" 表示
- 上部に薄いバナー: "コスト推定に失敗しましたが、実行は可能です"
- テーブルは正常表示
- BulkActionBar の `[ 一括反映 ]` は通常通り押下可能（注意マーク付き）
```

---

## 設計意図メモ（ChatGPT には渡さない）

- UC-06 の中枢画面。「N コメントを 1 ボタンで反映」の核心 UX を視覚化。
- F-050 受け入れ基準「自動スケジュール実行は提供しない」をプロンプト中に明示し、ChatGPT が「定期実行」「夜間自動」UI を勝手に描かないようガード。
- BulkActionBar の `[ 一括反映 ]` を意図的に巨大化することで「これが本画面の主役」を強調。
- 書籍単位グルーピングを既定にし、書籍ごとの排他制御（実行中ジョブと衝突しないよう）を運用者が判断しやすくする。
- サマリ KPI に「推定実行コスト」を置き、F-050 + F-036 連動でコスト感を持たせる。
