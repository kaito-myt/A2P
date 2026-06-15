# S-014 修正一括反映 実行・進捗・diff レビュー — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-014
- 画面名: 修正一括反映 実行・進捗・diff レビュー
- 対応機能 ID: F-050, F-008, F-049
- 元設計書: `docs/04-ui-design.md` §4 S-014
- 想定画像:
  - `desktop.png` — 実行中（進捗表示）
  - `done.png` — 完了後の diff レビュー画面
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 実行履歴なし（通常は到達しない）
  - `error.png` — 個別コメント適用失敗 or run 全体失敗

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This screen shows REVISION RUN PROGRESS + DIFF REVIEW. Key rules:
- 上部に実行ヘッダー、その下に全体進捗バー（必ず描画）
- 書籍別進捗カードを縦並び (4-6 枚)
- 完了後は DiffReview セクションを下に追加描画
- Diff コンテンツの種別ごとレンダラ:
  - 章本文 (Markdown): **上下並列** 表示（上=元、下=修正）行 add は "+", del は "−" マーク
  - サムネ画像: **左右並列** before / after プレースホルダ枠
  - メタデータ (JSON): **左右並列** JSON ツリー
- 適用不可 (not_applicable) は理由テキストを表示

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

## desktop.png プロンプト（実行中）

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り]

Main content area:

### Section 1: 実行ヘッダー
- パンくず: "ホーム > 書籍 > 修正コメント > 一括反映 #run_id"
- タイトル: "修正一括反映 — run_2026_05_20_01"
- メタ情報行: triggered_at "2026-05-20 23:50" / 対象書籍 "3 冊" / コメント "12 件" / ステータス StatusBadge "running" / 経過時間 "03:21"

### Section 2: 全体進捗バー
- 大きなバー: "7 / 12 コメント処理済 (58%)"
- 右端: "ETA: 残り 2 分 30 秒"
- 下部に AgentLog ストリームの 3 行抜粋（最新ログ）

### Section 3: 書籍別進捗カード（縦並び 3 枚）
- 各カード:
  - 書籍タイトル + サムネ枠
  - 対象コメント "5 件" / 適用済み "3" / 適用不可 "0" / エラー "0" / 残り "2"
  - 現在処理中の種別アイコン: "📝 章 4 - 段落 3 処理中"
  - 進捗バー (60%)
  - 各種別ごとの内訳 (mini tile): chapter 3/4 ✓ / cover 0/1 / metadata 0/0

### Section 4: アクションバー（下部）
- `[ ジョブをキャンセル ]`（destructive） `[ 書籍詳細へ ]` `[ ホームへ戻る ]`
- 注記: "ブラウザを閉じても worker は実行を継続します。完了時にメール通知されます"
```

---

## done.png プロンプト（完了後の diff レビュー）

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り]

Main content area:

### Section 1: 実行ヘッダー
- タイトル: "修正一括反映 — run_2026_05_20_01"
- ステータス StatusBadge "done" / 経過時間 "08:42" / 対象書籍 "3 冊" / 適用済み "10 / 12" / 適用不可 "2"

### Section 2: 全体進捗バー (100%)
- "12 / 12 完了"

### Section 3: タブナビゲーション
- DiffReview / 再採点結果 / コスト記録

### Section 4: DiffReview タブ（中央メイン）
- 左サイドにコメントリスト (12 件、適用済み/不可で色分け、選択中ハイライト)
  - "✓ 適用済み 10"
  - "⚠ 適用不可 2"
- 右側コンテンツに選択中コメントの diff:
  - **章本文 diff (Markdown)**: 上下並列
    - 上ボックス: "元出力" 元 Markdown 3-5 行
    - 下ボックス: "修正後出力" 修正後 Markdown 3-5 行、追加行に "+" 削除行に "−"
  - 適用結果バッジ: "applied" or "not_applicable: AI が判断: 既に意図を反映済み"

### Section 5: コスト記録（折りたたみ）
- 見出し "この run のコスト"
- 表: 役割 (revision) / プロバイダ / モデル / トークン (in/out) / 金額
- 合計 "¥320"

### Section 6: アクションバー（下部）
- `[ 承認（applied に確定） ]`（プライマリ）
- `[ 追加コメント記入 ]`（→ S-013）
- `[ ロールバック ]`（適用失敗時のみ有効、destructive）
- `[ 書籍詳細へ ]`
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む、実行中バリエーション）:
1. 実行ヘッダー（タイトル + ステータス + 経過）
2. 全体進捗バー
3. 書籍別進捗カード（縦並び 3 枚）
4. AgentLog ストリーム（折りたたみ）
5. 画面下部固定アクションバー: `[ キャンセル ]` `[ 詳細 ]`
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- メイン領域に EmptyState:
  - イラスト枠 "no run"
  - メッセージ: "修正実行履歴がありません"
  - サブメッセージ: "通常は S-013 修正コメント一覧から実行ボタンを押すと自動でこの画面に遷移します"
  - CTA: `[ コメント一覧へ ]` (→ S-013)
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- 実行ヘッダー: ステータス StatusBadge "failed" 赤背景 / 経過 "05:12"
- 全体進捗バーの上に赤バナー: "run 全体が失敗しました: ネットワークタイムアウト" + `[ 全体リトライ ]`
- 書籍別進捗カード 3 枚のうち、2 枚に赤バッジ "適用失敗 1 件" + 失敗理由テキスト + `[ ロールバック ]`
- 個別コメント単位エラーは DiffReview で確認可能の旨明記
```

---

## 設計意図メモ（ChatGPT には渡さない）

- F-050 の中核画面。S-013 押下後に必ずこの画面に来る。実行中と完了後で表示要素が大きく変わるため画像を 2 種類用意。
- 全体進捗バー + 書籍別進捗カードの二重構造で「全体何 % / どの書籍が今動いている」を即時把握可能に。
- DiffViewer のレンダラ分けは UI 設計書 §8 申し送り 5 に従い、Markdown=上下、画像=左右、JSON=左右で統一。
- 「ブラウザを閉じても worker は実行継続」を明示し、運用者が安心して画面を閉じられる UX。
