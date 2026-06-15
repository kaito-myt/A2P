# S-026 ジョブ詳細・実行ログ — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-026
- 画面名: ジョブ詳細・実行ログ
- 対応機能 ID: F-045, F-046, F-016
- 元設計書: `docs/04-ui-design.md` §4 S-026
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（実行中ジョブ）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — ログ 0 行 (queued 中)
  - `error.png` — ログ取得失敗

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
- ログストリームは等幅フォント枠 (薄グレー背景)
- JSON ビューはツリー表示の輪郭
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

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "ジョブログ"]

Main content area (2 カラム: 左 70% ログ + ペイロード、右 30% メタ + トークン):

### Section 1: ページヘッダー（全幅）
- パンくず: "ホーム > 運用 > ジョブログ > job_2026_05_20_001"
- タイトル: "ジョブ詳細 — job_2026_05_20_001"
- 右側: `[ 親書籍へ ]` (→ S-010)

### Section 2: ジョブヘッダー（全幅）
- 横並び情報:
  - ID: job_2026_05_20_001
  - 種別: chapter
  - 関連書籍: "{書籍タイトル}" (リンク)
  - ステータス: StatusBadge running
  - 開始: 2026-05-20 23:45 / 終了: —
  - 経過: 03:12
  - リトライ回数: 0

### Section 3: payload_json（左カラム上、折りたたみ JSON ビュー）
- 見出し "payload" + `[ 全展開 ]` `[ 折りたたみ ]` `[ クリップボードへコピー ]`
- ツリービュー (8-10 行):
  - book_id: "..."
  - chapter_index: 3
  - prompt_version_id: "v12"
  - model_assignment: { role: "Writer", provider: "Anthropic", model: "Claude Opus 4.7" }
  - parameters: { ... }

### Section 4: 実行ログストリーム（左カラム中段、メイン領域）
- 見出し "実行ログ" + `[ 自動スクロール ON ]` `[ ダウンロード ]`
- ターミナル風枠 (等幅、薄グレー背景、20 行表示):
  - 23:45:12 [info] Marketer 出力読込
  - 23:45:13 [info] アウトライン取得
  - 23:45:14 [info] Writer 起動: prompt v12
  - 23:45:15 [debug] payload OK
  - 23:45:18 [info] Claude Opus 4.7 リクエスト送信 (in: 5,200 tokens)
  - 23:48:01 [info] レスポンス受信 (out: 32,400 tokens)
  - 23:48:02 [info] Markdown 保存
  - ... 続く
- 下部: "tail: 表示中 (進行中)"

### Section 5: エラー詳細（左カラム下、エラー時のみ表示）
- 折りたたみ可。実行中はバッジ "エラーなし"

### Section 6: TokenUsageInline（右カラム上）
- 見出し "トークン使用量 (このジョブ)"
- 入力: "5,200 tokens"
- 出力: "32,400 tokens"
- 累計コスト: "¥61"
- リアルタイム更新ヒント "5 秒ごと"

### Section 7: ジョブメタ（右カラム中段）
- 親書籍: "{書籍タイトル}" + サムネ枠
- バッチ ID: "batch_2026_05_20_a"
- ワーカー: "worker_3"
- リトライ可能: yes
- ステップ再開対応: yes

### Section 8: アクション（右カラム下）
- `[ リトライ ]`
- `[ ステップから再開 ]` (F-016)
- `[ 中止 ]`（destructive）
- `[ 親書籍へ ]`
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー + `[親書籍]`
2. ジョブヘッダー (折りたたみ可)
3. TokenUsageInline カード
4. payload_json (折りたたみ)
5. 実行ログストリーム (高さ固定、スクロール)
6. エラー詳細 (折りたたみ)
7. 画面下部固定: `[ リトライ ]` `[ 中止 ]` `[ ⋯ ]`
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ジョブヘッダー: ステータス StatusBadge "queued"
- payload_json はそのまま表示
- 実行ログ領域に EmptyState:
  - イラスト枠 "no logs yet"
  - メッセージ: "ログ未生成 (queued 中)"
  - サブメッセージ: "ジョブが実行されるとログが流れます"
  - リフレッシュ自動: "5 秒ごとに自動更新中"
- TokenUsageInline は全て "0"
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- ジョブヘッダー: ステータス StatusBadge "failed" 赤背景
- エラー詳細セクションが展開状態、内容:
  - エラーメッセージ: "rate_limit_exceeded: Too many requests"
  - スタックトレース (5 行)
  - Playwright ジョブの場合のみスクリーンショット枠 (240x160) + `[ 拡大表示 ]`
- ログストリームの末尾も赤ハイライト
- アクションバー: `[ リトライ ]` 強調
- ページ上部に薄いバナー: "このジョブは失敗しました"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- F-016 ステップから再開を右カラムに常設し、リトライと差別化。
- TokenUsageInline でリアルタイム消費を可視化し、コスト超過の早期検出を支援。
- Playwright ジョブのスクショ表示要件 (S-016 の派生) は error バリアントで明示。
