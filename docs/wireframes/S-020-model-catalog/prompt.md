# S-020 モデル単価カタログ — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-020
- 画面名: モデル単価カタログ
- 対応機能 ID: F-024, F-025
- 元設計書: `docs/04-ui-design.md` §4 S-020
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 初回（自動取得待ち）
  - `error.png` — バッチ取得失敗

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

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "モデルカタログ"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > モデル & プロンプト > モデルカタログ"
- タイトル: "モデル単価カタログ"
- 右側: `[ CSV エクスポート ]` `[ カタログ手動更新 ]`（プライマリ）

### Section 2: フィルタバー
- プロバイダフィルタ: `[全て ▾]` (Anthropic / OpenAI / Gemini)
- ソート: `[入力単価昇順 ▾]` (選択肢: 入力単価 / 出力単価 / 1 冊予測コスト / 更新日時)
- 右端: "最終取得: 2026-05-20 06:00 (自動)"

### Section 3: カタログテーブル
- ヘッダー: プロバイダ | モデル名 | 入力単価 (¥/1k) | 出力単価 (¥/1k) | 1 冊予測コスト | 更新日時 | ソース | 前回比
- 12 行表示
- 行例:
  - Anthropic | Claude Opus 4.7 | ¥15 | ¥75 | ¥330 | 2026-05-20 06:00 | API公式 | "+2.1%"
  - Anthropic | Claude Sonnet 4.6 | ¥3 | ¥15 | ¥75 | 2026-05-20 06:00 | API公式 | "-0.5%"
  - OpenAI | gpt-image-1 | ¥4 | ¥4 | ¥40 (画像 4 枚) | 2026-05-20 06:00 | 公式 | "0%"
  - ... 計 12 行
- 前回比 ±10% 超は警告アイコン
- 行クリック → S-019 にハンドオフ（このモデルを割当）。各行右に `[ 割当へ ]`

### Section 4: 変動履歴セクション（下部）
- 見出し "単価変動履歴 (±10% 超のみ)"
- テーブル: 日時 / プロバイダ / モデル / 旧単価 → 新単価 / 変動率 / 種別
- 5 行表示

### Section 5: 1 冊予測コストの計算前提（折りたたみ）
- 見出し "予測前提"
- 注記: "入力 5,000 トークン / 出力 30,000 トークン想定。実測値と乖離する場合があります"
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー + `[手動更新]`
2. プロバイダフィルタチップ + ソート
3. カタログカード（テーブルからカード化、8 枚）
   - 各カード: プロバイダ + モデル名 + 入/出単価 + 1 冊予測コスト + 前回比 + `[割当へ]`
4. 変動履歴 (3 行)
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタはそのまま
- テーブル領域に EmptyState:
  - イラスト枠 "no catalog"
  - メッセージ: "カタログ未取得です"
  - サブメッセージ: "自動取得バッチが完了するとここに表示されます (毎日 06:00)"
  - CTA: `[ カタログ手動更新 ]`
- 「最終取得」表示が "未取得"
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- ページ上部に黄色バナー: "前回の自動取得が失敗しました (2026-05-20 06:00): API レート制限" + `[ リトライ ]` `[ ジョブ詳細 (S-026) ]`
- テーブルは前回成功分で表示（"前回成功: 2026-05-19 06:00" 注記）
- 「最終取得」表示が "取得失敗"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- F-024 日次自動取得 + 手動更新の両運用を 1 画面で。前回比 ±10% 警告で単価変動を即時可視化（F-024 アラート連動）。
- 1 冊予測コストを計算済み列として並べることで、S-019 でのモデル切替判断を即座に支援。
- 行クリックで S-019 にハンドオフし、「カタログ閲覧 → 割当変更」を 2 クリックで完結。
