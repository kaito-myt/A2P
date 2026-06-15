# S-024 コスト詳細ダッシュボード — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-024
- 画面名: コスト詳細ダッシュボード
- 対応機能 ID: F-032, F-033, F-034, F-035, F-036
- 元設計書: `docs/04-ui-design.md` §4 S-024
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — コスト記録なし (初回)
  - `loading.png` — チャート skeleton
  - `error.png` — 集計失敗

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
- Stacked bar / 線グラフは枠 + 簡易輪郭で表現。閾値線は破線水平線 + ラベル。
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

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "コスト詳細"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 分析 > コスト詳細"
- タイトル: "コスト詳細ダッシュボード"
- 右側: `[ CSV エクスポート ]` `[ 設定 (S-027) ]`

### Section 2: 期間/フィルタバー
- 横並び: `[期間: 今月 ▾]` `[アカウント ▾]` `[ジャンル ▾]` `[プロバイダ ▾]` `[モデル ▾]` `[役割 ▾]`

### Section 3: 集計 KPI ストリップ（横並び 5 枚）
- 当月実績: "¥32,150"
- 月末予測: "¥48,200" (緑/黄/橙/赤バッジ)
- 上限残額: "¥17,850"
- コスト/売上比率: "14.6%"
- 1 冊平均: "¥382"

### Section 4: PredictionAlertStrip（横並び 3 セル）
- イエロー閾値 ¥40,000 (80%) — 現在: ✓ 達成
- オレンジ閾値 ¥47,500 (95%) — 現在: 未達
- レッド閾値 ¥50,000 (100%) — 現在: 未達
- 現在ステータスバッジ: "🟡 警戒域 (80-95%)"

### Section 5: 当月日次積み上げグラフ（左 60%）
- 見出し "当月日次コスト (プロバイダ別 stacked bar)"
- 横軸: 1-31 日 / 縦軸: ¥
- 5 万円ライン: 水平破線 + ラベル "上限 ¥50,000"
- 4 万円ライン: 水平破線 + ラベル "80%"
- スタック色は 3 種類 (パターン違い): Anthropic / OpenAI / Gemini

### Section 6: 切り口別積み上げグラフ × 3（右 40%、縦並び）
- プロバイダ別 stacked bar (累計)
- モデル別 stacked bar
- 役割別 stacked bar (Writer / Editor / Marketer / Judge / Thumbnail / Optimizer)

### Section 7: 書籍別コストランキング（下段左 60%）
- 見出し "高コスト Top 20"
- 列: 順位 | サムネ | タイトル | 累計コスト | 内訳 (in/out) | ステータス | 500 円超過バッジ
- 10 行表示。500 円超過行は赤背景、750 円超過は太赤

### Section 8: ジョブ停止履歴（下段右 40%）
- 見出し "750 円到達で停止された書籍"
- テーブル: 停止時刻 / 書籍 / コスト / `[ 続行 ]` `[ 中止 ]` (→ S-010)
- 5 行表示

### Section 9: フッター
- 強制続行スイッチ (折りたたみ): "レッド到達時の新規ジョブキック解除"
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー + `[CSV]`
2. フィルタチップ (横スクロール)
3. 集計 KPI (2 列 x 3 行)
4. PredictionAlertStrip (3 段、縦並び)
5. 当月日次積み上げグラフ (横スクロール)
6. 切り口別グラフ (タブ切替: プロバイダ / モデル / 役割)
7. 書籍別コストランキング (カード 8 枚)
8. ジョブ停止履歴 (3 件)
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタはそのまま
- KPI ストリップ / グラフ / テーブル領域に統合 EmptyState:
  - イラスト枠 "no cost"
  - メッセージ: "コスト記録がありません"
  - サブメッセージ: "ジョブ実行が始まるとここに集計が表示されます"
  - CTA: `[ 新規プロジェクト ]` (→ S-008)
```

---

## loading.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタはそのまま
- KPI / グラフ / テーブル領域すべて skeleton (薄グレー帯)
- 各グラフ枠内に "読込中..." + 小スピナー
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- ページ上部に赤バナー: "コスト集計に失敗しました" + `[ 再読み込み ]`
- 一部 KPI は前回キャッシュで表示、他は "—"
- グラフセクションに ErrorBoundary: "データ取得失敗" + 個別 `[ 再読み込み ]`
- テーブル領域は通常表示の継続
```

---

## 設計意図メモ（ChatGPT には渡さない）

- UC-04 中核画面。コスト軸の全可視化と F-036 月末予測 + 閾値モニタを 1 画面に集約。
- 5 万円ラインを破線で全グラフに横断させ、視覚的に「上限への距離」を意識させる（業務要件 §3.3 コスト常時可視化）。
- 750 円到達で停止された書籍テーブルから「続行/中止」を直接操作でき、UC-04 のアラート → 続行ループを支援。
- 強制続行スイッチはレッド到達時のみ意味があるため、折りたたみで普段は非表示。
