# Phase 1 実走計測レポート — 1 冊実 LLM 完走 (SP-09 T-09-08)

> ## ⚠️ 本レポートは「人間の実行」が必要です (未完)
>
> 本タスクは **本番 Railway 環境** で **実 LLM (実課金) により 1 冊を完走**させ、
> その実測値を記録するものです。以下は自動実行できないため、運営者の手動実行を要します:
>
> 1. 本番 Railway へのデプロイ（[`runbook.md` §1](./runbook.md)）と実 API キー登録（実費発生）
> 2. UI からテーマ投入 → 承認 → パイプライン完走（Marketer→Writer→Editor→Thumbnail→出力）
> 3. 完走後に計測ハーネスを実行して数値を本レポートへ転記
>
> 計測ハーネス・方法論・記入テンプレートは整備済み（↓）。**数値欄が `TBD` の間は本タスク未完**。
> Phase 1 完了判定 (T-09-10) はこのレポートの確定値（特に月次 100 冊試算）に依存します。

---

## 1. 計測方法

実走そのものは UI で人間が起動する。完走後、コスト/時間は **`token_usage` と `jobs`**
(CLAUDE.md Hard Rule 5: 全 LLM/画像呼び出しが `token_usage` に記録される) を正典として集計する。

計測ハーネスを用意済み: [`scripts/measure-real-run.ts`](../../scripts/measure-real-run.ts)

```bash
# 本番 DATABASE_URL を指定し、完走した書籍の id を渡す
DATABASE_URL=<prod> pnpm tsx scripts/measure-real-run.ts <book_id>
```

出力された Markdown を本レポート §3 に貼り付ける。ハーネスは以下を算出する:

- 総リードタイム (`Book.created_at` → `Book.done_at`)
- フェーズ別ジョブ時間 (`Job.created_at`→`started_at`=待機、`started_at`→`finished_at`=実行)
- 役割別コスト (`token_usage` を role×provider×model で groupBy)
- PDF / 成果物生成時間 (export/pdf/render 系 kind の実行時間)
- 月次 100 冊試算 (1 冊実コスト × 100 が ¥50,000 以内か)

---

## 2. 実走条件 (記入)

| 項目 | 値 |
|---|---|
| 実走日時 | TBD |
| アカウント / ジャンル | TBD |
| テーマ | TBD |
| 章数 / 目標文字数 | TBD |
| モデル割当 (Writer/Editor/Marketer/Thumbnail) | TBD |
| プロンプト版 | TBD |
| 環境 | Railway (Web + Worker + Postgres) / R2 |

---

## 3. 計測結果 (ハーネス出力を貼付)

> `pnpm tsx scripts/measure-real-run.ts <book_id>` の出力をそのまま貼る。

```
TBD — ハーネス出力を貼付
```

### サマリ転記

| 指標 | 実測 | 目標 (R-01/R-02) | 判定 |
|---|---|---|---|
| 総リードタイム (queue→done) | TBD | — | TBD |
| 総コスト / 冊 | TBD | ≤ ¥500 (1 冊閾値) | TBD |
| PDF 生成時間 | TBD | 数十秒オーダー (OQ-01) | TBD |
| 出力成果物 (docx/pdf/png) | TBD | 3 種揃う | TBD |

---

## 4. OQ-01 最終判断 — PDF 生成性能 (`@react-pdf/renderer`)

> docs/05 OQ-01: `@react-pdf/renderer` の生成時間が許容範囲か。許容外なら Puppeteer
> フォールバックを検討。

- 実測 PDF 生成時間: **TBD**
- 判断: **TBD** （許容内なら現状維持 / 許容外なら Puppeteer フォールバックを Phase 2 課題化）
- 根拠: TBD

---

## 5. 月次 100 冊コスト試算 (R-01)

| 項目 | 値 |
|---|---|
| 1 冊あたり実コスト | TBD |
| × 100 冊 / 月 | TBD |
| 月額予算 ¥50,000 以内か | TBD |
| 超過時の打ち手 | プロンプト最適化 (Phase 2 Optimizer) / モデルを Writer=Sonnet 化 / 章数調整 |

---

## 6. 所見・申し送り (記入)

- リードタイムのボトルネックフェーズ: TBD
- コストのボトルネック役割: TBD
- 品質メモ (Phase 2 Quality Judge 導入前の主観評価): TBD
- Phase 2 への課題: TBD
