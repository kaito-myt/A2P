# 06 — 組織エージェント設計（全社版 — CEO → 本部マネージャー → 担当者 ＋ 全社ToDoバックログ）

> 位置づけ: **ランタイム組織（AI企業）** の設計。既存のランタイムエージェント（Marketer/Writer/
> Editor/Thumbnail/Quality Judge…）を「担当者（手足）」として使い、その上に **経営（CEO）→
> 各本部（部長/マネージャー）→ 担当者** の階層を載せ、**KDP出版事業を丸ごと自律運転**する。
> 開発時の Claude Code サブエージェント（`.claude/agents`）とは別物。本ドキュメントでは
> これらを **Org エージェント** と呼ぶ。
>
> ステータス: **設計合意フェーズ（未実装）**。この文書で合意 → Phase 1 から実装に入る。
>
> 履歴: v1 は「販促のみの組織」。v2（本書）で **本の作成・出版・データ分析・販促・システム運用・
> 予算管理までを含む全社組織**へ拡張。

---

## 1. 目的とスコープ

「人が逐一指示しなくても、**一つの出版社（AI企業）のように**、企画→制作→出版→販促→分析→改善を
自律的に回し、コストと予算を管理しながら **KDP事業全体を運転する** ランタイムを作る。

**回す業務領域（＝本部）**

1. **本の作成（制作）** — テーマ企画・執筆・編集・表紙・品質判定
2. **出版** — KDPメタデータ整備・価格/カテゴリ/キーワード・入稿・公開
3. **データ分析** — 売上・市場/競合・KPI分析、次の企画への還元
4. **販促** — SNS/note/ブログの計画・作成・投稿・効果検証（v1で設計済みの部分を本部化）
5. **システム運用** — パイプライン監視・スタック復旧・エラートリアージ・ジョブ健全性
6. **予算管理** — 全社/本部/書籍別のコスト把握・予算配分・上限ガード

**貫く原則**

- **全社ToDoバックログ（`org_tasks`）が唯一の協働面**。全エージェントは「起票／担当／実行／完了／検証」するだけ。
- **すべての LLM/画像コストを `token_usage` にタスクID付きで記録** → タスク別/書籍別/本部別/方針別に集計。
- **既存資産を最大限再利用**（パイプライン各タスク・promotion系・SalesRecord・token_usage・bakeoff）。Org 層は「戦略・分解・検証・コスト統治・可視化」を足す。
- **人手が必要なもの（アカウント作成・KDP最終公開の承認など）は `needs_human` タスクとして明示**し、それ以外は自律。

---

## 2. 組織図（全体像）

```text
                          ┌───────────────────────────────────┐
                          │  CEO (社長エージェント)              │
                          │  全社状況(在庫本/売上/コスト/市場)を  │
                          │  俯瞰 → 方針(Objective)＋予算配分     │
                          │  を決め、各本部長へ委任               │
                          └───┬───────┬───────┬───────┬────────┘
        ┌─────────────────────┘       │       │       └───────────────────────┐
        │                 ┌───────────┘       └───────────┐                   │
        ▼                 ▼                               ▼                   ▼
┌───────────────┐ ┌───────────────┐             ┌───────────────┐   ┌───────────────┐
│ 制作本部長      │ │ 出版本部長      │             │ 分析本部長      │   │ 販促本部長      │
│(editorial_mgr) │ │(publish_mgr)   │             │(analytics_mgr) │   │(promo_mgr)     │
├───────────────┤ ├───────────────┤             ├───────────────┤   ├───────────────┤
│ 企画/執筆/編集/  │ │ メタデータ整備/  │           │ 売上/市場/KPI  │   │ 作成/投稿/検証  │
│ 表紙/品質(既存   │ │ 価格/入稿/公開   │           │ 分析→企画還元   │   │ (v1で設計済)    │
│ パイプライン)    │ │                 │           │                 │   │                 │
└──────┬────────┘ └──────┬────────┘             └──────┬────────┘   └──────┬────────┘
       │ 担当者          │ 担当者                       │ 担当者              │ 担当者
  marketer/writer/   metadata_worker/            sales_analyst/       content_creator/
  editor/thumbnail/  publish_worker              market_analyst       publisher_worker/
  quality_judge                                                       promo_analyst

        ┌───────────────┐             ┌───────────────┐
        │ 運用本部長      │             │ 経営管理(CFO)   │
        │(ops_mgr)       │             │(finance_mgr)   │
        ├───────────────┤             ├───────────────┤
        │ 監視/復旧/      │             │ 予算配分/コスト │
        │ トリアージ      │             │ 集計/上限ガード │
        └──────┬────────┘             └──────┬────────┘
          ops_worker                    cost_accountant

        ↕ すべて「全社ToDoバックログ(org_tasks)」を介して協働
        ↕ すべての LLM/画像呼び出しコストを token_usage にタスクID付きで記録
```

**中心は全社ToDoバックログ**。CEO が方針と予算を決め、各本部長がタスクに分解して起票し、
担当者が実行、分析/運用/経営が検証・是正する。人はボードを見て、要人手タスクと重要承認だけ行う。

---

## 3. 経営サイクル（事業ループ）

Org は次の閉ループを回し続ける。各矢印が本部間の引き継ぎ（起票 → 実行 → 次本部へ）。

```text
   ┌──────────────────────────────────────────────────────────────┐
   │                                                              │
   ▼                                                              │
[分析] 売上/市場を分析 ──▶ [CEO] 方針＋予算配分 ──▶ [制作] 企画→執筆→編集→表紙→品質
                                                          │
                                                          ▼
[分析] 売上/効果を検証 ◀── [販促] 作成→投稿→検証 ◀── [出版] メタデータ→価格→入稿→公開
   │                                                     ▲
   └──────── 改善ToDo（次サイクルの企画/価格/販促へ） ─────┘
                         ▲
                    [運用] 全工程の健全性を監視・復旧（横断）
                    [経営] 全工程のコストを集計・予算ガード（横断）
```

- **縦の意思決定**: CEO → 本部長 → 担当者（Objective を task へ分解）。
- **横の連携**: ある本部の完了タスクが次本部のタスクを起票（例: 品質判定OK → 出版本部の「入稿」タスク自動起票）。
- **横断本部**: 運用・経営は特定書籍でなく **全工程を横断**して監視/是正する。

---

## 4. エージェント役割定義（Org ロール）

いずれも `packages/agents/` のランタイムエージェントとして追加し、`prompts`（DB）＋
`model_assignments` を持つ（既存規約通り）。**「担当者」の多くは既存ランタイムエージェントの再利用**で、
新規に増やすのは主に **経営層・本部長・一部の担当（分析/運用/経営）**。

### 4.1 経営層

| ロール | 責務 | 入力 | 出力 | 既定モデル(案) |
| --- | --- | --- | --- | --- |
| `ceo` (社長) | 全社状況を俯瞰し、期間の **方針(Objective)**・**本部別予算配分**・優先順位を決め本部長へ委任。分析からの示唆で「次に何を作り/売るか」を決断 | 書籍一覧・売上(SalesRecord)・当月コスト(token_usage)・市場示唆(分析)・進行中ToDo | Objective[]（対象・目的・KPI・本部別予算・期限） | opus-4.8 |
| `finance_mgr` (CFO/経営管理) | 予算配分の妥当性チェック・全社/本部/書籍別コスト集計・**上限ガード**（超過見込みで停止し承認要求） | token_usage・AppSettingsコスト上限・Objective予算 | コストレポート＋是正ToDo（凍結/再配分） | sonnet-5 |

### 4.2 本部長（マネージャー）

| ロール | 責務 | 入力 | 出力 | 既定モデル(案) |
| --- | --- | --- | --- | --- |
| `editorial_mgr` (制作本部長) | どの本を作るか・部数/優先度を決め、企画→執筆→編集→表紙→品質のタスクに分解。既存パイプライン起動を指揮 | Objective＋テーマ在庫＋分析示唆 | 制作タスク[]（plan_book/write/edit/design_cover/qa） | opus-4.8 (web_search可) |
| `publish_mgr` (出版本部長) | 品質OKの本を **KDP出版** へ。メタデータ/価格/カテゴリ/キーワード方針を決めタスク化 | 品質判定済み書籍＋市場示唆 | 出版タスク[]（prepare_metadata/set_price/publish_kdp） | opus-4.8 |
| `analytics_mgr` (分析本部長) | 売上・市場・KPIの分析計画を立て担当へ割当、示唆を **CEO/制作/出版/販促へ還元** | SalesRecord＋KDPレポート＋Web(市場) | 分析タスク[]（analyze_sales/research_market/report） | opus-4.8 (web_search可) |
| `promo_mgr` (販促本部長) | 書籍ごとに販促戦略を決定しToDo化。アカウント振り分け・新規要否判断（v1設計を継承） | Objective＋書籍メタ＋接続済アカウント＋過去実績 | 販促タスク[]（create_content/publish_post/analyze_promo/create_account(human)） | opus-4.8 (web_search可) |
| `ops_mgr` (運用本部長) | パイプライン/ジョブの健全性を監視し、スタック復旧・エラートリアージをタスク化（横断） | Job/BatchPlan状態・/progress滞留検知・失敗ログ | 運用タスク[]（monitor/recover_job/triage_error） | sonnet-5 |

### 4.3 担当者（ワーカー）

| ロール | 責務 | 実体 |
| --- | --- | --- |
| `marketer` / `writer` / `editor` / `thumbnail` / `quality_judge` | 企画・執筆・編集・表紙・品質判定 | **既存ランタイムエージェント再利用**（パイプライン各タスク） |
| `metadata_worker` (出版・入稿) | KDPメタデータ/キーワード/カテゴリ/価格の草案・整備 | 新規（LLM）。Phase 3 の KDP自動入稿(Playwright)は既存ロードマップに接続 |
| `publish_worker` (出版・公開) | KDP公開の実行（Phase 3の自動化 or 人手承認ゲート） | Phase 3 worker（`kdp-publish`）に接続、当面は `needs_human` |
| `sales_analyst` (売上アナリスト) | 売上の前後比較・トレンド・書籍別ランキング分析 | 新規（LLM）。SalesRecord/KDP取込を集計 |
| `market_analyst` (市場アナリスト) | ジャンル/競合/検索需要のリサーチ、次テーマ提案 | 新規（web_search）。既存 Marketer の検索基盤を流用 |
| `content_creator` / `publisher_worker` / `promo_analyst` | 販促コンテンツ作成／投稿／効果検証 | v1設計（promoter・promotion.post.publish 再利用） |
| `ops_worker` (運用担当) | ジョブ再投入・チャプター再実行・失敗トリアージの実行 | 新規（多くは非LLMのオペレーション。既存の再投入手順を関数化） |
| `cost_accountant` (コスト会計) | token_usage をタスク/本部/書籍に集計しコスト確定 | 新規（主に集計ロジック、LLM最小） |

> 注: 「担当者」は必ずしも LLM ではない（投稿・再投入・集計は決定的処理）。Org 層の価値は
> **「いつ・何を・どの本に・どの予算で」やるかの意思決定と分解・検証** にある。

---

## 5. DB スキーマ

### 5.1 `org_objectives`（CEOの方針・全社戦略）

| 列 | 型 | 説明 |
| --- | --- | --- |
| id | cuid PK | |
| period_label | String | 例 "2026-07" / "launch:bookX" |
| title | String | 方針名 |
| body_json | Json | { focus_books[], goals[], kpi[], notes } |
| budget_jpy | Int? | この方針の全社コスト上限 |
| budget_allocation_json | Json? | 本部別予算配分 { production, publishing, analytics, promotion, sysops, finance } |
| status | String | active / closed |
| created_at / updated_at | | |

### 5.2 `org_tasks`（全社ToDoバックログ本体）

| 列 | 型 | 説明 |
| --- | --- | --- |
| id | cuid PK | |
| objective_id | String? | 紐づく方針 (FK, SetNull) |
| parent_id | String? | 親タスク（階層/分解） (self FK) |
| division | String | production / publishing / analytics / promotion / sysops / finance |
| book_id | String? | 対象書籍 (FK, SetNull)。横断タスクは null |
| owner_role | String | 起票者ロール (ceo/各mgr/analyst 等) |
| assignee_role | String | 実行担当ロール (writer/metadata_worker/content_creator/ops_worker/human 等) |
| channel | String? | 販促用: x/instagram/tiktok/note/blog |
| account_ref | String? | 販促用: 対象アカウント識別 |
| kind | String | §6 の種別（本部別の動詞） |
| title | String | 人が読むタスク名 |
| instruction | String @db.Text | 実行指示（担当エージェントへの入力） |
| status | String | proposed / approved / in_progress / blocked / needs_human / done / canceled |
| priority | String | must / should / may |
| depends_on | String[] | 依存タスクID（例: 出版は品質OKに依存） |
| scheduled_for | DateTime? | 実行予定 |
| cost_jpy | Decimal? | このタスクで発生した実コスト（積算） |
| result_json | Json? | 実行成果（生成物ID/ASIN/投稿URL/検証結果 等） |
| error | String? | |
| created_at / updated_at / done_at | | |

インデックス: `(status, scheduled_for)`, `(division, status)`, `(book_id)`, `(assignee_role, status)`, `(objective_id)`。

### 5.3 既存テーブルとの関係

- **Book / パイプライン各テーブル**（既存）＝ 制作・出版本部の実行対象。`org_tasks(kind='write' 等)` は既存パイプラインタスクを起動。
- **PromotionPost / PromotionChannelSetting**（既存）＝ 販促本部の実行エンジン。
- **SalesRecord**（既存）＝ 分析本部の主データ（KDP xlsx取込/手入力）。
- **Job / BatchPlan**（既存）＝ 運用本部の監視対象。
- **token_usage**（既存）＝ 経営管理のコスト源泉。**`org_task_id String?` を追加**し全呼び出しをタスクへ紐付け。
- **AppSettings**（既存コスト上限/フラグ）＝ 経営管理の上限ガードと連動。

---

## 6. タスク種別（kind）— 本部別の動詞

| 本部 | kind | 実行実体（再利用/新規） |
| --- | --- | --- |
| production | `plan_book`（企画） | Marketer（テーマ生成）再利用 |
| production | `write` / `edit` / `design_cover` / `qa` | Writer/Editor/Thumbnail/Quality Judge 再利用（既存パイプライン） |
| publishing | `prepare_metadata` / `set_price` | metadata_worker（新規LLM） |
| publishing | `publish_kdp` | Phase 3 `kdp-publish`（当面 needs_human 承認ゲート） |
| analytics | `analyze_sales` / `research_market` / `report` | sales_analyst / market_analyst（新規） |
| promotion | `create_content` / `publish_post` / `analyze_promo` | promoter / promotion.post.publish 再利用（v1） |
| promotion | `create_account` / `connect_account` | **human**（needs_human） |
| sysops | `monitor` / `recover_job` / `triage_error` | ops_worker（既存再投入手順を関数化） |
| finance | `budget_review` / `cost_report` / `enforce_limit` | cost_accountant / finance_mgr |

---

## 7. タスク状態遷移

```text
proposed ──(承認 or 自動承認)──▶ approved ──(担当が着手)──▶ in_progress
   │                                                        │
   │                                             ┌──────────┼───────────┐
   ▼                                             ▼          ▼           ▼
canceled                                       done      blocked    needs_human
                                                  ▲          │           │
                                                  └──────────┴───(依存解消/人手で再開)
```

- **自動承認ポリシ**: 低リスク・低コストのタスク（制作の中間工程/分析/販促コンテンツ/運用の再投入）は
  本部長起票時に `approved` へ自動遷移。**予算超過リスク**・**外部公開を伴うもの**（KDP公開、要人手の
  アカウント作成）は `needs_human`（人の承認待ち）。
- `blocked`: 依存未達（例: 品質未OKで入稿不可、アカウント未接続で投稿不可）→ 依存解消で再開。
- `depends_on` により本部間の順序（制作→出版→販促、分析は随時）を機械的に担保。

---

## 8. オーケストレーション（実行フロー）

graphile-worker 上のタスクとして実装。

1. **`org.plan`（CEOティック）** — cron（日次）＋ 重要イベント契機（新テーマ完成／書籍公開／売上取込）。
   - CEO が全社状況を集約 → Objective を作成/更新（**本部別予算配分**含む）。
   - 各 Objective について **各本部長を起動** → 本部ごとに `org_tasks` を起票・分解。
   - 例: 分析示唆「Xジャンルが伸びている」→ CEO が制作本部へ「Xジャンル3冊」Objective → 制作本部長が `plan_book`×3 を起票。
2. **`org.execute.dispatch`（cron）** — `approved` かつ期限到来かつ依存充足のタスクを担当ロール別に投入。
   - production → 既存パイプラインタスク（theme/write/edit/cover/qa）
   - publishing → metadata_worker → （公開は needs_human もしくは Phase3 kdp-publish）
   - analytics → sales_analyst / market_analyst → 示唆を result_json に格納し **CEO/制作/販促へ改善ToDo起票**
   - promotion → promoter → promotion.post.publish → promo_analyst
   - sysops → ops_worker（再投入/トリアージ）
3. **本部間の連鎖起票** — タスク完了フックで次本部タスクを自動起票（`qa:done` → `prepare_metadata`、`publish_kdp:done` → 販促 `create_content`、`publish_post:done` → `analyze_promo`）。
4. **横断本部の常時稼働**:
   - **運用**: `org.ops.watch`（cron）が Job/BatchPlan/滞留(/progress)を走査し `recover_job`/`triage_error` を起票。
   - **経営**: `org.finance.tick`（cron）が token_usage を集計し予算消化を更新、超過見込みで `enforce_limit`（凍結/再配分）を起票し CEO 承認へ。

> 実行エンジンは可能な限り既存を再利用。Org 層は「計画・分解・連鎖・検証・コスト統治・可視化」を足す。

---

## 9. コスト把握と予算管理（経営管理本部）

- `token_usage` に **`org_task_id String?`** を追加（既存 book_id/theme_session_id と並ぶ集計キー）。
- 全 Org 呼び出しは `withTokenLogging` 経由で `org_task_id` を刻む。
- 集計軸: **タスク別 / 書籍別 / 本部別 / 方針別**コスト、**予算消化率**（Objective.budget_allocation_json 対比）。
- **予算ガード**（多層）:
  1. タスク実行前に「本部別予算 − 既積算」を確認、超過見込みなら `needs_human`（CFO→CEO承認）。
  2. 既存の per-book / monthly コスト上限（AppSettings, `alert.cost.check`）と統合。
  3. CFO(`finance_mgr`)が定期に全社を見て**本部間の予算再配分**を提案（低ROI本部を絞り、伸びてる本部へ寄せる）。
- ROI 視点: `cost_accountant` が **書籍別（制作＋販促コスト）対 売上** を突き合わせ、赤字書籍を分析/CEOへフラグ。

---

## 10. アカウント方針（重要・仕様固定 — v1継承）

- **既存の接続済みアカウントへの振り分けは自動**（マネージャーが book/genre/実績から判断し `account_ref` に記録）。
- **新規アカウントの自動作成は不可**（規約＋電話/本人確認/KYC）。必要時は `kind='create_account'`
  （assignee=human, status=needs_human）を起票 → 運営者が一度だけ作成・接続 → 以降は完全自動運用。
- 将来の複数アカウント管理に備え `PromotionChannelSetting` を「チャンネル×アカウント」へ拡張余地（`promotion_accounts`）。
- **KDP最終公開**も当面 `needs_human`（誤公開/価格ミス防止の承認ゲート）。Phase 3 で条件付き自動化。

---

## 11. UI（画面）

- **経営ダッシュボード** `/org`（新規・トップ）:
  - 現在の Objective・**本部別予算消化率**・当月コスト・書籍別ROI・進行中/滞留タスク数。
  - 6本部のサマリカード（制作/出版/分析/販促/運用/経営）— 各本部の進行タスクと要対応。
- **全社ToDoボード** `/org/tasks`（新規）:
  - 本部フィルタ＋書籍/方針フィルタでカンバン表示（提案/実行中/要人手/完了/ブロック）。
  - 各タスク: 本部・担当ロール・対象書籍/アカウント・状態・**コスト**・依存・成果（ASIN/投稿URL/検証結果）。
  - **要人手タスク**（アカウント作成/接続、KDP公開承認、予算再配分承認）を目立たせ、その場で承認/完了操作。
- 既存画面は **実行レイヤー**として併存: `/promotion`・`/promotion/channel/*`（販促実行）、`/progress`（運用の可視化）、売上/コスト画面（分析/経営の素データ）。

---

## 12. 段階実装計画

| Phase | 内容 | 成果 |
| --- | --- | --- |
| **P1: 骨格＋起票（経営神経系）** | org_objectives/org_tasks スキーマ+migration、`ceo`/各本部長ロール(prompt/model)、`org.plan`、`/org`＋`/org/tasks` ボードUI、承認/要人手操作、`token_usage.org_task_id` | 「CEO→各本部長が全社状況を見てToDoを自動起票」＋人が見える化 |
| **P2: 制作＋出版の自律運転** | production/publishing の dispatch、既存パイプライン接続、`metadata_worker`、qa→入稿→公開(needs_human)の連鎖起票、`analytics_mgr`/`sales_analyst`/`market_analyst` と企画還元ループ | 分析示唆→企画→制作→出版(承認公開)まで自走 |
| **P3: 販促＋運用＋経営の統合** | promotion の org 統合（v1実行エンジン接続）、`ops_mgr`/`ops_worker`（監視/復旧の自動化）、`finance_mgr`/`cost_accountant`（本部別コスト・ROI・予算再配分・上限ガード） | 販促自動ループ＋自己復旧＋予算統治まで含む全社自律 |
| **P4: 高度化** | KDP条件付き自動公開、SNS API エンゲージメント読取、多アカウント（`promotion_accounts`）、bakeoffによる各ロールのモデル最適化、方針の自動学習（勝ちパターン蓄積） | コスト最適・高精度な継続運転 |

---

## 13. 未決事項 / リスク

- **暴走防止（最重要）**: Org が大量タスク/投稿/生成を作らないよう、方針ごとの **タスク上限・制作点数上限・
  投稿頻度上限・予算上限** をハード制約に。全 dispatch は予算/レート制限を最初にチェック。
- **外部公開の安全**: KDP公開・SNS投稿は「誤爆」の実害が大きい。既定は KDP=needs_human、投稿=auto_enabledチャンネルのみ。
- **エンゲージメント取得**: 各SNS読取APIが重い（IG/TikTok審査）。P3までは売上(SalesRecord)を主指標、API読取はP4で接続済み範囲から。
- **意思決定の質**: CEO/本部長の判断品質が全社成果を左右 → opus採用＋bakeoff(F-053)で継続最適化。決定は必ず `result_json` に根拠を残し監査可能に。
- **人手ボトルネック**: 要人手タスク（アカウント作成/KDP承認）が溜まると停滞 → ボードで可視化・通知。
- **本部間デッドロック/循環**: `depends_on` の循環検出と、滞留タスクの運用本部エスカレーションで回避。

---

## 14. 既存資産の再利用まとめ

| Org 機能 | 再利用する既存 |
| --- | --- |
| 企画/執筆/編集/表紙/品質 | Marketer / Writer / Editor / Thumbnail / Quality Judge（パイプライン各タスク） |
| 出版(将来自動) | Phase 3 `kdp-publish`（Playwright, 2FA push-and-wait） |
| 投稿実行 | `promotion.post.publish` / PublisherPort（X API/Webhook/所有ブログ） |
| 投稿キュー | `PromotionPost` / `promotion.dispatch` |
| 販促コンテンツ土台 | `promoter`（promo_copy: X/note/blog） |
| 売上/市場データ | `SalesRecord` / KDP xlsx取込・手入力 / Marketer の web_search 基盤 |
| ジョブ健全性 | `Job` / `BatchPlan` / `/progress` 滞留検知 |
| コスト源泉 | `token_usage` / `withTokenLogging` / AppSettings コスト上限 / `alert.cost.check` |
| モデル比較 | バエオフ `bakeoff.run`（全 Org ロールのモデル選定に活用） |
