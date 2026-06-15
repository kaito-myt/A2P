# SP-11 prompt-optimizer-approval (Phase 2)

> Phase 2 スプリント。SP-10 (quality-judge) `PHASE_COMPLETE` 後に着手。
> 完了確認: `pm MODE: REVIEW TARGET: SP-11` で `## PHASE_COMPLETE` 出力が完了基準。

---

## 1. 目的

Prompt Optimizer エージェント (F-009) 実装・10 冊トリガー配線・`optimizer.prompt.generate` ワーカータスク本実装、
プロンプト改訂承認 UI (F-029)、自動承認 5 冊連続改善ルール (F-030)、プロンプト A/B 配信 (F-031) を実装し、
「10 冊出版 → Optimizer 改訂提案 → 承認 → 5 冊連続改善で自動承認」のループを稼働させる。

---

## 2. 対応機能 ID

| 機能 ID | 機能名 | 優先度 |
|---|---|---|
| F-009 | Prompt Optimizer: 10 冊ごとの改訂提案生成 | P0 |
| F-029 | プロンプト改訂提案の運営者承認 UI | P0 |
| F-030 | プロンプト自動承認ルール（5 冊連続スコア改善で自動採用） | P0 |
| F-031 | プロンプト A/B 配信（バージョン併走） | P1 |

関連画面: **S-022** プロンプト管理、**S-023** プロンプト改訂承認
参照ワイヤーフレーム: `docs/wireframes/S-022-prompt-management/prompt.md`, `docs/wireframes/S-023-prompt-approval/prompt.md`

---

## 3. 前提確認

| 確認項目 | 状況 |
|---|---|
| `prompt_proposals` テーブル (Prisma) | Phase 1 で先取り済み（`docs/05 §3`）|
| `prompts` テーブル + `status=active` partial unique | Phase 1 で先取り済み |
| `eval_results` テーブル | SP-10 で実装済み |
| `app_settings.prompt_auto_approval_enabled` / `prompt_auto_approval_rollback_h` | Phase 1 で先取り済み |
| `books.prompt_version_ids_json` | Phase 1 で先取り済み |
| `withTokenLogging` / `createAgentClient` / `loadActivePrompt` | SP-02/SP-10 で実装済み |
| DI パターン (`JudgeBookDeps` 型) | SP-10 の `packages/agents/src/judge/index.ts` を参照 |
| SA パターン (`lib/*-core.ts` + `'use server' actions/` ラッパ) | SP-01〜SP-10 で確立済み |
| `audit_log` テーブルと `action='prompt.approve'`/`'prompt.rollback'` | Phase 1 で設計済み（`docs/05 §3`）|

> DB スキーマ追加マイグレーション: T-11-06 で `app_settings` に `ab_distribution_json Json?` 列を追加する Prisma マイグレーションが 1 件発生する。それ以外は既存スキーマで実装できる。

---

## 4. タスク一覧

| タスク ID | タイトル | 工数 | 依存 | 状態 |
|---|---|---|---|---|
| T-11-01 | Optimizer エージェント実装 (`packages/agents/src/optimizer/`) | M | — | 完了 |
| T-11-02 | `optimizer.prompt.generate` ワーカータスク本実装 | M | T-11-01 | 完了 |
| T-11-03 | 10 冊出版完了トリガー配線 (pipeline-book-export に件数判定追加) | S | T-11-02 | 完了 |
| T-11-04 | プロンプト承認/ロールバック SA + core ロジック (`decideProposal`, `rollbackAutoApproved`) | M | — | 完了 |
| T-11-05 | 自動承認判定 (`checkAutoApproval`) + `rollback_until` 設定ロジック | M | T-11-04 | 完了 |
| T-11-06 | プロンプト A/B 配信 SA + `books.prompt_version_ids_json` 割当ロジック | M | T-11-04 | 完了 |
| T-11-07 | S-023 プロンプト改訂承認 UI (`/prompts/proposals/page.tsx`) | L | T-11-04 | 完了 |
| T-11-08 | S-022 プロンプト管理 UI 拡張 (`/prompts/page.tsx` — A/B 配信タブ追加) | M | T-11-06 | 完了 |
| T-11-09 | E2E テスト: UC-03 プロンプト改訂サイクル | M | T-11-07, T-11-05 | 完了 |

合計: **9 タスク**

---

## 5. タスク詳細

---

### T-11-01 Optimizer エージェント実装

**目的**
`packages/agents/src/optimizer/` に Prompt Optimizer エージェントを実装する。
SP-10 の `judgeBook` 関数と同パターン (DI + `withTokenLogging` + `loadActivePrompt`) で実装する。

**対象ファイル**
- `packages/agents/src/optimizer/index.ts` (新規)
- `packages/contracts/agents/optimizer.ts` (新規 — I/O schema)

**参照設計書**
- `docs/05 §6.3.7` Prompt Optimizer エージェント仕様
- `docs/05 §5.3.11` `optimizer.prompt.generate` ペイロード定義
- `packages/agents/src/judge/index.ts` — DI パターンの手本
- `packages/agents/src/lib/llm-client-factory.ts` — `createAgentClient`
- `packages/agents/src/lib/prompt-loader.ts` — `loadActivePrompt` / `fillPlaceholders`
- `packages/agents/src/lib/with-token-logging.ts` — `withTokenLogging`

**実装指示**

1. `packages/contracts/agents/optimizer.ts` を新規作成。

```typescript
// docs/05 §6.3.7 より
import { z } from 'zod';

export const OptimizerInputSchema = z.object({
  role: z.string(),
  genre: z.string().nullable(),
  job_id: z.string().optional(),
  recent_evals: z.array(z.object({
    book_id: z.string(),
    score_total: z.number(),
    score_breakdown: z.record(z.string(), z.number()),
    prompt_version_id: z.string(),
  })),
  recent_sales: z.array(z.object({
    book_id: z.string(),
    royalty_jpy: z.number(),
    avg_stars: z.number().nullable(),
  })),
  current_prompt: z.object({
    id: z.string(),
    body: z.string(),
    version: z.number(),
  }),
});
export type OptimizerInput = z.infer<typeof OptimizerInputSchema>;

export const OptimizerOutputSchema = z.object({
  proposed_body: z.string().min(1),
  diff: z.string(),
  rationale: z.string(),
  expected_effect: z.object({
    score_delta: z.number().optional(),
    sales_delta_pct: z.number().optional(),
  }),
  sample_output: z.string().optional(),
});
export type OptimizerOutput = z.infer<typeof OptimizerOutputSchema>;
```

2. `packages/agents/src/optimizer/index.ts` を新規作成。

- `judgeBook` と同じ DI 構造: `OptimizerDeps` interface に `loadActivePrompt?`, `createAgentClient?`, `promptLoaderDeps?`, `withTokenLoggingDeps?`, `getApiKey?` を定義。
- `loadActivePrompt('optimizer', null)` でシステムプロンプトを取得（role='optimizer', genre=null のデフォルト）。
- `fillPlaceholders` でプレースホルダを差し込む: `{role}`, `{genre}`, `{eval_count}`, `{current_prompt}`, `{eval_summary}`, `{sales_summary}`。
- `createAgentClient('optimizer', null, ctx)` で LLM クライアントを生成。`ctx.role = 'optimizer'`, `ctx.jobId` は任意。`bookId` は null（システムタスクなので token_usage の `book_id` は null）。
- Hard Rule 5 準拠: `createAgentClient` が返すクライアントは既に `withTokenLogging` ラップ済み。**手動で `withTokenLogging` を呼ばないこと**。
- LLM complete 後に `extractJson` + `OptimizerOutputSchema.safeParse` でパース。失敗時は `AgentError('optimizer.invalid_output', ...)` を throw。
- 関数シグネチャ: `export async function optimizePrompt(input: OptimizerInput, deps?: OptimizerDeps): Promise<OptimizerOutput>`

3. `packages/agents/src/lib/with-token-logging.ts` の `AgentRole` に `'optimizer'` が含まれることを確認（`packages/contracts/agents/index.ts` の `AgentRole` 型が対象、SP-01 で定義済みのはずなので確認のみ）。

**受け入れ基準**
- `OptimizerInputSchema.parse(...)` と `OptimizerOutputSchema.parse(...)` が型エラーなく通る
- `optimizePrompt` をモック `createAgentClient` で呼んだとき、`withTokenLoggingDeps.prisma.tokenUsage.create` が 1 回呼ばれる（Vitest で検証）
- `AgentError` が thrown されるケース: (a) LLM 空レスポンス、(b) JSON parse 失敗、(c) schema validation 失敗
- `loadActivePrompt` が `ConfigError` を throw した場合は透過される（テストで確認）

**テスト**
- `packages/agents/src/optimizer/index.test.ts` を新規作成
- モック `createAgentClient` が `LLMCompleteResult` を返すスタブを用意
- 正常系: `OptimizerOutput` が返る
- 異常系: 不正 JSON → `AgentError`

---

### T-11-02 `optimizer.prompt.generate` ワーカータスク本実装

**目的**
`apps/worker/src/tasks/optimizer-prompt-generate.ts` のプレースホルダを本実装に置き換える。
SP-10 の `pipeline-book-judge.ts` と同パターン (payload zod parse → 冪等性チェック → CAS → エージェント呼出 → DB 書き込み → notifyJobChange) で実装する。

**対象ファイル**
- `apps/worker/src/tasks/optimizer-prompt-generate.ts` (既存 placeholder → 本実装)

**参照設計書**
- `docs/05 §5.3.11` `optimizer.prompt.generate` 仕様
- `docs/05 §6.3.7` OptimizerInput/Output 定義
- `apps/worker/src/tasks/pipeline-book-judge.ts` — タスク構造の手本
- `packages/agents/src/optimizer/index.ts` (T-11-01 成果物)
- `packages/contracts/agents/optimizer.ts` (T-11-01 成果物)

**実装指示**

1. `OptimizerPromptGeneratePayloadSchema` を定義:

```typescript
export const OptimizerPromptGeneratePayloadSchema = z.object({
  trigger: z.enum(['cron_10_books', 'manual']),
  role: z.enum(['marketer','writer','editor','judge','thumbnail_text','optimizer']).optional(),
  genre: z.string().optional(),
  job_id: z.string(),
});
```

2. `runOptimizerPromptGenerate` 関数のフロー:

```
A. payload zod parse (ValidationError)
B. 冪等性チェック: Job.status='done' なら skip
C. CAS: queued/failed → running
D. role・genre が未指定なら「スコア傾向が最も悪い role×genre」を eval_results から取得
   → 直近 10 冊の eval_results を `role` なし全体で集計し、role×genre 別スコア平均が最低のものを選択
E. 現在の active prompt (role, genre) を取得 → ConfigError if not found
F. 直近 10 冊の eval_results (role の prompt_version_id が current prompt に一致する範囲) を取得
   → sales_records も JOIN
G. optimizePrompt(input, { ... }) 呼出
   → LoggingContext: { role: 'optimizer', jobId: payload.job_id }  ※ bookId=null
H. PromptProposal INSERT (status='pending')
I. Job.status='done', result_json に proposal_id
J. notifyJobChange (ADR-001: channel='jobs')
```

3. `OptimzerPromptGeneratePrisma` interface: `job`, `prompt`, `promptProposal`, `evalResult`, `salesRecord` の最小サブセットを定義。

4. DI deps: `prisma?`, `logger?`, `optimizePrompt?`, `now?`, `notifyJobChange?`。テストで `optimizePrompt` をスタブ化できる。

5. graphile-worker エクスポート:
```typescript
export const optimizerPromptGenerateTask: Task = async (payload, helpers) => {
  await runOptimizerPromptGenerate(payload, helpers.addJob as AddJobLike);
};
```

6. `apps/worker/src/index.ts` の taskList に `optimizer.prompt.generate` を追加（プレースホルダから差し替え）。

**受け入れ基準**
- `runOptimizerPromptGenerate` をモック deps で呼んだとき `promptProposal.create` が 1 回呼ばれる (Vitest)
- `trigger='manual'` かつ `role` 指定あり → 指定 role のみで eval_results を絞り込む
- `trigger='cron_10_books'` かつ `role` 未指定 → 自動で最低スコア role を選択
- `Job.status='done'` の冪等性チェックが通る
- token_usage に `role='optimizer'`, `book_id=null` で 1 行 INSERT される (Vitest モック確認)

**テスト**
- `apps/worker/src/tasks/optimizer-prompt-generate.test.ts` を新規作成
- 正常系: PromptProposal が INSERT され Job が done に遷移
- 異常系: active prompt が見つからない → ConfigError が throw、Job が failed

---

### T-11-03 10 冊出版完了トリガー配線

**目的**
`pipeline.book.export` タスク完了後に、直近 10 冊 (status='done') の件数を判定し、10 の倍数に達したら `optimizer.prompt.generate` を enqueue する。

**対象ファイル**
- `apps/worker/src/tasks/pipeline-book-export.ts` (既存 — 末尾に hook 追加)

**参照設計書**
- `docs/05 §5.3.11` `optimizer.prompt.generate` — "10 冊出版完了をフックとする trigger は `pipeline.book.export` 完了時に件数判定して enqueue"
- `docs/05 §5.3.4` `pipeline.book.export` 仕様

**実装指示**

1. `pipeline-book-export.ts` の正常完了後 (Job.status='done' 更新直後) に以下を追加:

```typescript
// 10 冊出版完了トリガー: done 冊数が 10 の倍数なら optimizer を enqueue
const doneCount = await prisma.book.count({ where: { status: 'done' } });
if (doneCount > 0 && doneCount % 10 === 0) {
  const optimizerJob = await prisma.job.create({
    data: {
      kind: OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
      book_id: null,
      status: 'queued',
      payload_json: {
        trigger: 'cron_10_books',
        job_id: '<job_id>',  // 実際は create の返値 ID を使う
      },
    },
  });
  await addJob(
    OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
    { trigger: 'cron_10_books', job_id: optimizerJob.id },
    { maxAttempts: 2 },
  );
}
```

2. 冪等性: 既に `optimizer.prompt.generate` の Job が `queued` または `running` の状態で存在する場合は enqueue をスキップ（重複防止）。

3. DI 対応: `deps.skipOptimizerTrigger?: boolean` フラグを追加し、既存テストが壊れないようにする。

4. `OPTIMIZER_PROMPT_GENERATE_TASK_NAME` を `optimizer-prompt-generate.ts` からインポート。

**受け入れ基準**
- `doneCount=10` のとき `addJob('optimizer.prompt.generate', ...)` が 1 回呼ばれる (Vitest)
- `doneCount=11` のときは呼ばれない
- `doneCount=20` のとき再度呼ばれる
- 既存 Job が queued/running のときは重複 enqueue しない

**テスト**
- `apps/worker/src/tasks/pipeline-book-export.test.ts` に件数判定ロジックのテストを追記
- `doneCount` が 10, 11, 20 の各ケースをモックで検証

---

### T-11-04 プロンプト承認/ロールバック SA + core ロジック

**目的**
`decideProposal` (承認・却下・編集して承認) と `rollbackAutoApproved` (24h 以内のロールバック) の Server Action と core ロジックを実装する。
両 SA は `audit_log` 記録必須 (`docs/05 §13 申し送り 4` / `docs/dev-plan.md §9.2 申し送り 4`)。

**対象ファイル**
- `apps/web/lib/prompt-proposals-core.ts` (新規)
- `apps/web/app/actions/prompt-proposals.ts` (新規)
- `packages/contracts/api/prompt-proposals.ts` (新規 — zod schema)

**参照設計書**
- `docs/05 §4.3.12` `decideProposal` / `rollbackAutoApproved` 仕様
- `apps/web/lib/settings-core.ts` — core パターンの手本
- `apps/web/app/actions/settings.ts` — SA ラッパパターンの手本
- `docs/05 §3 PromptProposal` スキーマ (`status: 'pending'|'approved'|'rejected'|'auto_approved'`, `rollback_until`)
- `docs/05 §3 Prompt` スキーマ (`status: 'active'|'archived'`, `activated_at`, `archived_at`)
- `docs/05 §3 AuditLog` スキーマ

**実装指示**

1. `packages/contracts/api/prompt-proposals.ts`:

```typescript
export const DecideProposalInputSchema = z.object({
  proposal_id: z.string().min(1),
  decision: z.enum(['approve', 'reject', 'edit_and_approve']),
  edited_body: z.string().optional(),  // edit_and_approve 時必須
  rejection_note: z.string().max(1000).optional(),
});
export type DecideProposalInput = z.infer<typeof DecideProposalInputSchema>;

export const RollbackAutoApprovedInputSchema = z.object({
  proposal_id: z.string().min(1),
});
export type RollbackAutoApprovedInput = z.infer<typeof RollbackAutoApprovedInputSchema>;
```

2. `apps/web/lib/prompt-proposals-core.ts` に `decideProposalCore(input, deps)` を実装:

**承認フロー (approve / edit_and_approve)**:
- `edit_and_approve` なら `edited_body` が必須（ValidationError）
- 現在の active Prompt (role, genre) を取得 → `archived` に遷移（`archived_at = now()`）
- 新 Prompt INSERT: `body = edited_body ?? proposal.proposed_body`, `status='active'`, `version = current.version + 1`, `created_by = 'optimizer:<proposal_id>'`, `activated_at = now()`
- PromptProposal UPDATE: `status='approved'`, `decided_by = session.user.id`, `decided_at = now()`
- AuditLog INSERT: `action='prompt.approve'`, `target_kind='prompt_proposal'`, `target_id=proposal_id`, `before_json={status:'pending'}`, `after_json={status:'approved', new_prompt_id}`
- `revalidatePath('/prompts')` / `revalidatePath('/prompts/proposals')`

**却下フロー (reject)**:
- PromptProposal UPDATE: `status='rejected'`, `decided_by`, `decided_at`, `rejection_note`
- AuditLog INSERT: `action='prompt.reject'`

**エラーハンドリング**:
- `proposal.status !== 'pending'` → `fail('conflict', '既に処理済みの提案です')`
- `proposal` が見つからない → `fail('not_found', '提案が存在しません')`

3. `apps/web/lib/prompt-proposals-core.ts` に `rollbackAutoApprovedCore(input, deps)` を実装:

**ロールバックフロー**:
- PromptProposal を取得、`status='auto_approved'` かつ `rollback_until > now()` であること（条件不成立なら `fail('conflict', ...)`）
- 現在の active Prompt (role, genre) を取得 → `status='archived'`
- 1 つ前のバージョン (承認前の Prompt) を `status='active'` に復元
- PromptProposal UPDATE: `status='rejected'`, `decided_by`, `decided_at`, `rejection_note='ロールバック'`
- AuditLog INSERT: `action='prompt.rollback'`

4. `apps/web/app/actions/prompt-proposals.ts` (SA ラッパ — `'use server'`):
- `getSessionOrThrow()` で認証
- core 呼出 → `ActionResult` を返す
- settings.ts と同パターン

**受け入れ基準**
- `decideProposalCore({ decision: 'approve', ... })` 呼出後、新 Prompt が `active`、旧 Prompt が `archived`、PromptProposal が `approved`、AuditLog が 1 行 INSERT (Vitest)
- `decideProposalCore({ decision: 'reject', ... })` 後、PromptProposal が `rejected`、audit_log に `action='prompt.reject'`
- `rollbackAutoApprovedCore` で `rollback_until < now()` の場合 `fail('conflict', ...)` を返す (Vitest)
- `rollback_until > now()` の場合、active Prompt が旧版に戻り audit_log に `action='prompt.rollback'`
- 未認証呼出は `getSessionOrThrow()` が AuthError を throw し SA が `fail('unauthorized', ...)` を返す

**テスト**
- `apps/web/lib/prompt-proposals-core.test.ts` を新規作成
- `now` DI で時刻を固定: ロールバック猶予内/外のケースを各 1 件

---

### T-11-05 自動承認判定 (`checkAutoApproval`) + `rollback_until` 設定

**目的**
`optimizer.prompt.generate` タスク完了後 (PromptProposal INSERT 直後) に、F-030 の自動承認条件を評価し、
条件成立時は `decideProposal(auto_approve)` 相当のフローを worker 内で実行する。
`rollback_until = now() + rollback_h 時間` を設定する。時刻依存はテスト可能な形で DI する。

**対象ファイル**
- `apps/worker/src/lib/auto-approval.ts` (新規 — 判定ロジック)
- `apps/worker/src/tasks/optimizer-prompt-generate.ts` (T-11-02 成果物に hook 追加)

**参照設計書**
- `docs/02 F-030` 受け入れ基準: 「5 冊連続スコア改善が観測された時のみ自動承認」「24 時間以内にロールバック可能」「設定で切替可能（既定: 手動）」
- `docs/05 §3 AppSettings`: `prompt_auto_approval_enabled`, `prompt_auto_approval_rollback_h`
- `docs/05 §3 PromptProposal`: `status='auto_approved'`, `rollback_until`
- T-11-04 成果物 (`decideProposalCore` の auto_approve パス)

**実装指示**

1. `apps/worker/src/lib/auto-approval.ts` に判定関数を実装:

```typescript
export interface AutoApprovalDeps {
  prisma?: AutoApprovalPrisma; // evalResult.findMany, appSettings.findUnique, prompt.findMany
  now?: () => Date;
}

/**
 * F-030 自動承認判定。
 * 条件: AppSettings.prompt_auto_approval_enabled=true かつ
 *       proposal の role×genre に関する直近 5 冊のスコアが、
 *       前バージョン (source_prompt_id) 使用冊と比較して連続改善している。
 *
 * 「連続改善」の定義:
 *   - proposal 承認後に生成された書籍のうち、この prompt_version を使った直近 5 冊のスコア系列が
 *     単調増加 (score[i+1] >= score[i]) であること。
 *   - まだ 5 冊蓄積されていない場合は条件不成立 (pending 維持)。
 *
 * 本タスク (T-11-05) では「Optimizer が提案を生成した直後」に呼ぶ (0 冊時点) ため、
 * 通常は条件不成立。実際の自動承認はパイプラインの pipeline.book.export 完了後に
 * 定期的 (または T-11-03 フックから) 呼ぶ設計が正しいが、SP-11 スコープでは
 * checkAutoApproval を export し、テストで「5 冊連続改善」モックを作れることを確認する。
 *
 * @returns { shouldAutoApprove: boolean; rollback_until?: Date }
 */
export async function checkAutoApproval(
  proposalId: string,
  deps?: AutoApprovalDeps,
): Promise<{ shouldAutoApprove: boolean; rollback_until?: Date }>
```

2. チェックフロー:
   - `AppSettings.prompt_auto_approval_enabled` が `false` → `{ shouldAutoApprove: false }` を返す
   - proposal の `source_prompt_id` から `role`, `genre` を取得
   - `eval_results` から「この proposal が承認された後の新 prompt_version を使った書籍」のスコアを時系列取得（まだ 0 件なので通常 false）
   - 5 件 AND スコア系列が単調増加 → `shouldAutoApprove: true, rollback_until: new Date(now() + rollback_h * 3600_000)`
   - 条件不成立 → `{ shouldAutoApprove: false }`

3. 自動承認が成立した場合のフロー (worker 内で実行):
   - Prompt 新バージョン INSERT + 旧版 archived (T-11-04 と同ロジックを worker 用 helper として共有 or 複製)
   - PromptProposal UPDATE: `status='auto_approved'`, `decided_by='auto'`, `decided_at=now()`, `rollback_until`
   - AuditLog INSERT: `actor_id=null`, `action='prompt.approve'` (auto 経由を `before_json.trigger='auto'` で区別)

4. `apps/worker/src/tasks/optimizer-prompt-generate.ts` (T-11-02) の末尾に `checkAutoApproval` 呼出を追加:

```typescript
const approvalCheck = await checkAutoApproval(proposalId, { prisma, now });
if (approvalCheck.shouldAutoApprove) {
  // 自動承認フロー
  ...
}
```

**受け入れ基準**
- `prompt_auto_approval_enabled=false` のとき常に `{ shouldAutoApprove: false }` (Vitest)
- `prompt_auto_approval_enabled=true` かつ `eval_results` が 5 件でスコア単調増加 → `shouldAutoApprove=true`, `rollback_until` が `now + rollback_h 時間` (Vitest で `now` を固定)
- `eval_results` が 4 件のとき → `shouldAutoApprove=false`
- `eval_results` のスコアが途中で減少 → `shouldAutoApprove=false`
- 自動承認成立時、`PromptProposal.status='auto_approved'`, `rollback_until` が設定される (Vitest)

**テスト**
- `apps/worker/src/lib/auto-approval.test.ts` を新規作成
- `now` DI で固定時刻を使用 (例: `new Date('2026-06-15T00:00:00Z')`)
- 5 ケース: enabled=false / 件数不足 / スコア非単調 / 正常自動承認 / rollback_until の値検証

---

### T-11-06 プロンプト A/B 配信 SA + `books.prompt_version_ids_json` 割当

**目的**
`startAbDistribution` SA (F-031) を実装し、次の書籍キックアップ時に `books.prompt_version_ids_json` に乱数で baseline/candidate どちらかの prompt_id を割り当てる仕組みを実装する。
乱数はテスト時に決定的になるよう DI する。

**対象ファイル**
- `apps/web/lib/ab-distribution-core.ts` (新規)
- `apps/web/app/actions/prompts.ts` (既存 — `startAbDistribution` 追加)
- `apps/worker/src/tasks/pipeline-book-kickoff.ts` (既存 — A/B 割当 hook 追加)

**参照設計書**
- `docs/05 §4.3.11` `startAbDistribution` 仕様
- `docs/02 F-031` 受け入れ基準: 「書籍ごとに乱数でどちらかを採用。`books.prompt_version_id` に記録」「最低 10 冊蓄積後に統計検定の結果を表示」
- `docs/05 §3 Book.prompt_version_ids_json`: `Record<role, prompt_id>`

**実装指示**

1. A/B 配信の状態を `AppSettings` や専用テーブルではなく `Prompt` に付属する情報で管理する方式を採用:

- `startAbDistribution` SA が呼ばれると、以下を DB に保存:
  - `app_settings` の JSON 列 `ab_distribution_json` (既存の `notification_kinds_json` と同様の追加列) ... ただし `AppSettings` に新列を追加するマイグレーションは不要。代わりに **別テーブル `AbDistribution` を追加しない** (スコープ外) とし、`prompt_proposals` テーブルに `ab_config_json` (nullable JSON) 列を手書きマイグレーションで追加する方式とする。

**再考: スコープを絞る。**
`F-031` は P1（重要だが代替手段あり）のため、SP-11 では以下の最小実装とする:
- `startAbDistribution` SA は `PromptProposal.ab_config_json` ではなく、シンプルに **`AppSettings` の `notification_kinds_json` 相当の汎用 JSON 列** に書くのではなく、**新規 `active_ab_distribution` テーブルを作らず**、`prompts` テーブルの既存列の組み合わせで表現する。

**最終方針**: F-031 A/B 配信は以下の方式とする:
- `apps/web/lib/ab-distribution-core.ts` で `AbDistributionConfig` 型 (`{ role, genre, baseline_id, candidate_id, ratio_candidate }`) を定義。
- DB 永続化は既存 `AppSettings` の JSON 列ではなく、**`Prompt` テーブルの `placeholders_json` 列に `ab_partner_id` キーを追加** する方式は避け、SP-11 スコープでは **インメモリ（worker 起動時に `AppSettings` から読む）** で運用する。
- `AppSettings` は既に `notification_kinds_json` が `Json` 型なので、SP-11 では `notification_kinds_json` ではなく **`app_settings` テーブルに `ab_distribution_json` 列 (`Json?`) を Prisma マイグレーションで追加** する。これが最もシンプル。

**手順**:

1. `packages/db/schema.prisma` の `AppSettings` モデルに追加:

```prisma
ab_distribution_json Json? // type: Array<{ role, genre, baseline_id, candidate_id, ratio_candidate }>
```

2. Prisma マイグレーション作成: `npx prisma migrate dev --name add_ab_distribution_to_app_settings`

3. `apps/web/lib/ab-distribution-core.ts` に以下を実装:
   - `startAbDistributionCore(input, deps)`: `AppSettings.ab_distribution_json` に配列形式で upsert（同 role×genre はアップサート）
   - `getAbDistributionForRole(role, genre, deps)`: 現在の配信設定を返す
   - `selectPromptId(role, genre, rand, deps)`: `rand` (0..1 の乱数、DI で決定的に) を使い baseline/candidate を選択

4. `apps/web/app/actions/prompts.ts` に `startAbDistribution` を追加（T-11-04 パターン）。

5. `apps/worker/src/tasks/pipeline-book-kickoff.ts` の Book 生成直前:
   - `getAbDistributionForRole(role, genre, ...)` を role ごとに呼ぶ
   - A/B 設定がある role は `selectPromptId` (乱数は `deps.rand ?? Math.random()`) で prompt_id を決定
   - `books.prompt_version_ids_json` に記録

**受け入れ基準**
- `startAbDistributionCore({ role:'writer', genre:'business', baseline_id, candidate_id, ratio_candidate:0.5 })` 後、`AppSettings.ab_distribution_json` に配信設定が保存される (Vitest)
- `selectPromptId('writer', 'business', 0.4, ...)` → `ratio_candidate=0.5` なら `candidate_id` が返る (rand < 0.5 → candidate)
- `selectPromptId('writer', 'business', 0.6, ...)` → `baseline_id` が返る
- A/B 設定がない role は既存の active prompt_id がそのまま使われる
- Prisma マイグレーションが clean に通る (`npx prisma migrate dev` エラーなし)

**テスト**
- `apps/web/lib/ab-distribution-core.test.ts` を新規作成
- `rand` を 0.0, 0.4, 0.5, 0.9 でテスト

---

### T-11-07 S-023 プロンプト改訂承認 UI (`/prompts/proposals/page.tsx`)

**目的**
S-023 プロンプト改訂承認画面を実装する。RSC でデータ取得 + SA 呼出で承認/却下/ロールバック操作を提供する。
ワイヤーフレーム `docs/wireframes/S-023-prompt-approval/prompt.md` を必ず参照すること。

**対象ファイル**
- `apps/web/app/(app)/prompts/proposals/page.tsx` (新規 — RSC)
- `apps/web/lib/prompt-proposals-view.ts` (新規 — RSC 用データ整形)
- `apps/web/components/prompt-proposals/proposals-table.tsx` (新規)
- `apps/web/components/prompt-proposals/proposal-detail.tsx` (新規)
- `apps/web/components/prompt-proposals/diff-viewer.tsx` (新規)
- `apps/web/components/prompt-proposals/auto-approval-status-bar.tsx` (新規)
- `apps/web/components/prompt-proposals/action-bar.tsx` (新規)

**参照設計書**
- `docs/04 §4 S-023` 画面設計
- `docs/wireframes/S-023-prompt-approval/prompt.md` (デザイン詳細)
- `docs/02 F-029` / `F-030` 受け入れ基準
- T-11-04 成果物 (`decideProposal`, `rollbackAutoApproved` SA)
- T-11-05 成果物 (`checkAutoApproval` — `auto_approval_status` の UI 表示用)

**実装指示**

1. `apps/web/lib/prompt-proposals-view.ts`:

```typescript
export interface ProposalListItem {
  id: string;
  role: string;
  genre: string | null;
  source_version: number;
  status: string;
  rationale: string;
  expected_effect_json: unknown;
  created_at: string;
}

export interface ProposalDetail extends ProposalListItem {
  proposed_body: string;
  diff: string;
  sample_output: string | null;
  source_prompt_body: string;
  rollback_until: string | null; // ISO8601
}

export interface AutoApprovalStatus {
  enabled: boolean;
  rollback_h: number;
}

export async function listProposals(prisma: PrismaClient): Promise<ProposalListItem[]>
export async function getProposalDetail(id: string, prisma: PrismaClient): Promise<ProposalDetail | null>
export async function getAutoApprovalStatus(prisma: PrismaClient): Promise<AutoApprovalStatus>
```

2. `apps/web/app/(app)/prompts/proposals/page.tsx` (RSC):
- `getSessionOrThrow()` で認証確認（未ログインなら `/login` リダイレクト）
- `listProposals(prisma)` と `getAutoApprovalStatus(prisma)` を並列 `Promise.all` で取得
- `<AutoApprovalStatusBar status={autoApprovalStatus} />` を上部に表示
- `<ProposalsTable proposals={proposals} />` で一覧表示
- URL クエリ `?id=...` で `<ProposalDetail proposal={detail} />` を右カラムに表示
- 日本語 UI (`Hard Rule 2`): 全ラベルを日本語に

3. `diff-viewer.tsx`:
- `diff` 文字列 (unified diff 形式) を `+` / `-` 行でカラーリング (shadcn/ui の `Card` 内、等幅フォント)
- 削除行: 薄赤背景、`-` プレフィックス
- 追加行: 薄緑背景、`+` プレフィックス

4. `auto-approval-status-bar.tsx`:
- ワイヤーフレーム S-023 の `AutoApprovalStatusBar` に対応
- 「自動承認モード: 手動 / 自動」トグル → S-027 設定画面へリンク
- 「直近 5 冊スコア改善中: N / 5」進捗バー (Phase 2 では `eval_results` から計算 — RSC で取得)

5. `action-bar.tsx`:
- `[ 承認 ]`, `[ 編集して承認 ]`, `[ 却下 (コメント必須) ]`, `[ ロールバック (24h 以内のみ) ]`
- ロールバックボタンは `rollback_until` が未来のときのみ active
- 却下ダイアログ: textarea で `rejection_note` 入力必須
- 編集して承認ダイアログ: textarea でプロンプト本文を編集

**受け入れ基準**
- `/prompts/proposals` にアクセスして提案一覧が表示される (Playwright E2E で確認)
- 承認ボタンを押したあと、提案のステータスが `approved` に変わり、新 Prompt が active になる (E2E)
- 却下は `rejection_note` 未入力でバリデーションエラー (UI テスト)
- `auto_approved` かつ `rollback_until` が過去の場合、ロールバックボタンが disabled
- 提案がない場合、EmptyState が表示される (ワイヤーフレーム `empty.png` 相当)

**テスト**
- Vitest: `prompt-proposals-view.ts` のデータ整形関数を DB モックで単体テスト
- Playwright: T-11-09 (UC-03 E2E) でカバー

---

### T-11-08 S-022 プロンプト管理 UI 拡張 (A/B 配信タブ追加)

**目的**
既存の S-022 プロンプト管理画面 (`/prompts/page.tsx`) に A/B 配信設定タブを追加する (F-031)。
ワイヤーフレーム `docs/wireframes/S-022-prompt-management/prompt.md` のタブ 3「A/B 配信設定」を実装する。

**対象ファイル**
- `apps/web/app/(app)/prompts/page.tsx` (既存 — A/B タブ追加)
- `apps/web/lib/prompts-view.ts` (既存 or 新規 — A/B 配信設定の表示用データ関数追加)
- `apps/web/components/prompts/ab-distribution-form.tsx` (新規)

**参照設計書**
- `docs/wireframes/S-022-prompt-management/prompt.md` Section 5「A/B 配信設定（タブ 3）」
- T-11-06 成果物 (`startAbDistribution` SA, `getAbDistributionForRole`)
- `docs/02 F-031` 受け入れ基準

**実装指示**

> 注: `/prompts/page.tsx` が Phase 1 でどこまで実装されているか確認してから着手する。
> Phase 1 (SP-04) で `F-027`, `F-028` の一覧・バージョン履歴は実装済みのはず。

1. `/prompts/page.tsx` の既存タブ構造に「A/B 配信設定」タブを追加。

2. `ab-distribution-form.tsx`:
- `baseline_id` セレクト (`[v11 ▾]`): 同 role×genre の archived prompt を列挙
- `candidate_id` セレクト (`[v12 ▾]`): 同 role×genre の archived/active prompt を列挙
- `ratio_candidate` スライダー (0.0 〜 1.0, ステップ 0.1, 既定 0.5)
- `[ A/B 配信を開始 ]` ボタン → `startAbDistribution` SA 呼出
- 配信中の場合は現在の設定を表示 + `[ A/B 配信を停止 ]` ボタン (停止時は `baseline_id` のみが選ばれるよう `ratio_candidate=0` で上書き)

3. 日本語 UI: ラベルはすべて日本語。「配信比率」「基準版」「候補版」

4. `[ A/B 統計結果へ ]` リンク: SP-13 (A/B 比較ビュー, S-021) が未実装のため、非活性状態またはグレーアウトで表示（リンク先は `/models/ab`）

**受け入れ基準**
- `/prompts` ページに「A/B 配信設定」タブが追加されている
- `startAbDistribution` SA 呼出後、`AppSettings.ab_distribution_json` が更新される
- スライダー値 0.5 が UI に反映される
- 既存タブ「現行本文」「過去バージョン」は壊れていない (回帰テスト)

**テスト**
- Vitest: `ab-distribution-form` の submit ハンドラ単体テスト（モック SA で検証）
- 既存プロンプト管理 UI のスモークテストが引き続き通ること

---

### T-11-09 E2E テスト: UC-03 プロンプト改訂サイクル

**目的**
`tests/e2e/uc03-prompt-optimizer.spec.ts` を実装し、Playwright でプロンプト改訂サイクル全体 (UC-03) を検証する。
LLM 実 API は不要とし、msw または graphile-worker ジョブをシードデータで代替する。

**対象ファイル**
- `tests/e2e/uc03-prompt-optimizer.spec.ts` (新規)
- `tests/fixtures/prompt-optimizer-seed.ts` (新規 — DB seed / msw ハンドラ)

**参照設計書**
- `docs/05 §9 E2E テスト計画` `uc03-prompt-optimizer.spec.ts`
- `docs/04 §2.2 UC-03`: S-002 → S-023 → S-022 → S-029
- T-11-04, T-11-05, T-11-07 成果物

**実装指示**

1. `tests/fixtures/prompt-optimizer-seed.ts`:
- `eval_results` 10 件を DB に直接 INSERT (テスト用 Prisma クライアント使用)
- `prompt_proposals` 1 件 (status='pending') を INSERT
- 必要な `Prompt` (active, role='writer', genre='business') を INSERT

2. `uc03-prompt-optimizer.spec.ts`:

```typescript
// UC-03 画面シーケンス: S-002 → S-023 → S-022 → S-029
test.describe('UC-03 プロンプト改訂サイクル', () => {
  test.beforeEach(async ({ page }) => {
    // seed DB + ログイン
    await seedDb();
    await page.goto('/login');
    await page.fill('[name=username]', 'admin');
    await page.fill('[name=password]', process.env.ADMIN_PASSWORD!);
    await page.click('[type=submit]');
    await page.waitForURL('/dashboard');
  });

  test('改訂提案を手動承認してプロンプトが切り替わる', async ({ page }) => {
    // S-023 改訂承認ページに遷移
    await page.goto('/prompts/proposals');
    // 提案一覧に 1 件表示
    await expect(page.getByTestId('proposals-table')).toContainText('Writer');
    // 提案を選択してアクション
    await page.getByTestId('proposal-row-0').click();
    // diff ビューアーが表示される
    await expect(page.getByTestId('diff-viewer')).toBeVisible();
    // 承認ボタン
    await page.getByRole('button', { name: '承認' }).click();
    // 承認完了
    await expect(page.getByTestId('toast-success')).toBeVisible();
    // 提案が 'approved' になる
    await expect(page.getByTestId('proposal-status-0')).toHaveText('承認済み');
    // S-022 に移動してバージョン履歴を確認
    await page.goto('/prompts');
    await expect(page.getByTestId('prompt-version')).toContainText('v');
  });

  test('自動承認済み提案を 24h 以内にロールバックできる', async ({ page }) => {
    // seed: status='auto_approved', rollback_until = now + 12h
    await seedAutoApprovedProposal({ rollback_until_offset_h: 12 });
    await page.goto('/prompts/proposals');
    await page.getByTestId('proposal-row-0').click();
    // ロールバックボタンが active
    await expect(page.getByRole('button', { name: 'ロールバック' })).toBeEnabled();
    await page.getByRole('button', { name: 'ロールバック' }).click();
    await expect(page.getByTestId('toast-success')).toBeVisible();
  });

  test('24h 経過後はロールバックボタンが disabled', async ({ page }) => {
    // seed: status='auto_approved', rollback_until = now - 1h (過去)
    await seedAutoApprovedProposal({ rollback_until_offset_h: -1 });
    await page.goto('/prompts/proposals');
    await page.getByTestId('proposal-row-0').click();
    await expect(page.getByRole('button', { name: 'ロールバック' })).toBeDisabled();
  });

  test('監査ログに承認操作が記録される', async ({ page }) => {
    // 承認後 S-029 監査ログで確認
    await page.goto('/prompts/proposals');
    await page.getByTestId('proposal-row-0').click();
    await page.getByRole('button', { name: '承認' }).click();
    await page.goto('/audit');
    await expect(page.getByTestId('audit-log-table')).toContainText('prompt.approve');
  });
});
```

3. msw ハンドラ: `optimizePrompt` への LLM コールはモック (graphile-worker は使わず、seed で PromptProposal を直接 INSERT)。

**受け入れ基準**
- `pnpm exec playwright test uc03` で全 4 テストが PASS
- ロールバック猶予内: ロールバックボタン active + 実行後 active Prompt が旧版に戻る
- ロールバック猶予外: ロールバックボタン disabled
- 監査ログに `action='prompt.approve'` が記録される

**テスト**
- E2E spec が PASS すること (完了判定の主要基準)

---

## 6. テスト計画

| テスト種別 | 対象 | ファイル | 検証内容 |
|---|---|---|---|
| Vitest unit | Optimizer エージェント | `packages/agents/src/optimizer/index.test.ts` | 正常系・AgentError ケース・token_usage モック |
| Vitest unit | `optimizerPromptGenerateTask` | `apps/worker/src/tasks/optimizer-prompt-generate.test.ts` | PromptProposal INSERT・冪等性・role 自動選択 |
| Vitest unit | 10 冊トリガー | `apps/worker/src/tasks/pipeline-book-export.test.ts` (追記) | doneCount 10/11/20 ケース |
| Vitest unit | `decideProposalCore` | `apps/web/lib/prompt-proposals-core.test.ts` | 承認・却下・edit_and_approve・audit_log |
| Vitest unit | `rollbackAutoApprovedCore` | `apps/web/lib/prompt-proposals-core.test.ts` | 24h 内外・audit_log |
| Vitest unit | `checkAutoApproval` | `apps/worker/src/lib/auto-approval.test.ts` | enabled/disabled・5 件連続改善各ケース |
| Vitest unit | `startAbDistributionCore` + `selectPromptId` | `apps/web/lib/ab-distribution-core.test.ts` | 乱数 DI・ratio 境界値 |
| Playwright E2E | UC-03 全シーケンス | `tests/e2e/uc03-prompt-optimizer.spec.ts` | 手動承認・自動承認ロールバック・監査ログ |

---

## 7. 完了判定

以下の全条件を満たした時点で `pm MODE: REVIEW TARGET: SP-11` を実行し `## PHASE_COMPLETE` を確認する。

1. 全タスク (T-11-01 〜 T-11-09) のステータスが「完了」に更新されていること
2. 各タスクの受け入れ基準を満たす実装・テストが存在すること (Glob/Grep で確認)
3. `pnpm test` (Vitest) が全件 PASS (新規テスト + 既存回帰テスト)
4. `pnpm exec playwright test uc03` が PASS
5. 以下の機能実証が完了していること:
   - Optimizer エージェントが `withTokenLogging` 経由で `token_usage` に `role='optimizer'` を記録する
   - `decideProposal('approve')` で `audit_log.action='prompt.approve'` が記録される
   - `rollbackAutoApproved` で `audit_log.action='prompt.rollback'` が記録される
   - A/B 配信設定後、`pipeline.book.kickoff` が乱数で `baseline_id` / `candidate_id` を割り当てる
6. Hard Rule 4 (プロンプト DB 格納): Optimizer のシステムプロンプトが `prompts` テーブルに seed されること
7. Hard Rule 5 (token_usage 観測): `optimizePrompt` 呼出が必ず `withTokenLogging` を通ること (CI grep チェック)
8. `docs/dev-plan.md §9.2 申し送り 4` の「SP-11 プロンプト承認が `audit_log` 対象」が実装に反映されていること

---

## 8. 申し送り (次スプリントへ)

- **SP-12 (sales-auto-fetch)**: `sales_records` の自動取得完了後、`checkAutoApproval` の `recent_sales` が実データで埋まる。SP-12 完了後に自動承認精度が向上する。
- **SP-13 (ab-comparison-cost-tune)**: F-026 A/B 比較ビュー (S-021) は SP-13 で実装。SP-11 では `/models/ab` へのリンクをグレーアウトで仮置き。
- **Optimizer シードプロンプト**: `packages/db/seed.ts` に `role='optimizer'` のシードプロンプトを追加すること (T-11-01 受け入れ基準だが、seed スクリプトへの追記を T-11-01 作業者が行う)。
