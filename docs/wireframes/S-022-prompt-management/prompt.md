# S-022 プロンプト管理（テンプレ一覧・履歴） — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-022
- 画面名: プロンプト管理（テンプレ一覧・履歴）
- 対応機能 ID: F-027, F-028, F-031
- 元設計書: `docs/04-ui-design.md` §4 S-022
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（プロンプト選択中）
  - `mobile.png` — モバイル 1 カラム
  - `error.png` — active バージョン不整合警告

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
- Tables 8–12 rows. プロンプト本文は等幅フォント枠で表現 (背景薄グレー)。No rounded corners or shadows. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "プロンプト管理"]

Main content area (2 カラム: 左 35% プロンプト一覧、右 65% 選択中プロンプト詳細):

### Section 1: ページヘッダー（全幅）
- パンくず: "ホーム > モデル & プロンプト > プロンプト管理"
- タイトル: "プロンプト管理"
- 右側: `[ + 新規プロンプト作成 ]`（プライマリ）

### Section 2: プロンプト一覧テーブル（左カラム）
- 列: 役割 / ジャンル / active バージョン / 最終更新 / 作成者 / A/B
- 10 行表示
- 行例:
  - Writer | ビジネス書 | v12 | 2026-05-18 | optimizer | A/B 配信中 (バッジ)
  - Writer | 実用書 | v8 | 2026-05-10 | human | —
  - Editor | デフォルト | v5 | 2026-04-22 | human | —
  - Marketer | デフォルト | v3 | 2026-04-01 | human | —
  - Judge | デフォルト | v6 | 2026-05-05 | optimizer | —
  - ... 10 行
- 選択行ハイライト (Writer × ビジネス書 v12 選択中)

### Section 3: プロンプト詳細パネル（右カラム）
- 上部ヘッダー: "Writer × ビジネス書 — active: v12"
- タブ: 現行本文 / 過去バージョン / A/B 配信設定
- タブ 1 (現行本文):
  - プロンプト本文エディタ (Markdown、等幅、12-15 行表示)
  - プレースホルダ一覧パネル (折りたたみ可): `{theme_title}` `{target_reader}` `{genre}` ...
  - 下部アクション: `[ 編集 ]` `[ 保存 (新バージョン) ]`

### Section 4: バージョン履歴タイムライン（右カラム下、タブ 2 のとき表示）
- 縦タイムライン（最新が上）:
  - v12 — 2026-05-18 — optimizer | Quality 平均 +2.3 | `[ active ]` `[ 戻す ]`
  - v11 — 2026-05-10 — human | Quality 平均 76.0 | `[ 戻す ]`
  - v10 — 2026-04-28 — optimizer | Quality 平均 73.8 | `[ 戻す ]`
  - ... 7 件

### Section 5: A/B 配信設定（タブ 3）
- 旧版 ID: `[v11 ▾]` 新版 ID: `[v12 ▾]`
- 配信比率スライダー: 50:50
- 配信中対象: 「次の N 冊 (Phase 2)」または「ジャンル × 役割で固定 (Phase 1)」
- `[ A/B 統計結果へ ]` (→ S-021)
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー + `[+]` 右上
2. プロンプト一覧（カード形式、5 枚）
3. 選択中プロンプト詳細（折りたたみセクション）
   - タブ切替 (現行本文 / 過去バージョン / A/B)
   - プロンプト本文エディタ（小型）
   - バージョン履歴 (5 件)
4. 画面下部固定: `[ 編集 ]` `[ 保存 ]`
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- ページ上部に赤バナー: "⚠ 同一役割×ジャンルに active が 2 つ存在します: Writer × ビジネス書 (v11, v12)"
- 該当行が赤背景でハイライト
- `[ 不整合を解消 ]` ボタン (修正ウィザード起動)
- 他要素は通常表示
```

---

## 設計意図メモ（ChatGPT には渡さない）

- F-027 動的プロンプトテンプレと F-028 バージョン履歴を 1 画面で。タイムライン表現で「過去バージョンを戻せる」UX を強調。
- A/B 配信設定 (F-031) はタブの 1 つに格納し、Phase 2 までは目立たせすぎない。
- プレースホルダ一覧を併設することで、編集時の入力ミス防止 + 補完候補表示を視覚化。
