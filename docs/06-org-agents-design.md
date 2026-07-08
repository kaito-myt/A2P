# 06 — 組織エージェント設計（社長→マネージャー→担当者 ＋ ToDoバックログ）

> 位置づけ: **ランタイム組織**の設計。既存の「ランタイムエージェント（Marketer/Writer…）」を
> 手足として使い、その上に**戦略・計画・検証の階層**を載せる。開発時の Claude Code サブエージェント
> （`.claude/agents`）とは別物。混同を避けるため本ドキュメントでは **Org エージェント** と呼ぶ。
>
> ステータス: **設計合意フェーズ（未実装）**。この文書で合意 → Phase 1 から実装に入る。

---

## 1. 目的

出版した本を「売れる」状態にするための販促を、**人が逐一指示しなくても、組織のように自律的に
計画・実行・検証・改善**するランタイムを作る。要件（ユーザー要望）:

1. 販促施策を **ToDoリスト（バックログ）** に起こし、それを実行していく作り。
2. SNS/note は、各書籍を **どのアカウントから発信するか / 新規アカウントを用意するか** を
   **SNS担当マーケター（マネージャー）が判断して ToDo を起票**する。
3. **コンテンツ作成 → 投稿 → 効果検証** のすべてを自動実行。
4. **コストを把握**しながら進める。
5. 全体を統括する **社長エージェント** の配下に **マネージャー**、その配下に **担当者** を置く階層。

---

## 2. 全体像

```
┌─────────────────────────────────────────────────────────────┐
│ 社長 (CEO)  — 全社状況(書籍/売上/コスト/在庫/チャンネル)を俯瞰し方針を決定 │
│   出力: 目標(Objective) + 予算枠 + マネージャーへの委任                    │
└───────────────┬─────────────────────────────────────────────┘
                │ 委任 (Objective)
        ┌───────▼────────────────────────────────┐
        │ マーケマネージャー (SNS担当マーケター)   │
        │  書籍ごとに戦略を決め ToDo を起票:        │
        │   - どの既存アカウントで出すか (自動振り分け) │
        │   - 新規アカウントが要るか (=要人手ToDo)     │
        │   - チャンネル/頻度/内容方針/期間            │
        └───┬───────────┬──────────────┬───────────┘
            │ ToDo       │ ToDo         │ ToDo
   ┌────────▼───┐ ┌──────▼──────┐ ┌────▼──────────┐
   │ コンテンツ担当 │ │ 投稿担当      │ │ アナリスト      │
   │ 投稿文/記事生成 │ │ 各chへ投稿    │ │ 反応+売上で検証  │
   │ (既存 promoter/ │ │ (既存 promotion│ │ → 改善ToDoを起票 │
   │  コピー生成流用) │ │  自動投稿engine)│ │  (フィードバック)  │
   └────────────┘ └─────────────┘ └───────────────┘
                    ↕ すべて「ToDoバックログ(org_tasks)」を介して協働
                    ↕ すべての LLM/画像呼び出しコストを token_usage にタスクID付きで記録
```

**中心は ToDoバックログ**。全エージェントはタスクを「起票／担当／実行／完了／検証」するだけ。
人はボードを見て、要人手タスク（アカウント作成等）と最終承認だけ行う。

---

## 3. エージェント役割定義（Org ロール）

いずれも `packages/agents/` のランタイムエージェントとして追加。`prompts`（DB）＋
`model_assignments` を持つ（既存規約通り）。

| ロール | 責務 | 入力 | 出力 | 既定モデル(案) |
|---|---|---|---|---|
| `ceo` (社長) | 全社状況を俯瞰し、期間の**方針(Objective)**・**予算枠**・優先順位を決めマネージャーへ委任 | 書籍一覧/売上(SalesRecord)/当月コスト(token_usage)/チャンネル状況/既存ToDo進捗 | Objective[]（対象・目的・KPI・予算・期限） | opus-4.8 |
| `promo_manager` (マーケマネージャー) | Objective を受け、**書籍ごとに販促戦略を決定**し ToDo に分解。アカウント振り分け・新規要否判断 | Objective + 書籍メタ + 接続済みアカウント一覧 + 過去実績 | ToDoタスク[]（種別/担当ロール/内容指示/対象アカウント or 要人手/日程/想定コスト） | opus-4.8 (web_search可: 売れ筋/競合) |
| `content_creator` (コンテンツ担当) | 割当タスクの**投稿コンテンツを生成**（SNS文/note記事/ブログ）。※既存 `promoter.promo_copy` を土台に、チャンネル特性へ最適化 | タスク + 書籍 + チャンネル | コンテンツ本文 | sonnet-5 / opus |
| `publisher_worker` (投稿担当) | 生成コンテンツを**該当アカウントへ投稿**。※新規ロジックは作らず既存 `promotion.post.publish` を実行 | タスク + PromotionPost | 投稿結果(URL/失敗理由) | (LLM不要) |
| `analyst` (アナリスト) | 投稿の**反応＋売上の変化を検証**し、良し悪しを判定して**改善ToDoを起票** | 投稿群 + エンゲージメント(取得可能なら) + SalesRecord | 検証レポート + 次アクションToDo | sonnet-5 |

> 注: エンゲージメント（いいね/インプレッション）取得は各SNS公式APIの読み取りに依存。
> Phase 2 では **売上(SalesRecord)の前後比較**を主指標にし、API読み取りは接続済みチャンネルで可能な範囲から段階対応。

---

## 4. DB スキーマ（新規）

### 4.1 `org_objectives`（社長の方針）
| 列 | 型 | 説明 |
|---|---|---|
| id | cuid PK | |
| period_label | String | 例 "2026-07" / "launch:bookX" |
| title | String | 方針名 |
| body_json | Json | { focus_books[], goals[], kpi[], notes } |
| budget_jpy | Int? | この方針の当月コスト上限 |
| status | String | active / closed |
| created_at / updated_at | | |

### 4.2 `org_tasks`（ToDoバックログ本体）
| 列 | 型 | 説明 |
|---|---|---|
| id | cuid PK | |
| objective_id | String? | 紐づく方針 (FK, SetNull) |
| parent_id | String? | 親タスク（階層/分解） (self FK) |
| book_id | String? | 対象書籍 (FK, SetNull) |
| owner_role | String | 起票者ロール (ceo/promo_manager/analyst) |
| assignee_role | String | 実行担当ロール (content_creator/publisher_worker/analyst/human) |
| channel | String? | x/instagram/tiktok/note/blog |
| account_ref | String? | 対象アカウント識別 (PromotionChannelSetting.channel or 将来の account id) |
| kind | String | plan / create_content / publish / analyze / create_account(human) / connect_account(human) |
| title | String | 人が読むタスク名 |
| instruction | String @db.Text | 実行指示（担当エージェントへの入力） |
| status | String | proposed / approved / in_progress / blocked / needs_human / done / canceled |
| priority | String | must / should / may |
| scheduled_for | DateTime? | 実行予定 |
| cost_jpy | Decimal? | このタスクで発生した実コスト（積算） |
| result_json | Json? | 実行成果（生成物ID/投稿URL/検証結果 等） |
| error | String? | |
| created_at / updated_at / done_at | | |

インデックス: `(status, scheduled_for)`, `(book_id)`, `(assignee_role, status)`, `(objective_id)`。

### 4.3 既存テーブルとの関係
- **PromotionPost / PromotionChannelSetting**（既存）＝ **投稿担当の実行エンジン**。
  `org_tasks(kind='publish')` は PromotionPost を生成/参照して既存 `promotion.post.publish` を起動。
- **SalesRecord**（既存）＝ アナリストの効果検証の主データ。
- **token_usage**（既存）＝ コスト源泉。**`token_usage` に `org_task_id` を追加**し、各 LLM/画像
  呼び出しをタスクに紐付け → タスク別・書籍別・方針別コスト集計を可能に（後述 §7）。

---

## 5. タスク状態遷移

```
proposed ──(承認 or 自動承認)──▶ approved ──(担当が着手)──▶ in_progress
   │                                                        │
   │                                             ┌──────────┼───────────┐
   ▼                                             ▼          ▼           ▼
canceled                                       done      blocked    needs_human
                                                  ▲          │           │
                                                  └──────────┴───(人手/依存解消で再開)
```
- **自動承認ポリシ**: コスト影響が小さい/低リスクなタスク（content/publish/analyze）は
  マネージャー起票時に `approved` へ自動遷移。**予算超過リスク**や **要人手**（アカウント作成）は
  `needs_human` で人の承認待ち（既存の承認ゲート思想と一貫）。
- `blocked`: 依存（例: アカウント未接続で publish 不可）→ 依存解消で再開。

---

## 6. オーケストレーション（実行フロー）

worker タスクとして実装（既存の graphile-worker 上）。

1. **`org.plan`（社長ティック）** — cron（例: 日次）or 書籍の `publish_status='published'` 契機。
   - CEO が状況を集約 → Objective を作成/更新（予算枠含む）。
   - 各 Objective について `promo_manager` を起動 → 書籍ごとに `org_tasks` を起票
     （create_content / publish / analyze / 必要なら create_account(human)）。
2. **`org.execute.dispatch`（cron）** — `approved` かつ期限到来のタスクを担当ロール別に投入。
   - `create_content` → `org.task.content`（content_creator 実行 → 生成物を result_json/PromotionPost へ）
   - `publish` → 既存 `promotion.post.publish` を起動（投稿担当）
   - `analyze` → `org.task.analyze`（analyst 実行 → 検証 → 改善ToDo起票）
3. **予算ガード** — 実行前に「方針の budget_jpy − 既積算コスト」を確認。超過見込みなら
   `needs_human`（社長に承認を上げる）。既存の月次コスト上限（AppSettings）とも二重で連動。

> 実行エンジンは **可能な限り既存を再利用**（promotion.post.publish / promoter コピー生成 / sales-fetch/CSV取込）。
> Org 層は「計画・分解・検証・コスト管理・可視化」を足す。

---

## 7. コスト把握

- `token_usage` に **`org_task_id String?`** を追加（既存の book_id/theme_session_id と並ぶ集計キー）。
- 各 Org エージェント呼び出しは `withTokenLogging` 経由で `org_task_id` を刻む。
- 集計ビュー:
  - **タスク別コスト**: `org_tasks.cost_jpy`（token_usage からの積算をタスク完了時に反映）。
  - **書籍別/方針別コスト**: token_usage を org_task→book/objective で集計。
  - **予算消化**: Objective.budget_jpy に対する消化率。ToDoボード＋コスト画面に表示。
- 既存の per-book / monthly コスト上限（AppSettings, alert.cost.check）と統合し、
  **予算超過は自動でタスクを止め社長承認へ**。

---

## 8. アカウント方針（重要・仕様固定）

- **既存の接続済みアカウントへの振り分けは自動**：マネージャーが書籍・ジャンル・過去実績から
  「この本は X の account A と Instagram の account B で出す」等を判断し `org_tasks.account_ref` に記録。
- **新規アカウントの自動作成は不可**（各社規約 ＋ 電話/本人確認/KYC）。必要と判断した場合は
  **`kind='create_account'`（assignee=human, status=needs_human）** の ToDo を起票 → 運営者が
  一度だけ作成・接続 → 以降は担当者が完全自動運用。
- 将来 **複数アカウント管理**（1チャンネルに複数アカウント）に備え、`PromotionChannelSetting` を
  「チャンネル×アカウント」に拡張する余地を残す（Phase 2 で `promotion_accounts` を検討）。

---

## 9. UI（画面）

- **販促ToDoボード** `/promotion/todo`（新規）:
  - 書籍ごと（or 方針ごと）にタスクをカンバン表示（提案/実行中/要人手/完了）。
  - 各タスク: 担当ロール・チャンネル/アカウント・状態・**コスト**・成果（投稿URL/検証結果）。
  - **要人手タスク**（アカウント作成/接続、承認）は目立たせ、その場で承認/完了操作。
- **組織サマリ**（ダッシュボード拡張 or `/promotion/todo` 上部）:
  - 現在の Objective・予算消化率・当月販促コスト・進行中/滞留タスク数。
- 既存 `/promotion`（プラン一覧）・`/promotion/channel/*`（自動運用）は**実行レイヤー**として併存。

---

## 10. 段階実装計画

| Phase | 内容 | 成果 |
|---|---|---|
| **P1: 起票まで** | org_objectives/org_tasks スキーマ+migration、`ceo`/`promo_manager` ロール(prompt/model)、`org.plan` タスク、ToDoボードUI、承認/要人手操作、token_usage.org_task_id | 「社長→マネージャーが状況を見て ToDo を自動起票」＋人が見える化 |
| **P2: 実行＋検証** | `org.execute.dispatch`、`content_creator`/`analyst` ロール、`org.task.content`/`org.task.analyze`、既存 promotion.post.publish 接続、売上前後比較の効果検証→改善ToDo | コンテンツ作成〜投稿〜効果検証の自動ループ |
| **P3: コスト統治＋多アカウント** | 予算ガード統合、タスク別/書籍別/方針別コストダッシュボード、`promotion_accounts`(1ch複数アカウント)、SNS API のエンゲージメント読取（接続済み範囲） | コスト最適化しながらの自律運用 |

---

## 11. 未決事項 / リスク

- **エンゲージメント取得**: 各SNSの読み取りAPI要件が重い（IG/TikTokは審査）。P2は売上主指標、API読取はP3で接続済み範囲から。
- **暴走防止**: Org が大量タスク/投稿を生成しないよう、方針ごとの**タスク上限・投稿頻度上限・予算上限**をハード制約に。
- **自動承認の線引き**: どこまで人手を介さず実投稿まで行くか。既定は「実投稿は auto_enabled チャンネルのみ・要人手は明示」。
- **モデル選定**: `ceo`/`manager` は判断品質重視で opus、担当は sonnet 等。バエオフ(F-053)で最適化。

---

## 12. 既存資産の再利用まとめ

| Org 機能 | 再利用する既存 |
|---|---|
| 投稿実行 | `promotion.post.publish` / PublisherPort（X API/Webhook/所有ブログ）|
| 投稿キュー | `PromotionPost` / `promotion.dispatch` |
| コンテンツ土台 | `promoter`（promo_copy: X/note/blog）|
| 売上データ | `SalesRecord` / KDP xlsx 取込・手入力・（将来）自動取得 |
| コスト源泉 | `token_usage` / `withTokenLogging` / AppSettings コスト上限 / alert.cost.check |
| モデル比較 | バエオフ `bakeoff.run`（Org ロールのモデル選定に活用）|
