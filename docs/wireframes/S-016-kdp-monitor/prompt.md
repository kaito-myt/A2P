# S-016 KDP 自動入稿モニター（Phase 3） — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-016
- 画面名: KDP 自動入稿モニター
- 対応機能 ID: F-041, F-042
- 元設計書: `docs/04-ui-design.md` §4 S-016
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー（2FA 待ち状態を含む）
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 進行中入稿なし
  - `error.png` — タイムアウトや失敗

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 共通プロンプト + 各バリアントを結合してコピー
3. ChatGPT に貼り付け → 画像生成
4. 出力 PNG を本ディレクトリに保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

This screen monitors Playwright-driven KDP submission. Key rules:
- 2FA 承認待ちパネルは画面最上部に最優先表示（黄色系強調、太枠）
- 進行中ジョブにはフェーズステッパー（ログイン → メタデータ入力 → ファイルアップロード → 価格設定 → 公開待ち）
- スクリーンショットはプレースホルダ枠 (160x100) で表現
- 失敗ジョブはスクショ + エラーメッセージ + `[ リトライ ]` `[ 手動入稿に切替 ]`

Style rules:
- Pure black-and-white, light gray for de-emphasis (2FA panel uses thicker border).
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 8–12 rows. No rounded corners or shadows. Japanese labels.

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "KDP 自動入稿"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 運用 > KDP 自動入稿"
- タイトル: "KDP 自動入稿モニター"
- 注記: "Phase 3 機能"

### Section 2: 2FA 承認待ちパネル（最上部、太枠で目立たせる）
- 大カード "🔐 2FA 承認待ち (1 件)"
- 対象書籍: "{副業 × AI ...}" のサムネ + タイトル
- 残りタイムアウト: 大きく "残り 07:23"（10 分カウントダウン）
- 入力欄: ラベル "2FA コード" + 6 桁入力 `_ _ _ _ _ _`
- ボタン: `[ コード送信 ]`（プライマリ）
- 注記: "10 分でタイムアウトすると入稿ジョブが失敗します"

### Section 3: 進行中入稿ジョブ一覧（中段）
- セクション見出し "進行中入稿 (3 件)"
- 各ジョブカード:
  - 書籍タイトル + サムネ枠 + アカウント
  - フェーズステッパー: ログイン ✓ → メタデータ ✓ → ファイル ●(進行中) → 価格 → 公開待ち
  - 経過時間 "04:12" / 推定残り "08:00"
  - スクリーンショット枠 (160x100, プレースホルダ)
  - アクション: `[ ジョブ詳細 ]` `[ 中止 ]`
- 3 枚表示

### Section 4: 失敗ジョブセクション
- セクション見出し "失敗 (2 件)"
- 各カード:
  - 書籍タイトル + サムネ
  - 失敗フェーズ: "ファイルアップロード"
  - エラーメッセージ: "ファイルサイズ上限超過"
  - スクショ枠 + `[ スクショを開く ]`
  - アクション: `[ リトライ ]` `[ 手動入稿に切替 ]`（→ S-015）
- 2 枚表示

### Section 5: 完了履歴 + ASIN 取り込み状況
- セクション見出し "完了履歴 (今月 12 冊)"
- テーブル: 完了時刻 / 書籍タイトル / ASIN (空 or 取得済) / ASIN 取得日 / 状態
- 8 行表示、うち 2 件は ASIN 取り込み中（明日取得予定）
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. 2FA 承認待ちパネル（最上部、巨大、見落とさない大きさ）
   - 書籍 + タイマー + 6 桁入力 + `[コード送信]`
2. 進行中入稿ジョブ（3 枚カード）
3. 失敗ジョブ (2 枚)
4. 完了履歴 (5 行)
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- 2FA パネル: 非表示
- 進行中・失敗セクション: EmptyState
  - イラスト枠 "no submissions"
  - メッセージ: "進行中の自動入稿はありません"
  - サブメッセージ: "KDP 入稿チェックリストから自動入稿を開始してください"
  - CTA: `[ 入稿チェックリストへ ]` (→ S-015)
- 完了履歴は通常表示（過去 12 冊）
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- 2FA パネル: タイムアウト表示
  - 赤背景バナー: "⏰ 2FA タイムアウト (10 分超過)"
  - "{書籍タイトル} の自動入稿が失敗しました"
  - `[ リトライ ]` `[ 手動入稿に切替 ]`
- 進行中セクションは 1 件減少
- 失敗ジョブセクションが拡大、上記書籍が追加
```

---

## 設計意図メモ（ChatGPT には渡さない）

- Phase 3 機能だが先行設計。2FA 承認待ちパネルを最上部に置くことで「即対応が必要」を視覚化。
- スクリーンショット枠を各ジョブに配置することで、Playwright 実行が視覚的に追跡可能（業務要件 §6 KDP 操作の証跡）。
- 失敗時の `[ 手動入稿に切替 ]` で S-015 に戻れる導線を確保し、自動失敗 → 手動継続のフォールバックを担保。
