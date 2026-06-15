# S-017 売上・KPI ダッシュボード — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-017
- 画面名: 売上・KPI ダッシュボード
- 対応機能 ID: F-037, F-038, F-039
- 元設計書: `docs/04-ui-design.md` §4 S-017
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 売上データなし
  - `loading.png` — グラフ skeleton
  - `error.png` — 自動取得失敗

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
- Tables 10–12 rows. No rounded corners or shadows. Japanese labels.
- グラフは枠 + 簡易折線/棒の輪郭で表現

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

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 分析 > 売上・KPI"
- タイトル: "売上・KPI ダッシュボード"
- 右側: `[ 売上を手動入力 ]` (→ S-018) + `[ Amazon から手動取得 ]`

### Section 2: 期間/フィルタバー
- 横並び: `[期間: 今月 ▾]` (今月/3/6/12ヶ月) `[アカウント ▾]` `[ジャンル ▾]`
- 右端: "自動取得状態: 2026-05-20 06:00 取得済"

### Section 3: 集計 KPI ストリップ（横並び 5 枚）
- 累計売上: "¥124,500" (前月比 +12%)
- 累計冊数: "24 冊"
- 平均 1 冊売上: "¥5,187"
- 平均レビュー星: "4.2 ★"
- コスト/売上比率: "14.6%"

### Section 4: 売上推移グラフ（左 60%）
- セクション見出し "売上推移 (月次積み上げ)"
- 横軸: 月 (12 ヶ月) / 縦軸: ¥
- ジャンル別色分けの stacked bar （色なし、パターン違いで表現）
- 凡例: 実用書 / ビジネス書 / 自己啓発

### Section 5: ヒートマップ（右 40%）
- セクション見出し "ジャンル × 月 売上ヒートマップ"
- マトリクス: 3 ジャンル × 12 月
- 各セルの濃淡で売上量を表現（薄=低 / 濃=高）

### Section 6: 書籍別 KPI テーブル
- ヘッダー: サムネ | タイトル | 出版日 | ASIN | 月次売上 | 累計売上 | 順位 | ★ | Quality | 累計コスト | ROI
- 10 行表示、ROI 列は "+212%" のような表記
- 100 冊規模対応のため仮想スクロール示唆 (small text)
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー + `[手動入力]`
2. 期間/フィルタチップ
3. KPI ストリップ (2 列 x 3 行)
4. 売上推移グラフ（横スクロール）
5. ヒートマップ（横スクロール）
6. 書籍別 KPI テーブル（カード形式に変換、5 枚）
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタはそのまま
- KPI ストリップ: 全て "—" 表示
- グラフ・ヒートマップ・テーブル領域に統合 EmptyState:
  - イラスト枠 "no sales"
  - メッセージ: "売上データがありません"
  - サブメッセージ: "Phase 1 は手動入力、Phase 2 で Amazon から自動取得します"
  - CTA: `[ 売上を手動入力 ]` (→ S-018)
```

---

## loading.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタ / KPI ストリップは描画 (数値は skeleton 帯)
- グラフ・ヒートマップ・テーブル領域は skeleton
- 右上に小さなスピナー + "読込中..."
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- ページ上部に黄色バナー: "Amazon 自動取得に失敗しました (2026-05-20 06:00)" + `[ 再取得 ]` `[ 詳細ログ ]`
- 「自動取得状態」表示が "取得失敗"
- KPI ストリップ・グラフは前回取得分で表示（"前回取得: 2026-05-19" 注記）
```

---

## 設計意図メモ（ChatGPT には渡さない）

- 縦軸が売上、コスト軸とは別画面（S-024）に意図的に分離（密度過多回避、§2.3 統合・補足判断）。
- 100 冊規模で 2 秒以内表示 (F-039 受け入れ基準) を満たすため仮想スクロール示唆。
- ヒートマップで「どのジャンル × どの月が稼げているか」を一目で把握可能にし、長期プラン (S-005) の方針調整に活かす設計。
- 手動入力 (Phase 1) と自動取得 (Phase 2) が併存する構成を見越し、両 CTA を併設。
