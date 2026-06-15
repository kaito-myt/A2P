# S-023 プロンプト改訂承認 — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-023
- 画面名: プロンプト改訂承認
- 対応機能 ID: F-009, F-029, F-030
- 元設計書: `docs/04-ui-design.md` §4 S-023
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（提案選択 + diff）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 改訂提案なし
  - `error.png` — 二重承認ロック

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

Key rules for this screen:
- 中央メインに DiffViewer (上下並列、Markdown プロンプト diff)
- 追加行 "+", 削除行 "−" マーク
- サンプル出力比較セクションで「旧版で生成 / 提案で生成」の 2 列並列
- AutoApprovalStatusBar を上部に常時表示

Style rules:
- Pure black-and-white, light gray for de-emphasis.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 8–10 rows. No rounded corners or shadows. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "改訂承認"]

Main content area (2 カラム: 左 30% 提案一覧、右 70% 詳細):

### Section 1: ページヘッダー（全幅）
- パンくず: "ホーム > モデル & プロンプト > 改訂承認"
- タイトル: "プロンプト改訂承認"

### Section 2: AutoApprovalStatusBar（全幅、上部）
- 横並びカード:
  - "自動承認モード: 手動" (トグル `[ 手動 / 自動 ]` → 詳細は S-027)
  - "直近 5 冊スコア改善中: 3 / 5" (進捗バー)
  - "条件成立で 24 時間ロールバック猶予あり"

### Section 3: 提案一覧テーブル（左カラム）
- 列: 役割 / ジャンル / 現行→提案 / 期待効果 / ステータス
- 8 行表示
- 行例:
  - Writer | ビジネス書 | v12 → v13 | "+2.5 Q / -¥30" | pending
  - Editor | デフォルト | v5 → v6 | "+1.8 Q" | pending
  - ... 8 行
- 選択行ハイライト

### Section 4: 提案詳細（右カラム）
- 上部ヘッダー: "Writer × ビジネス書 — v12 → v13"
- 改訂意図: テキストカード (3-4 行)
- 期待効果カード: "Quality +2.5 / 1 冊コスト -¥30 / リードタイム -2 分"

### Section 5: DiffViewer (右カラム中央)
- 見出し "プロンプト diff"
- 上下並列:
  - 上ボックス: "v12 (旧)" — Markdown 8 行表示
  - 下ボックス: "v13 (提案)" — Markdown 8 行表示、追加行に "+" 削除行に "−"

### Section 6: サンプル出力比較（右カラム下）
- 見出し "サンプル出力比較 (同条件生成)"
- 2 列並列:
  - 左カード: "v12 出力" — 章本文サンプル 5 行
  - 右カード: "v13 出力" — 章本文サンプル 5 行
- 下部にミニ Quality スコア: 旧 76.2 / 新 81.5

### Section 7: アクションバー（画面下部）
- `[ 承認 ]`（プライマリ）
- `[ 編集して承認 ]`
- `[ 却下 (コメント必須) ]`（destructive）
- `[ ロールバック (自動承認後 24h 以内のみ) ]` (disabled when not applicable)
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー
2. AutoApprovalStatusBar (1 カラム圧縮)
3. 提案一覧（カード形式、5 枚）
4. 提案詳細（折りたたみ）
   - 改訂意図
   - 期待効果カード
   - DiffViewer (縦並び)
   - サンプル出力比較 (タブ切替)
5. 画面下部固定: `[ 承認 ]` `[ 却下 ]` `[ ⋯ ]`
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- AutoApprovalStatusBar はそのまま
- 提案一覧 + 詳細領域に統合 EmptyState:
  - イラスト枠 "no proposals"
  - メッセージ: "改訂提案はありません"
  - サブメッセージ: "10 冊出版ごとに Optimizer が自動生成します"
  - CTA: `[ プロンプト管理へ ]` (→ S-022)
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- 提案詳細領域に赤バナー: "🔒 この提案は他のセッションで承認処理中です。しばらく待ってから再試行してください"
- アクションバー: 全ボタン disabled
- 右下にトースト: "ロック取得失敗"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- UC-03 プロンプト改訂サイクルの中核。「diff + サンプル出力」の 2 重比較で承認可否を判断しやすくする。
- F-030 自動承認モードを上部 AutoApprovalStatusBar に常設し、現在のモードを常に意識させる。
- 「却下 (コメント必須)」を destructive 表示し、F-029 受け入れ基準「却下時のヒント」を担保。
- ロールバックボタンは自動承認後 24 時間以内のみ有効、可視性を保ちつつ通常時は disabled。
