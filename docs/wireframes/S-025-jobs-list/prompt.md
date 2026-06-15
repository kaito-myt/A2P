# S-025 ジョブログ一覧 — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-025
- 画面名: ジョブログ一覧
- 対応機能 ID: F-045, F-046, F-016
- 元設計書: `docs/04-ui-design.md` §4 S-025
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（バルク選択中）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — ジョブログなし
  - `error.png` — テーブル取得失敗

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This is a BULK OPERATION screen:
- 各行先頭にチェックボックス、ヘッダーに全選択
- 画面下部に BulkActionBar 固定: "N 件選択中 / [選択ジョブを一括リトライ] [選択解除]"
- 件数バッジを目立たせる

Style rules:
- Pure black-and-white, light gray for de-emphasis.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 10–15 rows. No rounded corners or shadows. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "ジョブログ"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 運用 > ジョブログ"
- タイトル: "ジョブログ一覧"
- 右側: "全 1,243 件 / 直近 1,000 件まで表示"

### Section 2: フィルタバー
- 横並び: `[ジョブ種別 ▾]` (book/chapter/cover/revision/catalog/sales/kdp) `[ステータス ▾]` `[期間 ▾]` `[関連書籍 ▾]` 検索

### Section 3: 統計カード（横並び 3 枚、上部）
- 直近 24 時間 成功率: "94%"
- 平均実行時間: "3 分 12 秒"
- 失敗ジョブ件数: "12 件"

### Section 4: ジョブテーブル
- ヘッダー: チェックボックス | ID | 種別 | 関連書籍 | ステータス | 開始 | 終了 | 経過 | リトライ回数 | エラー要約
- 12 行表示、3 行目までチェック ON で "選択中" 状態
- 行例:
  - job_2026... | chapter | "{書籍タイトル}" | StatusBadge done | 2026-05-20 23:45 | 23:48 | 03:12 | 0 | —
  - job_2026... | revision | "{書籍タイトル}" | StatusBadge running | 23:50 | — | 02:30 | 0 | —
  - job_2026... | cover | "{書籍タイトル}" | StatusBadge failed | 23:42 | 23:43 | 00:42 | 2 | "rate_limit" (赤バッジ)
  - ... 計 12 行
- 行クリック → S-026

### Section 5: BulkActionBar（画面下部固定）
- 左: "3 件選択中" バッジ
- 右: `[ 選択ジョブを一括リトライ ]`（プライマリ）`[ 中止 ]` `[ 選択解除 ]`

### Section 6: ページネーション
- "1 - 12 / 1,243 件" + ページネーション
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー
2. フィルタチップ
3. 統計カード（縦並び 3 枚）
4. ジョブカード（テーブルからカード化、8 枚）
   - 各カード: チェック + ID + 種別 + 関連書籍 + ステータス + 経過時間 + リトライ
5. 画面下部に BulkActionBar:
   - "3 件選択中" / `[一括リトライ]`
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタはそのまま
- 統計カード: 全て "0"
- テーブル領域に EmptyState:
  - イラスト枠 "no jobs"
  - メッセージ: "ジョブログがありません"
  - サブメッセージ: "新規プロジェクトを開始するとジョブが生成されます"
  - CTA: `[ 新規プロジェクト ]` (→ S-008)
- BulkActionBar 非表示
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- テーブル領域に ErrorBoundary:
  - 中央メッセージ: "ジョブログの取得に失敗しました"
  - `[ 再読み込み ]` ボタン
- 統計カードは前回キャッシュで表示 + "前回取得: ..." 注記
```

---

## 設計意図メモ（ChatGPT には渡さない）

- F-045 直近 1,000 件を 2 秒以内 + F-046 一括リトライを BulkActionBar に集約。
- ジョブ種別を多様にバラエティ表示 (book/chapter/cover/revision/catalog/sales/kdp) し、システム全体の活動を可視化。
- 失敗ジョブのエラー要約を行内に表示し、S-026 詳細を見ずとも一次判断可能。
