# S-029 監査ログ — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-029
- 画面名: 監査ログ
- 対応機能 ID: F-029, F-030, F-046
- 元設計書: `docs/04-ui-design.md` §4 S-029
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `empty.png` — 監査ログなし
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

Style rules:
- Pure black-and-white, light gray for de-emphasis.
- Rectangular blocks, Japanese section headings.
- `[ボタン名 ]` for buttons. `_______` for inputs. `[ラベル ▾]` for dropdowns.
- Tables 10–15 rows. No rounded corners or shadows. Japanese labels.
- JSON diff は左右並列の枠表現 (旧 JSON / 新 JSON)

Persistent UI:
- Header (64px): "A2P" + グローバル検索 + CostMeter "3.2万/5万" + AlertBadge "3" + CommentBadge "12 (must:4)" + 設定 + ユーザーメニュー
- Sidebar (240px): ホーム / 出版パイプライン（テーマ候補 / 新規プロジェクト・バッチ計画 / アウトライン承認 / サムネ承認 / KDP 入稿） / 書籍（書籍ライブラリ / 修正コメント） / 分析（売上・KPI / コスト詳細） / モデル & プロンプト（モデル割当 / モデルカタログ / A/B 比較 / プロンプト管理 / 改訂承認） / 運用（ジョブログ / アラート / KDP 自動入稿 / 監査ログ / アカウント管理 / 設定）
- Sidebar 下部: JobTicker "実行中 3 / 上限 5"
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

[Header / Sidebar は共通プロンプトの通り。アクティブナビは "監査ログ"]

Main content area:

### Section 1: ページヘッダー
- パンくず: "ホーム > 運用 > 監査ログ"
- タイトル: "監査ログ"
- 注記: "読み取り専用 / 直近 1 年分を表示"
- 右側: `[ CSV エクスポート ]`

### Section 2: フィルタバー
- 横並び: `[アクター ▾]` (operator / system / optimizer) `[アクション種別 ▾]` (prompt_approve / prompt_auto_approve / job_cancel / model_switch / settings_update / job_retry) `[対象エンティティ ▾]` `[期間 ▾]` 検索

### Section 3: ログテーブル（メイン）
- ヘッダー: 時刻 | アクター | アクション | 対象 | before → after 要約 | 展開
- 12 行表示
- 行例:
  - 2026-05-20 23:45 | operator | prompt_approve | prompts/v13 (Writer × ビジネス書) | "v12 → v13 activate" | `[▶ 展開]`
  - 2026-05-20 22:30 | optimizer | prompt_auto_approve | prompts/v13 (Editor) | "v5 → v6 (条件: 直近 5 冊 Quality 改善 3/5)" | `[▶ 展開]`
  - 2026-05-20 21:15 | operator | model_switch | model_assignments | "Writer × ビジネス書: Opus 4.7 → Sonnet 4.6" | `[▶ 展開]`
  - 2026-05-20 20:00 | operator | job_retry | jobs/job_2026... | "リトライ 1 回目" | `[▶ 展開]`
  - 2026-05-20 19:45 | operator | settings_update | settings | "1 冊停止閾値: ¥700 → ¥750" | `[▶ 展開]`
  - 2026-05-20 18:30 | operator | job_cancel | jobs/job_2026... | "ステータス: running → cancelled" | `[▶ 展開]`
  - ... 計 12 行

### Section 4: 行展開時の JSON diff（2 行目を展開状態で例示）
- 左右並列カード:
  - 左: "before_json" — JSON ツリー 8 行
  - 右: "after_json" — JSON ツリー 8 行、差分行に "+" "−"
- メタ: 展開時刻 + アクター詳細

### Section 5: ページネーション
- "1 - 12 / 542 件" + ページ遷移
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels, single column.

Header / Sidebar: ハンバーガー化

Main content（縦に積む）:
1. ページヘッダー + `[CSV]`
2. フィルタチップ
3. ログカード（テーブルからカード化、8 枚）
   - 各カード: 時刻 + アクター + アクション + 対象 + 要約 + `[▶ 詳細]`
4. 展開時は JSON diff（縦並び: 上=before、下=after）
```

---

## empty.png プロンプト

```
Layout: same as desktop.png

Difference:
- ヘッダー / フィルタはそのまま
- テーブル領域に EmptyState:
  - イラスト枠 "no audit"
  - メッセージ: "監査ログがありません"
  - サブメッセージ: "プロンプト承認 / モデル切替 / ジョブ中止等が行われるとここに記録されます"
  - CTA なし（純粋なリードオンリー画面のため）
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- テーブル領域に ErrorBoundary:
  - 中央メッセージ: "監査ログの取得に失敗しました"
  - `[ 再読み込み ]` ボタン
- 上部に薄いバナー: "ログ取得失敗"
```

---

## 設計意図メモ（ChatGPT には渡さない）

- F-029 / F-030 / F-046 の操作監査要件を 1 画面に集約。
- before/after の JSON diff を展開表示することで、変更内容を完全に追跡可能（特に Phase 2 自動承認の透明性確保）。
- 読み取り専用画面なので CTA を持たないことを明示（empty バリアントでも CTA なし）。
