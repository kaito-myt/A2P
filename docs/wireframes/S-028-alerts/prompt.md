# S-028 アラート一覧 — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-028
- 画面名: アラート一覧
- 対応機能 ID: F-024, F-034, F-036, F-016
- 元設計書: `docs/04-ui-design.md` §4 S-028
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（バルク選択中）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — アラートなし
  - `error.png` — 取得失敗

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This is a BULK OPERATION screen:
- 各行先頭にチェックボックス、ヘッダーに全選択
- 画面下部に BulkActionBar 固定: "N 件選択中 / [選択を既読] [選択を resolved] [選択解除]"
- 件数バッジを目立たせる
- 重要度バッジは "critical (赤)" / "warning (黄)" / "info (灰)"

Style rules:
- Pure black-and-white, light gray for de-emphasis.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
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

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "アラート"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 運用 > アラート"
- タイトル: "アラート一覧"

### Section 2: 種別別件数カウント（横並び 5 枚、上部）
- 1 冊コスト超過 (F-034): 4 件
- 月次予算到達 (F-036): 1 件
- 単価変動 ±10% (F-024): 2 件
- ジョブ失敗 3 連続: 1 件
- KDP 2FA タイムアウト: 0 件

### Section 3: フィルタバー
- 横並び: `[種別 ▾]` `[重要度 ▾]` `[期間 ▾]` `[unresolved/resolved ▾]` 検索

### Section 4: アラートテーブル
- ヘッダー: チェックボックス | 発生時刻 | 種別アイコン | 重要度 | メッセージ | 関連リンク | ステータス
- 12 行表示、3 行目までチェック ON
- 行例:
  - 2026-05-20 23:45 | 💰 | critical (赤) | "{書籍タイトル} 1 冊コスト ¥520（500 円超過）" | `[ S-024 ]` | unresolved
  - 2026-05-20 23:30 | 📈 | warning (黄) | "Anthropic Claude Opus 4.7 単価 +12% 変動" | `[ S-020 ]` | unresolved
  - 2026-05-20 22:15 | ⚙ | critical (赤) | "Writer job 3 連続失敗" | `[ S-026 ]` | unresolved
  - 2026-05-20 21:00 | 💰 | warning (黄) | "月次コスト 80% 到達 (¥40,200)" | `[ S-024 ]` | unresolved
  - ... 計 12 行
- 行クリック → 関連画面 (種別ごとに S-024 / S-026 / S-020 等)

### Section 5: BulkActionBar（画面下部固定）
- 左: "3 件選択中" バッジ
- 右: `[ 選択を既読 ]` `[ 選択を resolved ]`（プライマリ）`[ 選択解除 ]`
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー
2. 種別別件数カウント (2 列 x 3 行)
3. フィルタチップ
4. アラートカード（テーブルからカード化、8 枚）
   - 各カード: チェック + 種別アイコン + 重要度 + メッセージ + 関連リンク
5. 画面下部に BulkActionBar:
   - "3 件選択中" / `[既読]` `[resolved]`
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタはそのまま
- 種別別件数カウント: 全て "0"
- テーブル領域に EmptyState:
  - イラスト枠 "all clear"
  - メッセージ: "アラートはありません"
  - サブメッセージ: "コスト超過 / 単価変動 / ジョブ連続失敗 等がここに表示されます"
  - CTA: `[ ホームへ ]`
- BulkActionBar 非表示
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- テーブル領域に ErrorBoundary:
  - 中央メッセージ: "アラートの取得に失敗しました"
  - `[ 再読み込み ]` ボタン
- 種別別件数カウントは前回キャッシュで表示
- 画面右下にトースト: "通信エラー"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- F-034 / F-036 / F-024 / F-016 連続失敗の 4 種アラート源を 1 画面で横断確認。
- 種別アイコン + 重要度バッジ + メッセージで「色 + アイコン + テキスト」三重表現（§6.4 アクセシビリティ）。
- 関連リンク列により、アラート → 原因画面 (S-024 / S-026 / S-020) への遷移を 1 クリックで実現 (UC-04)。
