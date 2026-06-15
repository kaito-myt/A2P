# S-011 アウトライン承認（バルク） — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-011
- 画面名: アウトライン承認（バルク）
- 対応機能 ID: F-003, F-018, F-049
- 元設計書: `docs/04-ui-design.md` §4 S-011
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（バルク選択中）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 承認待ちなし
  - `error.png` — 個別差戻し失敗

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This is a BULK OPERATION + COMMENT-CENTRIC screen:
- 各アウトラインカード左上にチェックボックス
- ヘッダー領域に「全選択」チェックボックス
- 画面下部に BulkActionBar 固定: "N 件選択中 / [一括承認] [一括差戻し（コメント必須）] [アウトライン編集] [選択解除]"
- 件数バッジを目立たせる
- 各章リスト行に `[+]` CommentAffordance、既存コメントは優先度バッジ (must=赤 / should=黄 / may=青)

Style rules:
- Pure black-and-white, light gray for de-emphasis.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Cards 6–8 枚 grid. No rounded corners or shadows. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "アウトライン承認"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 出版パイプライン > アウトライン承認"
- タイトル: "アウトライン承認"
- 右側: "承認待ち 5 件 / 差戻し 1 件"

### Section 2: フィルタバー
- 横並び: `[バッチ ID ▾]` `[アカウント ▾]` `[ステータス: pending ▾]` 検索ボックス
- 右端に「全選択」チェックボックス + "5 件全選択"

### Section 3: アウトラインカードグリッド（3 列 x 2 行）
- 各カード:
  - 左上にチェックボックス + 書籍タイトル（2 行截断）
  - サブ情報: アカウント / ジャンル / 想定読者
  - 中央に章リスト (7 章):
    - "第 1 章: 〇〇 (3,200 字)" + 行末 `[+]`
    - "第 2 章: △△ (4,100 字)" + 行末 `[+]` + バッジ "must 1"
    - ... 7 行
  - 下部に "総文字数: 24,500 / 平均章数: 7 / コメント 3 (must:1)"
  - カード末尾アクション: `[ 承認 ]` `[ 差戻し ]` `[ 編集 ]`
- 6 枚表示、うち 3 枚チェック ON

### Section 4: BulkActionBar（画面下部固定）
- 左: "3 件選択中" バッジ
- 右: `[ 一括承認 ]`（プライマリ）`[ 一括差戻し（コメント必須） ]`（destructive）`[ アウトライン編集 ]` `[ 選択解除 ]`
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー（タイトル + フィルタ `[⋯]`）
2. フィルタチップ群
3. アウトラインカード（1 列、4 枚積む）
   - 各カード: チェックボックス + タイトル + 章リスト圧縮表示 (3 章 + "他 4 章")
4. 画面下部に BulkActionBar:
   - "3 件選択中" / `[承認]` `[差戻し]`
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタはそのまま
- カードグリッド領域に EmptyState:
  - イラスト枠 "no pending"
  - メッセージ: "アウトライン承認待ちはありません"
  - サブメッセージ: "新規プロジェクトを作成すると Marketer 完了後にここに並びます"
  - CTA: `[ 新規プロジェクトへ ]`（→ S-008）
- BulkActionBar は非表示
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- カードグリッドの 2 枚目と 4 枚目に赤バッジ "差戻し失敗"
- 該当カード末尾に `[ リトライ ]` ボタン
- 上部に "2 件の差戻しに失敗しました" 赤バナー + `[ まとめてリトライ ]`
- 他カードは通常表示
```

---

## 設計意図メモ（ChatGPT には渡さない）

- F-018 受け入れ基準「N 冊横並びで承認 / 差戻し」を満たすため、3 列グリッドで横並び性を視覚化。
- 各章単位で `[+]` コメントアフォーダンスを置き、章リスト粒度でフィードバックを残せる UX。
- 「差戻し（コメント必須）」を明示することで、F-018 の Writer 再実行プロンプトへのコメント連動を理解させる。
- 6 枚同時表示で「夜セット 5 冊を 30 秒で確認 → 承認」の運用シナリオを成立させる。
