# SP-10 quality-judge (Phase 2)

> Phase 1 (SP-01〜SP-09) 完了後に着手。`pipeline.book.judge` の placeholder 枝を本実装に差し替え、Quality Judge エージェントによるパイプライン内品質ゲートを完成させる。

## 1. 目的

Phase 1 で出荷済みのスキップ枝（`pipeline.book.thumbnail.image` → 直接 `pipeline.book.export`）を、`pipeline.book.judge` を経由する正規フローに差し替える。Quality Judge (Sonnet / Haiku) が 6 軸採点を行い、スコア 80 未満で Writer/Editor を最大 2 回再生成し、3 回失敗で `needs_human_review` に遷移する品質ゲートを完成させる。あわせて S-010 評価履歴タブの本実装と S-002/S-017 への Quality KPI 組み込みを行う。

## 2. 対応機能 ID

- **F-008** クオリティジャッジ: 完成原稿スコアリング (0–100)
- 関連画面: **S-010** 評価履歴タブ / **S-002** 平均 Quality スコア KPI / **S-017** 書籍別 KPI テーブルの Quality 列

## 3. タスク一覧

| ID | タスク概要 | 工数 | 依存 | 状態 |
|---|---|---|---|---|
| T-10-01 | Judge エージェント実装（`packages/agents/src/judge/`）| M | — | 完了 |
| T-10-02 | `contracts` Judge I/O 型 + `prompts` seed 追加 | S | — | 完了 |
| T-10-03 | `pipeline.book.judge` ワーカータスク本実装（skip 枝を差し替え）| M | T-10-01, T-10-02 | 完了 |
| T-10-04 | `pipeline.book.thumbnail.image` の skip 枝を `judge` enqueue に変更 | S | T-10-03 | 完了 |
| T-10-05 | `revision.book.apply` に Judge 再採点フックを追加（Phase 2 有効化）| S | T-10-03 | 完了 |
| T-10-06 | S-010 評価履歴タブ本実装（`EvaluationHistoryTable` + 軸別スコア）| M | T-10-03 | 完了 |
| T-10-07 | S-002 / S-017 Quality KPI 追加（平均スコア・書籍 KPI 列）| S | T-10-03 | 完了 |
| T-10-08 | Vitest: Judge エージェント + ワーカータスク単体テスト | M | T-10-01, T-10-03 | 完了 |

合計 **8 タスク**。

---

## 4. タスク詳細

---

### T-10-01 Judge エージェント実装

**目的**: `packages/agents/src/judge/index.ts` に `judgeBook(input)` を実装する。Editor/Writer と同一の DI パターン（`createAgentClient` 経由で `withTokenLogging` ラップ）を踏襲する。

**対象ファイル**:
- `packages/agents/src/judge/index.ts`（新規作成）
- `packages/agents/src/index.ts`（エクスポート追加）

**実装仕様**:

```
docs/05 §6.3.5 の JudgeInput / JudgeOutput zod schema を参照。
1. contracts (T-10-02 で定義) の JudgeInputSchema / JudgeOutputSchema を import
2. loadActivePrompt('judge', genre) で DB プロンプトを取得
3. fillPlaceholders でプレースホルダ差込:
   {theme_title}, {theme_subtitle}, {theme_hook}, {target_reader},
   {genre}, {chapter_count}, {draft_chapters}, {outline_summary}
4. createAgentClient('judge', genre, { role: 'judge', bookId, jobId }) で
   withTokenLogging ラップ済みクライアント取得
5. client.complete({ messages, maxOutputTokens: 4096 })
   - システムプロンプトで 6 軸採点 JSON を要求
   - JSON 抽出 → zod parse (editor と同実装の extractJson + predicate)
6. score_total = 6 軸合計の重み付き平均（均等重み）
   各軸 0-100 → 合計を 6 で割り小数点以下切り捨て
7. JudgeOutput を返す（score_total / score_breakdown / judge_comments）
```

**受け入れ基準**:
- `judgeBook` が `JudgeOutput` を返す（score_total: 0–100、score_breakdown 6 軸すべて present）
- `withTokenLogging` 経由でのみ LLM 呼出（Hard Rule 5）
- JSON parse 失敗で `AgentError('judge.invalid_output', ...)` をスロー
- `loadActivePrompt('judge', ...)` が呼ばれない場合は `ConfigError` が伝播する
- 実キー不要: `deps.createAgentClient` / `deps.loadActivePrompt` の DI 差し替えでモック可能

**参照設計書**: `docs/05 §6.3.5`、`packages/agents/src/editor/index.ts`（実装パターン）

---

### T-10-02 contracts Judge I/O 型 + prompts seed 追加

**目的**: `JudgeInput` / `JudgeOutput` の zod スキーマを `packages/contracts` に追加し、`packages/db/seed.ts` に `role='judge'` の初期プロンプト行を追加する（Hard Rule 4）。

**対象ファイル**:
- `packages/contracts/src/agents/judge.ts`（新規作成）
- `packages/contracts/src/agents/index.ts`（再エクスポート追加）
- `packages/db/seed.ts`（judge プロンプト追加）

**実装仕様**:

`JudgeInputSchema`:
```typescript
// docs/05 §6.3.5 の型定義をそのまま contracts に移植
z.object({
  book_id: z.string(),
  job_id: z.string().optional(),
  book_id: z.string(),
  genre: z.enum(['practical','business','self_help']).nullable(),
  theme_context: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    hook: z.string(),
    target_reader: z.string(),
  }),
  outline_summary: z.string(), // アウトライン JSON の文字列化（最大 2,000 字）
  chapters: z.array(z.object({
    index: z.number().int(),
    heading: z.string(),
    body_md: z.string().max(12000), // 各章の最初 8,000 字のみ渡す（コスト削減）
  })).min(1).max(15),
})
```

`JudgeOutputSchema`:
```typescript
// docs/05 §6.3.5 の JudgeOutput をそのまま利用
z.object({
  score_total: z.number().int().min(0).max(100),
  score_breakdown: z.object({
    benefit_clarity: z.number().int().min(0).max(100),
    logical_consistency: z.number().int().min(0).max(100),
    style_consistency: z.number().int().min(0).max(100),
    japanese_naturalness: z.number().int().min(0).max(100),
    title_alignment: z.number().int().min(0).max(100),
    genre_fit: z.number().int().min(0).max(100),
  }),
  judge_comments: z.record(z.string(), z.string()),
})
```

seed の追加行（`packages/db/seed.ts`）:
```
role: 'judge', genre: null, status: 'active', version: 1,
created_by: 'human',
body: Judge 向け日本語採点プロンプト（6 軸採点を指示する日本語テンプレ）
placeholders_json: ["theme_title","theme_subtitle","theme_hook","target_reader",
  "genre","chapter_count","draft_chapters","outline_summary"]
```

**受け入れ基準**:
- `JudgeInputSchema.parse(...)` / `JudgeOutputSchema.parse(...)` が正常ケースを通す
- seed 実行後 `prompts` テーブルに `role='judge'` の行が 1 件以上存在する
- `AgentRole` ユニオン型に `'judge'` が含まれる（既存コードで既に含まれている場合はスキップ）

**参照設計書**: `docs/05 §6.3.5`、`packages/contracts/src/agents/editor.ts`（I/O 型の書き方）、`packages/db/seed.ts`（既存 seed パターン）

---

### T-10-03 `pipeline.book.judge` ワーカータスク本実装

**目的**: `apps/worker/src/tasks/pipeline-book-judge.ts` の placeholder を本実装に差し替える。`docs/05 §5.3.8` の仕様（スコア >= 80 → export enqueue、< 80 かつ `retry_count < 2` → writer.chapter or editor 再キック、3 回目失敗 → `needs_human_review`）を実装する。

**対象ファイル**:
- `apps/worker/src/tasks/pipeline-book-judge.ts`（placeholder を本実装に全面置換）

**実装仕様** (Editor タスクと同型の DI 構造):

```
PipelineBookJudgePayloadSchema:
  { book_id: string, job_id: string, retry_count: number (default 0) }
  ← docs/05 §5.3.8 の型定義と完全一致

フロー:
  1. payload zod parse（ValidationError on fail）
  2. 冪等チェック: Job.status='done' ならスキップ
  3. CAS: queued/failed → running
  4. BookLock 取得（holder=`pipeline:<job_id>`, TTL 30 分）
  5. Book + ThemeCandidate + Outline + Chapter[] (全章) を fetch
     - Chapter 0 件 → NotFoundError
  6. judgeBook(input) 呼出（token_usage は judgeBook 内で role='judge' INSERT）
  7. EvalResult INSERT:
       {
         book_id, prompt_version_ids_json: {} (空でよい, Phase 2 初版),
         score_total, score_breakdown_json, judge_comments_json,
         triggered_by: retry_count === 0 ? 'auto' : `auto_retry:${retry_count}`,
         retry_count,
         judged_at: now()
       }
  8. 分岐:
     A. score_total >= 80:
        → Book.status = 'exporting'
        → pipeline.book.export enqueue（parent_job_id=本 job_id）
     B. score_total < 80 かつ retry_count < 2:
        → どの軸が低いかで再キックを判断:
            style_consistency / japanese_naturalness / logical_consistency < 70
              → pipeline.book.editor enqueue（feedback=軸別コメント）
            それ以外（benefit_clarity / title_alignment / genre_fit 低下）
              → pipeline.book.writer.chapter 全章 enqueue（feedback=軸別コメント）
            両方低い場合は editor を優先（全章再校閲で一本化）
        → 新 Job INSERT（retry_count+1 付き）+ addJob
        → Book.status = 'judging'（再生成中）
     C. score_total < 80 かつ retry_count >= 2:
        → Book.status = 'needs_human_review'
        → Alert INSERT: { kind:'judge_failed', severity:'warning',
                          payload_json:{ book_id, score_total, retry_count } }
        → Resend で 'judge-needs-review' メール（既存テンプレを再利用
          または簡易 inline 送信でよい）
  9. Job.status='done', result_json=採点結果サマリ
 10. notifyJobChange({ phase:'judge_done' or 'judge_retry' or 'needs_human_review' })
 11. finally: BookLock 解放

グローバル Resend 通知 (ステップ 8-C) は
  packages/notify/src/email.ts の sendMail() を使用。
  テンプレートは既存パターン（book-done 等）に倣い inline HTML で最小実装。
  `from` は渡さず `sendEmail` 内の `MAIL_FROM` 既定にフォールバックさせる
  （既存規約に統一。新 env は増やさない。Hard Rule 6: secrets 非コミット）。
```

**受け入れ基準** (F-008 受け入れ基準を直接検証):
- `EvalResult` が 1 件 INSERT される（Vitest で Prisma mock 確認）
- score_total >= 80 で `pipeline.book.export` が enqueue される
- score_total < 80 かつ retry_count=0 で `pipeline.book.editor` または `pipeline.book.writer.chapter` が enqueue され、payload に `retry_count=1` が含まれる
- score_total < 80 かつ retry_count=2 で `Book.status='needs_human_review'` かつ `Alert` が INSERT される
- `judgeBook` は `deps.judgeBook` で差し替え可能（実 LLM 不要のテスト構成）
- `token_usage` の `role='judge'` 行が `judgeBook` 内で記録される（Judge 関数の mock が呼ばれ、withTokenLogging の mock が INSERT を呼ぶことを assert）

**参照設計書**: `docs/05 §5.3.8`、`apps/worker/src/tasks/pipeline-book-editor.ts`（全体構造）

---

### T-10-04 `pipeline.book.thumbnail.image` skip 枝を `judge` enqueue に変更

**目的**: Phase 1 で出荷した「サムネ完了 → `pipeline.book.export` 直接 enqueue」の skip 枝を「→ `pipeline.book.judge` enqueue（`retry_count=0`）」に変更する。

**対象ファイル**:
- `apps/worker/src/tasks/pipeline-book-thumbnail-image.ts`

**実装仕様**:

```typescript
// 変更前: (Phase 1 skip 枝)
await addJob(PIPELINE_BOOK_EXPORT_TASK_NAME, { book_id, job_id: exportJob.id })

// 変更後:
import { PIPELINE_BOOK_JUDGE_TASK_NAME } from './pipeline-book-judge.js'
// ...
const judgeJob = await prisma.job.create({
  data: {
    kind: PIPELINE_BOOK_JUDGE_TASK_NAME,
    book_id: bookId,
    parent_job_id: jobId,
    status: 'queued',
    payload_json: { book_id: bookId, retry_count: 0 },
  },
});
await addJob(
  PIPELINE_BOOK_JUDGE_TASK_NAME,
  { book_id: bookId, job_id: judgeJob.id, retry_count: 0 },
  { maxAttempts: 2 },
);
// Book.status = 'judging'（既存の 'thumbnail' から遷移）
```

また `PIPELINE_BOOK_EXPORT_TASK_NAME` への import と呼出を削除（ただし `revision.book.apply` から直接 export を呼ぶ枝は維持）。

**受け入れ基準**:
- thumbnail.image タスク完了後に `pipeline.book.judge` がキューに入る
- `pipeline.book.export` が直接キューに入らない
- 既存の thumbnail.image Vitest が引き続き green（import 変更のみ）

**参照設計書**: `docs/05 §5.3.7` (thumbnail.image)、`docs/05 §5.3.8` (judge)

---

### T-10-05 `revision.book.apply` に Judge 再採点フックを追加（Phase 2 有効化）

**目的**: `docs/05 §5.3.10` に「→ Judge 再採点（Phase 2）」と明記されており、Phase 1 では skip していた `revision.book.apply` の Judge 呼出を本実装に有効化する。

**対象ファイル**:
- `apps/worker/src/tasks/revision-book-apply.ts`

**実装仕様**:

```
revision.book.apply フロー末尾に追加（既存実装の TODO コメント箇所を置換）:

全コメント適用完了後、pipeline.book.judge を enqueue:
  payload: { book_id, job_id: <新規 Job.id>, retry_count: 0 }
  triggered_by ≠ 'auto' → EvalResult.triggered_by = `revision_run:<run_id>`
  これは judgeBook 呼出後 pipeline-book-judge 内で INSERT される設計なので
  revision.book.apply 側から triggered_by を payload に乗せて渡す。

PipelineBookJudgePayloadSchema に triggered_by?: string を追加（optional）し、
EvalResult INSERT 時に payload.triggered_by があればそちらを優先する。
```

**受け入れ基準**:
- `revision.book.apply` の result_summary_json に `rescore_job_id` が含まれる
- revision 完了後に `pipeline.book.judge` が enqueue される（Vitest mock で assert）
- 既存 revision.book.apply Vitest が引き続き green

**参照設計書**: `docs/05 §5.3.10`、`docs/02 F-050`（再採点への言及）

---

### T-10-06 S-010 評価履歴タブ本実装

**目的**: `books/[id]/page.tsx` の「評価履歴」タブを Phase 1 のプレースホルダから本実装の `EvaluationHistoryTable` に差し替える。

**対象ファイル**:
- `apps/web/app/(app)/books/[id]/page.tsx`（評価履歴タブのコンテンツ差し替え）
- `apps/web/components/books/evaluation-history-table.tsx`（新規作成）
- 必要に応じて `apps/web/app/actions/books.ts` or RSC 用 DB クエリ追加

**実装仕様**:

```
RSC（Server Component）パターンで実装（GET 系は RSC + Prisma 直呼び）:

評価履歴タブ コンポーネント (RSC):
  prisma.evalResult.findMany({
    where: { book_id },
    orderBy: { judged_at: 'desc' },
    take: 20,
  })

EvaluationHistoryTable (Client Component または静的 RSC):
  列: judged_at (日時) | score_total | 6 軸スコア (mini bar) | triggered_by
  | judge_comments (accordion)
  - 最新行を "latest" バッジで強調
  - score_total が 80 未満の行は赤ハイライト
  - triggered_by が 'revision_run:*' の場合はリンク（S-014）

ワイヤーフレーム参照:
  docs/wireframes/S-010-book-detail/prompt.md §Section 2 タブナビゲーション
  「評価履歴」タブが列挙されていること確認済み。
  desktop.png の視覚パターン（テーブル 8-12 行、スコアバッジ）に準拠。
```

**受け入れ基準**:
- `eval_results` が 0 件のとき EmptyState 表示（"採点履歴がありません"）
- 1 件以上で `EvaluationHistoryTable` が描画される
- score_total < 80 の行が識別可能な表示（赤文字 or 背景）
- 6 軸スコアが一覧できる（mini bar またはテキスト数値）
- Vitest (コンポーネント or ロジック) または Playwright smoke テストで 1 ケース以上

**参照設計書**: `docs/04 §4 S-010`、`docs/wireframes/S-010-book-detail/prompt.md`

---

### T-10-07 S-002 / S-017 Quality KPI 追加

**目的**: ダッシュボード（S-002）の KPI ストリップに「平均 Quality スコア」を反映し、S-017 書籍 KPI テーブルに Quality 列を追加する。

**対象ファイル**:
- `apps/web/app/(app)/dashboard/page.tsx`（KPI ストリップ Section 1 の Quality スコアを実値接続）
- `apps/web/app/(app)/sales/page.tsx`（書籍 KPI テーブルの Quality 列に `EvalResult.score_total` 最新値を追加）

**実装仕様**:

```
S-002 平均 Quality スコア（RSC で集計）:
  const avgQuality = await prisma.evalResult.aggregate({
    _avg: { score_total: true },
    where: {
      judged_at: { gte: startOfMonth(new Date()) },
    },
  })
  → KPI カード 4 番目「平均 Quality スコア: 78.4 (前月比 +2.1)」
  前月比は当月 avg と先月 avg を個別取得し差分計算

S-017 書籍 KPI テーブル Quality 列（RSC JOIN):
  prisma.book.findMany() に evalResults: { orderBy: judged_at: 'desc', take: 1 }
  の include を追加し、最新 score_total を Quality 列として表示
  eval_results が 0 件の場合は "—" 表示

ワイヤーフレーム参照:
  docs/wireframes/S-002-dashboard/prompt.md §Section 1 KPI ストリップ
    「平均 Quality スコア: "78.4"（前月比 +2.1）」が列挙済み
  docs/wireframes/S-017-sales-kpi/prompt.md §Section 6 書籍別 KPI テーブル
    「Quality」列が列挙済み
```

**受け入れ基準**:
- S-002 KPI ストリップに平均スコアが数値で表示される（`eval_results` が 0 件の場合は "—"）
- S-017 書籍テーブルの Quality 列に最新スコアが表示される
- DB 集計が 1 秒以内（インデックス `eval_results_time_idx` を利用）

**参照設計書**: `docs/04 §4 S-002`、`docs/04 §4 S-017`、`docs/wireframes/S-002-dashboard/prompt.md`、`docs/wireframes/S-017-sales-kpi/prompt.md`

---

### T-10-08 Vitest: Judge エージェント + ワーカータスク単体テスト

**目的**: Judge エージェント（T-10-01）とワーカータスク（T-10-03）の Vitest カバレッジを確保する。実 LLM キー不要でモック完結。

**対象ファイル**:
- `packages/agents/__tests__/judge/index.test.ts`（新規作成）
- `apps/worker/src/__tests__/pipeline-book-judge.test.ts`（新規作成）

**実装仕様**:

Judge エージェントテスト (`__tests__/judge/index.test.ts`):
```
describe('judgeBook', () => {
  it('6 軸スコアの平均を score_total に設定する', ...)
  it('JSON parse 失敗で AgentError をスロー', ...)
  it('createAgentClient が role=judge で呼ばれる', ...)
  it('score_total は 0-100 の範囲に収まる', ...)
})

mock 方針:
  - deps.createAgentClient: 固定 JSON を返す stub LLMClient
  - deps.loadActivePrompt: { template: 'mock prompt', version: 1, promptId: 'p1', genre: null }
  - withTokenLoggingDeps.prisma: { tokenUsage: { create: vi.fn() }, modelCatalog: ... }
```

ワーカータスクテスト (`pipeline-book-judge.test.ts`):
```
describe('runPipelineBookJudge', () => {
  it('score >= 80 で pipeline.book.export が enqueue される', ...)
  it('score < 80 かつ retry_count=0 で editor が再キックされる', ...)
  it('score < 80 かつ retry_count=2 で needs_human_review になる', ...)
  it('Job 冪等チェック: done 状態なら早期 return', ...)
  it('EvalResult が INSERT される', ...)
  it('Alert が INSERT される（needs_human_review 時）', ...)
})

mock 方針 (editor タスクテストと同型):
  - deps.judgeBook: vi.fn().mockResolvedValue({ score_total: 82, ... })
  - deps.prisma: 最小サブセット mock (Prisma I/F 定義を別 interface で切り出す)
  - addJob: vi.fn()
```

**受け入れ基準**:
- `pnpm --filter @a2p/agents test` が green
- `pnpm --filter @a2p/worker test` が green（pipeline-book-judge.test.ts を含む）
- 実 LLM / 実 DB キー不要で CI 通過
- カバレッジ: 上記 6 ケース以上の assertion が全 pass

**参照設計書**: `docs/02 F-008 受け入れ基準`、`packages/agents/__tests__/editor/index.test.ts`（テストパターン）

---

## 5. テスト計画

| 対象 | テスト種別 | ファイル | 内容 |
|---|---|---|---|
| Judge エージェント | Vitest (unit) | `packages/agents/__tests__/judge/index.test.ts` | 採点ロジック / JSON 抽出 / エラー処理 |
| pipeline.book.judge タスク | Vitest (unit) | `apps/worker/src/__tests__/pipeline-book-judge.test.ts` | スコア分岐 3 ケース / 冪等 / EvalResult INSERT |
| S-010 評価履歴タブ | Vitest (コンポーネント) or Playwright smoke | `tests/e2e/` または `apps/web/__tests__/` | `eval_results` あり/なしの表示確認 |
| pipeline 連鎖統合 | 既存 Playwright UC-01 への追記 | `tests/e2e/uc01-book-pipeline.spec.ts` | Judge → export の遷移（モック LLM）|

> 実 LLM を使用する Judge の品質確認（Judge スコア 80 点前後の感度）は本スプリントのスコープ外とし、Phase 2 完了確認時に 1 冊実走で確認する。

---

## 6. 完了判定

- `pm MODE: REVIEW TARGET: SP-10` で `## PHASE_COMPLETE` が出力される
- **必須**: `pipeline.book.judge` が placeholder でなく本実装で、`apps/worker/src/tasks/pipeline-book-judge.ts` の `definePlaceholderTask` 呼出が存在しない
- **必須**: スコア 80 未満再生成ループ（retry_count 0→1→2→needs_human_review）が Vitest で 1 ケース以上稼働確認
- **必須**: `pipeline.book.thumbnail.image` が skip 枝（`pipeline.book.export` 直接 enqueue）でなく `pipeline.book.judge` を enqueue している
- **必須**: `EvalResult` が INSERT されるジョブ完了時に `eval_results` 行が存在する（Vitest assert）
- **必須**: S-010 評価履歴タブが空でないとき `EvaluationHistoryTable` を描画する
- **確認**: 既存 Phase 1 パイプライン（SP-09 までの動作）を破壊しない（既存 Vitest + Playwright が全 green）

---

## 7. 依存関係と注意事項

### 7.1 DB スキーマ変更不要

`eval_results` テーブルは `packages/db/migrations/20260521000000_init/migration.sql` で Phase 1 時点で先取り済み（全列揃い）。Prisma マイグレーションのタスクは不要。

### 7.2 PipelineBookJudgePayloadSchema の拡張

T-10-05 で `triggered_by?: string` を payload に追加する。既存の `retry_count` と合わせて:
```typescript
z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
  retry_count: z.number().int().min(0).default(0),
  triggered_by: z.string().optional(), // 'auto' | 'revision_run:<id>'
})
```

### 7.3 モデル選択（コスト抑制）

`docs/05 §6.3.5` に「Claude Sonnet 4.6 または Haiku」と明記。seed の `model_assignments` には `role='judge'` の初期割当を `claude-sonnet-4-6`（または `claude-haiku-4-5` など利用可能な最軽量 Sonnet 系）で投入すること（T-10-02 でseed に追加）。

### 7.4 メール送信（ステップ 8-C）

既存の `packages/notify/src/email.ts` の `sendMail()` を使用。`needs_human_review` 通知テンプレートは新規 react-email テンプレートを作成するのが理想だが、初版は inline HTML で可（Resend ダッシュボードに残ればよい）。テンプレートの完成度は SP-11 で改善してよい。

### 7.5 ADR-001 遵守

`notifyJobChange` 呼出では `pg_notify('jobs', ...)` チャネル名を `'jobs'` に統一（`docs/05 §16 ADR-001`）。T-10-03/T-10-05 実装時に旧表記 `'jobs_progress'` を絶対に使わない。
