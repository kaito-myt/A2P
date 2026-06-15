# S-021 モデル A/B 比較ビュー — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-021
- 画面名: モデル A/B 比較ビュー
- 対応機能 ID: F-026
- 元設計書: `docs/04-ui-design.md` §4 S-021
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — サンプル不足 (5 冊未満)
  - `error.png` — 期間 A/B 重複

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
- 並列指標カードは横並び 4-5 枚。ボックスプロットは枠 + 縦線 + 箱の輪郭で表現。
- No rounded corners or shadows. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "A/B 比較"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > モデル & プロンプト > A/B 比較"
- タイトル: "モデル A/B 比較ビュー"

### Section 2: 比較設定（フォーム）
- 横並び:
  - 対象役割: `[Writer ▾]`
  - 期間 A: `[2026-04-01 ~ 2026-04-30 ▾]`
  - 期間 B: `[2026-05-01 ~ 2026-05-20 ▾]`
  - `[ 切替日で自動分割 ]` トグル
  - 比較指標: `[Quality / コスト / リードタイム / 売上 / レビュー ▾]` (複数選択)
- `[ 比較を実行 ]`（プライマリ）

### Section 3: サンプル数表示
- 横並び 2 カード:
  - 期間 A: "12 冊 (Claude Opus 4.7)"
  - 期間 B: "10 冊 (Claude Sonnet 4.6)"
- 注記 (緑): "✓ 各期間とも 5 冊以上のサンプルがあります"

### Section 4: 並列指標カード（横並び 5 枚）
- 各カード:
  - メトリクス名 (例: "平均 Quality")
  - A 値 (大): "78.4"
  - B 値 (大): "81.2"
  - 差分: "+2.8" (緑矢印または赤矢印)
  - 有意性: "★ 統計有意 (p<0.05)" or "—"
- 5 メトリクス: 平均 Quality / 平均 1 冊コスト / 平均リードタイム / 売上中央値 / レビュー★

### Section 5: 詳細グラフ（横並び 2 枚 + 下段グラフ）
- 上段: メトリクスごとに 2 期間のボックスプロット (左右並列)
- 下段: 全体散布図 (Quality × コスト)、A群=○ B群=△ で区別

### Section 6: 対象書籍リスト（下段）
- 2 列: A 群 / B 群
- 各列にテーブル: タイトル / Quality / コスト / リードタイム / 売上 / `[詳細]` (→ S-010)
- 各 5-6 行

### Section 7: 推奨アクション
- 下部に薄いカード: "B (Sonnet 4.6) の方が +2.8 Quality / -¥58 コスト。次の 10 冊も B で継続を推奨"
- CTA: `[ Writer を B に固定 ]` (→ S-019)
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー
2. 比較設定フォーム（折りたたみ）
3. サンプル数表示
4. 並列指標カード (1 列 5 枚)
5. 詳細グラフ（縦に積む、ボックスプロット 5 段）
6. 対象書籍リスト (A 群 / B 群 タブ切替)
7. 推奨アクション + CTA
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- 比較設定フォームはそのまま
- サンプル数表示: "期間 A: 3 冊" + "期間 B: 2 冊"
- サンプル数カードに赤注記: "✗ サンプルが 5 冊未満です"
- 並列指標カード / グラフ領域に EmptyState:
  - メッセージ: "最低 5 冊蓄積後に再アクセスしてください"
  - サブメッセージ: "現在のサンプル数では統計的に意味のある比較ができません"
  - CTA: `[ ホームへ ]`
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- 比較設定フォームの下に赤バナー: "期間 A と B が重複しています (2026-05-01 ~ 2026-05-15 が両方に含まれます)"
- 期間 A / B の入力欄に赤枠
- `[ 比較を実行 ]` ボタン disabled
```

---

## 設計意図メモ（ChatGPT には渡さない）

- UC-02 最終ステップの判断画面。「定量的に切替判断」を支援するため、有意性表示を含む統計表現を強調。
- 5 冊未満警告 (F-026 受け入れ基準) を明示し、運用者の早期判断を防ぐ。
- 推奨アクションカードから S-019 ハンドオフでき、「比較 → 即時切替」の体験を実現。
