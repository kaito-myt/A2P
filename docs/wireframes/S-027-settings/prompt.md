# S-027 設定（通知・アラート閾値） — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-027
- 画面名: 設定（通知・アラート閾値）
- 対応機能 ID: F-030, F-034, F-036, F-038
- 元設計書: `docs/04-ui-design.md` §4 S-027
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `error.png` — バリデーションエラー（メール形式等）

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
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns. トグルは `[ON ●]` `[OFF ○]` で表現
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

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "設定"]

Main content area (左 25% セクションナビ、右 75% フォーム):

### Section 1: ページヘッダー（全幅）
- パンくず: "ホーム > 運用 > 設定"
- タイトル: "設定"
- 右側: `[ 保存 ]`（プライマリ、フローティング下部にも複製）

### Section 2: セクションナビ（左カラム、縦リスト）
- 通知設定
- アラート閾値
- プロンプト自動承認
- 売上自動取得
- KDP 自動入稿
- データ管理

### Section 3: 通知設定（右カラム上）
- 見出し "通知設定"
- 通知先メールアドレス: 入力欄 `____________________`
- 通知種別チェック（縦並びトグル）:
  - コスト超過: `[ON ●]`
  - プロンプト改訂: `[ON ●]`
  - ジョブ失敗: `[ON ●]`
  - KDP 2FA 要求: `[ON ●]`
  - 単価変動 ±10%: `[ON ●]`

### Section 4: アラート閾値（右カラム）
- 見出し "アラート閾値"
- 1 冊あたり超過閾値: `[¥500 ]` (デフォルト 500)
- 1 冊あたり停止閾値: `[¥750 ]` (デフォルト 750)
- 月次 80% 閾値: `[¥40,000 ]`
- 月次 95% 閾値: `[¥47,500 ]`
- 月次 100% 閾値: `[¥50,000 ]`
- 単価変動率: `[10 %]`

### Section 5: プロンプト自動承認（右カラム）
- 見出し "プロンプト自動承認 (F-030)"
- モード: `( ● ) 手動  ( ) 自動`
- 自動時条件: "直近 5 冊で Quality 改善" (注記)
- ロールバック猶予: `[24 時間]`

### Section 6: 売上自動取得（右カラム、Phase 2 以降）
- 見出し "売上 Amazon 自動取得 (Phase 2)"
- ON/OFF: `[OFF ○]`
- 実行時刻: `[06:00 ▾]`

### Section 7: KDP 自動入稿（右カラム、Phase 3）
- 見出し "KDP 自動入稿 (Phase 3)"
- 2FA タイムアウト: `[10 分]`
- リトライ回数: `[3 回]`

### Section 8: データ管理（右カラム下）
- 見出し "データ管理"
- ジョブログ保管期間: `[90 日]`
- R2 アーカイブ閾値: `[180 日]`
- `[ 古いログを今すぐアーカイブ ]`
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー + `[保存]` 右上
2. セクションナビ（横スクロールチップ）
3. 通知設定（折りたたみ展開）
4. アラート閾値
5. プロンプト自動承認
6. 売上自動取得
7. KDP 自動入稿
8. データ管理
9. 画面下部固定: `[ 保存 ]`
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- 通知設定セクションのメール入力欄に赤枠 + 下にエラーメッセージ: "✗ メールアドレス形式が正しくありません (例: name@example.com)"
- アラート閾値の 1 冊あたり停止閾値が「超過閾値より小さい」場合、赤バナー: "✗ 停止閾値は超過閾値以上である必要があります"
- `[ 保存 ]` ボタン disabled
- ページ上部に薄い赤バナー: "1 件のバリデーションエラー"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- 全 6 セクションを 1 画面に集約。左セクションナビでセクション間移動を効率化。
- Phase 2/3 機能には括弧で注記し、未提供と現用設定を区別。
- 全閾値項目に既定値を表示しておくことで、運用者が「現在の挙動」を即時把握可能。
