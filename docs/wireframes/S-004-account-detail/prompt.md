# S-004 アカウント詳細・編集 — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-004
- 画面名: アカウント詳細・編集
- 対応機能 ID: F-002, F-044
- 元設計書: `docs/04-ui-design.md` §4 S-004
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 新規モード（KDP 認証情報未入力注記）
  - `error.png` — 認証情報暗号化失敗時

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 下記「共通プロンプト」と任意の「{バリアント} プロンプト」を結合してコピー
3. ChatGPT に貼り付けて画像生成
4. 出力 PNG を本ディレクトリに上記ファイル名で保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

Output as a single wireframe image with these rules:
- Pure black-and-white, light gray for de-emphasis only.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 8–12 rows. Lists 5–10 items. No rounded corners or shadows.
- Realistic information density. Japanese labels.

Persistent UI:
- Header (64px): "A2P" ロゴ + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "アカウント管理"]

Main content area (2 カラム: 左 65% フォーム、右 35% サマリ):

### Section 1: ページヘッダー（全幅）
- パンくず: "ホーム > アカウント管理 > {ペンネーム}"
- タイトル: "アカウント詳細・編集"
- 右側アクション: `[ キャンセル ]` `[ 保存 ]`（プライマリ）

### Section 2: 基本情報（左カラム上）
- セクション見出し "基本情報"
- ペンネーム: 入力欄
- 表示名: 入力欄
- 自己紹介: テキストエリア（4 行）
- ターゲット読者像: テキストエリア（3 行）

### Section 3: ジャンル方針（左カラム中段）
- セクション見出し "ジャンル方針"
- 3 つのスライダー or 入力欄（合計 100%）:
  - 実用書: 40%
  - ビジネス書: 35%
  - 自己啓発: 25%
- 注力テーマ: タグ入力（例: "副業" "時間術" "AI 活用"）

### Section 4: KDP 認証情報（左カラム下、SecretField）
- セクション見出し "KDP 認証情報" + 注記 "AES-256 で暗号化保存"
- KDP メール: マスク表示 "******@example.com" + `[ 再入力 ]` ボタン
- KDP パスワード: マスク表示 "●●●●●●●●" + `[ 再入力 ]`
- 2FA バックアップコード: マスク "●●●●-●●●●" + `[ 再入力 ]`
- 注記: "Phase 3 自動入稿で利用します"

### Section 5: 長期出版プラン要約（右カラム上）
- セクション見出し "長期出版プラン"
- 直近 3 ヶ月のサマリカード（各月: 予定冊数 / シリーズ数）
- ボタン: `[ 詳細を表示 ]` (→ S-005) + `[ プランを再生成 ]`

### Section 6: アカウント別 KPI（右カラム下）
- セクション見出し "アカウント KPI"
- 縦に並ぶ KPI:
  - 累計出版数: 24 冊
  - 累計売上: ¥124,500
  - 平均 Quality: 76.8
  - 累計コスト: ¥18,200
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー（タイトル + `[保存]` 右上）
2. 基本情報フォーム
3. ジャンル方針
4. KDP 認証情報（SecretField）
5. 長期出版プラン要約 + `[ 詳細 ]` `[ 再生成 ]`
6. アカウント KPI
7. 下部に固定 `[ 保存 ]` バー
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference (新規モード):
- ページタイトル: "新規アカウント追加"
- 全フォーム欄は空欄状態
- KDP 認証情報セクションには黄色系の注記バナー: "Phase 3 自動入稿で必要になります。後から登録可能です"
- 右カラムの "長期出版プラン" "アカウント KPI" セクションは EmptyState 表示:
  - "保存後にプラン生成が可能になります"
- `[ 保存 ]` ボタンはプライマリ表示
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- ページタイトル下に赤い destructive バナー: "KDP 認証情報の暗号化に失敗しました。再入力してください"
- KDP 認証情報セクションの各入力欄に赤い細枠
- `[ 保存 ]` ボタンは disabled（薄グレー）
- 右下にトースト: "保存できませんでした"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- 認証情報セクションは SecretField コンポーネントの典型例。常時マスクし「再入力」モードのみで変更可能。
- 右カラムにプラン要約 + KPI を置き、フォーム入力中も「このアカウントが今どういう状態か」が視界に入る設計。
- 新規モード（empty）では「Phase 3 で必要」と注記し心理的負担を下げる（業務要件 §3 段階導入方針）。
