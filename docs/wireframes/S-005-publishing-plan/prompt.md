# S-005 長期出版プラン — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-005
- 画面名: 長期出版プラン
- 対応機能 ID: F-002
- 元設計書: `docs/04-ui-design.md` §4 S-005
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — プラン未生成

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントプロンプトを結合してコピー
3. ChatGPT に貼り付けて画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

Style rules:
- Pure black-and-white, light gray for de-emphasis only.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 8–12 rows. Lists 5–10 items. No rounded corners or shadows.
- Realistic information density. All labels in Japanese.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > アカウント管理 > {ペンネーム} > 長期出版プラン"
- タイトル: "長期出版プラン — {ペンネーム}"
- 右側アクション:
  - 期間セレクタ `[3 ヶ月 ▾]` （選択肢: 3/6/12）
  - `[ プラン再生成 ]`（プライマリ）

### Section 2: 月別カレンダー（横並びカード列）
- 配置: ヘッダー直下
- 各月セルカード（横並び、6 セル分表示）:
  - 月ラベル "2026-06"
  - 予定冊数: "10 冊"
  - テーマカテゴリ: チップ "副業" "AI 活用" "時間術"
  - シリーズ名候補: 2-3 件
  - セル下部に CTA `[ テーマ候補を生成 ]`（小さく）

### Section 3: シリーズ系統図（mermaid 風）
- 配置: カレンダーの下
- セクション見出し "シリーズ系統"
- 既存シリーズ → 続編候補をボックス + 矢印で表現
  - 例: "副業の基礎" → "副業の応用" → "副業 × AI"
  - 既存はソリッド枠、候補は破線枠
- 5-7 ノード程度

### Section 4: プラン生成設定（折りたたみ）
- セクション見出し "プラン生成パラメータ" + 展開トグル
- 中身: 月あたり上限冊数、注力カテゴリ、シリーズ展開ポリシー（テキストエリア）
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー（タイトル + 期間セレクタ + `[再生成]`）
2. 月別カレンダー: カードを縦に積む（6 枚）
3. シリーズ系統図（縦長 mermaid）
4. プラン生成パラメータ（折りたたみ閉じた状態）
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ページヘッダーはそのまま
- カレンダー領域、シリーズ系統領域は EmptyState で置換:
  - イラスト枠 "no plan yet"
  - メッセージ: "長期出版プランがまだ生成されていません"
  - サブメッセージ: "アカウントのジャンル方針とターゲット読者を基にプランを生成します"
  - CTA: `[ プランを生成 ]`（プライマリ、中央）
```

---

## 設計意図メモ（ChatGPT には渡さない）

- マーケター（F-002）の長期視点を 1 画面で俯瞰させる目的。月別カレンダー + シリーズ系統で「縦軸 = 時間」「横軸 = シリーズ展開」を表現。
- 各月セルから直接 F-001 テーマ候補生成にキックできるショートカット（業務要件「夜セット計画を加速」）。
- Phase 1 では P1 機能なので生成頻度は低い想定だが、再生成ボタンは目立たせ運用者が気軽に試せる UX を担保。
