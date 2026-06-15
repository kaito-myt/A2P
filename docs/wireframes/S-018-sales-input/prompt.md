# S-018 売上手動入力 — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-018
- 画面名: 売上手動入力
- 対応機能 ID: F-037
- 元設計書: `docs/04-ui-design.md` §4 S-018
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `error.png` — CSV パース失敗（行番号付きエラー）

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

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

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "売上・KPI"]

Main content area (左 60% フォーム、右 40% CSV インポート):

### Section 1: ページヘッダー
- パンくず: "ホーム > 分析 > 売上・KPI > 手動入力"
- タイトル: "売上手動入力"
- 右側: `[ 売上ダッシュボードへ戻る ]` (→ S-017)

### Section 2: 入力対象選択（左カラム上）
- 横並び: `[書籍 ▾]` (検索可、ASIN 検索対応) + `[年月 ▾]`（例: 2026-05）
- 注記: "既存データがあれば自動的に上書き入力モードになります"

### Section 3: 売上入力フォーム（左カラム）
- セクション見出し "売上データ"
- 縦並び入力欄:
  - ロイヤリティ (JPY): `_______`
  - レビュー件数: `_______`
  - 平均星 (1.0 - 5.0): `_______`
  - Amazon 順位: `_______`
- 下部: `[ 保存 ]`（プライマリ）`[ クリア ]`

### Section 4: 履歴サマリ（左カラム下、選択中書籍の過去 6 ヶ月）
- セクション見出し "{書籍タイトル} の過去 6 ヶ月"
- ミニテーブル: 年月 | 売上 | レビュー件数 | ★
- 6 行表示

### Section 5: CSV インポート（右カラム）
- セクション見出し "一括 CSV インポート"
- ボタン: `[ テンプレート CSV をダウンロード ]`
- ファイル選択枠 (ドロップエリア): "クリックまたはドラッグでファイル選択"
- アップロード後のプレビュー領域 (折りたたみ可)
- 注記: "1 行 = 1 (書籍 ASIN, 年月) の組み合わせ。重複は upsert します"
- `[ CSV を取り込む ]`（プライマリ）
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー
2. 入力対象選択（書籍 + 年月）
3. 売上入力フォーム
4. `[ 保存 ]` ボタン
5. 履歴サマリ（折りたたみ）
6. CSV インポートセクション（折りたたみ）
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- CSV インポートセクションにエラー領域:
  - 赤バナー: "CSV パースに失敗しました (3 行)"
  - 行番号付きエラー詳細リスト:
    - "12 行目: 書籍 ASIN 'B0XXX' が見つかりません"
    - "27 行目: 年月形式が不正です (2026/5 → 2026-05 を期待)"
    - "45 行目: ロイヤリティが負の値です"
  - `[ エラー行を除外して取り込み ]` `[ 修正後再アップロード ]`
- フォーム側は通常表示
- 右下にトースト: "0 / 50 行を取り込みました"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- 手動入力は Phase 1 必須、Phase 2 で F-038 自動取得が走っても補完用として残る。
- 右カラムに CSV 一括インポートを置くことで「1 件ずつ + まとめて」両運用を担保。
- 行番号付きエラーは運用者が CSV を修正しやすくする UX（業務要件 §3 実務志向）。
