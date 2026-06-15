# S-019 モデル割当（役割×ジャンル） — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-019
- 画面名: モデル割当（役割×ジャンル）
- 対応機能 ID: F-022, F-023, F-025
- 元設計書: `docs/04-ui-design.md` §4 S-019
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（マトリクス + カタログサイドペイン）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 初回（推奨デフォルトプリセット表示）
  - `error.png` — カタログ未取得モデル指定時

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This screen MUST show:
- 左メイン: 役割 × ジャンル の AssignmentMatrix
- **右側に常設の ModelCatalogSidePane** (320px 幅、S-020 のサブセット)。プロバイダ別モデル一覧、ドラッグ可能なチップ
- マトリクスセル選択時の編集パネル下部に **CostDiffPreview**（変更前後のコスト差、過去 30 日実績）
- 履歴セクションは下部

Style rules:
- Pure black-and-white, light gray for de-emphasis.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- マトリクスはグリッド表現 (縦軸 6 役割 × 横軸 4 ジャンル)
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

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "モデル割当"]

Main content area (左 70% マトリクス、右 30% カタログサイドペイン):

### Section 1: ページヘッダー（全幅）
- パンくず: "ホーム > モデル & プロンプト > モデル割当"
- タイトル: "モデル割当（役割 × ジャンル）"
- 右側: `[ 過去版に戻す ▾ ]` `[ 保存（次回ジョブから適用） ]`（プライマリ）

### Section 2: AssignmentMatrix（左カラム上）
- グリッド表示。縦軸 (行): Writer / Editor / Marketer / Judge / Thumbnail / Optimizer
- 横軸 (列): デフォルト / 実用書 / ビジネス書 / 自己啓発
- 各セル: 縦 2 行表記
  - 上行: "Claude Opus 4.7" (ModelBadge)
  - 下行: small "入 ¥X / 出 ¥Y per 1k"
- ホバー時のセル選択ハイライト (例: Writer × ビジネス書 セルを選択中の枠線強調)

### Section 3: セル選択時の編集パネル（マトリクスの下）
- 見出し "編集: Writer × ビジネス書"
- 横並び:
  - プロバイダ `[Anthropic ▾]`
  - モデル `[Claude Opus 4.7 ▾]`
- 下に CostDiffPreview:
  - 表: 過去 30 日実績 ¥X,XXX → 切替後 ¥Y,YYY (差分 +/-Z%)
  - 1 冊あたり予測: ¥A → ¥B
- `[ この変更を保存 ]` `[ キャンセル ]`

### Section 4: ModelCatalogSidePane（右カラム、常設）
- 見出し "モデルカタログ" + `[ 詳細 (S-020) ]`
- プロバイダタブ: Anthropic / OpenAI / Gemini
- 各タブ配下にモデルチップ:
  - "Claude Opus 4.7" + 単価 "入 ¥15 / 出 ¥75"
  - "Claude Sonnet 4.6" + 単価
  - "gpt-image-1" + 単価
  - 他 5-8 モデル
- 各チップに "ドラッグでマトリクスに割当" のヒント
- 下部に最終更新: "2026-05-20 06:00 自動取得"

### Section 5: 履歴セクション（下部）
- 見出し "割当変更履歴 (直近 10 件)"
- テーブル: 日時 / 役割 / ジャンル / 旧モデル → 新モデル / 変更者 / `[ 戻す ]`
- 10 行表示
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー + `[保存]`
2. AssignmentMatrix（横スクロール、コンパクト表示）
3. セル選択時の編集パネル（タップ展開）
4. ModelCatalogSidePane（折りたたみセクション）
5. 履歴 (5 行)
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- マトリクスは推奨デフォルトでプリセット表示（全セル埋まっている）
- 上部に薄いバナー: "推奨デフォルトをプリセットしました。必要に応じて編集してください"
- 履歴セクションは EmptyState: "変更履歴はまだありません"
- ModelCatalogSidePane は通常表示
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- セル選択時の編集パネル内で、プロバイダ・モデル選択後に赤バナー:
  - "選択したモデル 'claude-opus-5.0' はカタログに存在しません。カタログ取得バッチを実行してください"
  - `[ カタログ更新 ]` (→ S-020 でバッチ起動)
- `[ この変更を保存 ]` ボタン disabled
```

---

## 設計意図メモ（ChatGPT には渡さない）

- F-022 のマルチプロバイダ抽象化を「マトリクス UI」として可視化（業務要件 §3.3 後続申し送り 2）。
- ModelCatalogSidePane を画面右に常設することで、別画面遷移なしに「どのモデルがあるか」「単価がいくらか」を確認しながら割当変更可能（業務要件「ワンストップ運用」）。
- CostDiffPreview により「切替の経済的影響」を即時可視化、UC-02 のモデル A/B 検証を後押し。
- 履歴を画面下に置き、F-022 受け入れ基準「過去の割当に戻せる」を 1 クリックで実現。
