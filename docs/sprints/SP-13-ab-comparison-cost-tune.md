# SP-13 ab-comparison-cost-tune (Phase 2)

> Phase 2 最終スプリント。SP-10/SP-11/SP-12 `PHASE_COMPLETE` 後に着手。
> 完了確認: `pm MODE: REVIEW TARGET: SP-13` で `## PHASE_COMPLETE` 出力が完了基準。

---

## 1. 目的

モデル A/B 比較ビュー (F-026 / S-021) を本実装し、Prompt Caching (`cache_control`) を
`AgentSdkClient` / `AISdkClient` に導入する。SP-11 で実装した A/B 配信
(`app_settings.ab_distribution_json` / `books.prompt_version_ids_json` + `model_assignment_snapshot`)
のデータを baseline vs candidate 粒度で集計し、運営者がコスト最適化判断を下せる状態を作る。

**自律実装・テスト可能層（本スプリントで完成させる）**:
- S-021 比較フォーム + KPI カード + ボックスプロット相当の SVG グラフ + 書籍リスト
- 比較集計 RSC クエリ (`packages/db/src/ab-comparison.ts`)
- Prompt Caching (`cache_control: { type: "ephemeral" }`) を `AgentSdkClient`（Writer/Editor 経路の Anthropic）と
  `AISdkClient` の Anthropic プロバイダ経路に実装 + 単体テスト
- `TokenUsage.cached_input_tokens` の既存列を活用したキャッシュ節約額可視化
- サイドバー `/models/ab` リンクを `enabled: true` に切替
- Vitest 単体テスト + Playwright E2E (UC-02 Phase 2 版)

**人間/実環境ゲート（コード完了条件に含めない）**:
- 「月額コストが Phase 1 から有意に低下」の実測確認
- Prompt Caching 採用/非採用の本番判断と dev-plan 意思決定ログへの記録
- Writer × ジャンルの Gemini Flash 切替の実データ実測
- これらは T-09-08 同種の人間タスクとして §8 申し送りに記載

---

## 2. 対応機能 ID

| 機能 ID | 機能名 | 優先度 |
|---|---|---|
| F-026 | モデル切替前後のコスト/品質 A/B 比較ビュー | P1 |
| OQ-07 | Prompt Caching 採用判断 | — |

関連画面: **S-021** モデル A/B 比較ビュー
参照ドキュメント: `docs/04 §S-021`, `docs/05 §15.1 F-026`, `docs/02 §F-026 / UC-02`

---

## 3. 前提確認

| 確認項目 | 状況 |
|---|---|
| `TokenUsage.cached_input_tokens` 列 | 既存（`schema.prisma` 実装済み）。追加マイグレーション不要 |
| `books.prompt_version_ids_json` | SP-11 T-11-06 で実装済み |
| `books.model_assignment_snapshot` | Phase 1 で実装済み |
| `app_settings.ab_distribution_json` | SP-11 T-11-06 で実装済み |
| `EvalResult.score_total` | SP-10 で実装済み |
| `SalesRecord.royalty_jpy` | SP-08/SP-12 で実装済み |
| `AgentSdkClient` の `cache_read/creation_input_tokens` 受け取り | `toLLMUsage()` で実装済み（`cachedInputTokens` に集約）。`cache_control` を渡す実装は未着手 |
| `AISdkClient` の `cachedInputTokens` | Vercel AI SDK 5 が返す場合のみ通過済み。`cache_control` 渡し未着手 |
| `withTokenLogging` → `cached_input_tokens` INSERT | 実装済み (`T-02-04`) |
| `packages/db/src/cost-aggregation.ts` | `cached_input_tokens` 集計済み |
| `packages/db/src/books-kpi.ts` | `getBooksKpiList` / `getSalesKpiSummary` 実装済み |
| チャートライブラリ | 純粋 SVG（recharts 等なし）。`SalesTrendChart` のパターンに合わせる |
| サイドバー `/models/ab` | `enabled: false`（本スプリントで有効化） |

---

## 4. タスク一覧

| タスク ID | タイトル | 工数 | 依存 | 状態 |
|---|---|---|---|---|
| T-13-01 | `packages/db/src/ab-comparison.ts` — A/B 集計クエリ実装 | M | — | 完了 |
| T-13-02 | `AgentSdkClient` に Prompt Caching (`cache_control`) を実装 + 単体テスト更新 | M | — | 完了 |
| T-13-03 | `AISdkClient` の Anthropic 経路に Prompt Caching を実装 + 単体テスト更新 | S | — | 完了 |
| T-13-04 | S-021 比較ページ RSC (`apps/web/app/(app)/models/ab/page.tsx`) | L | T-13-01 | 完了 |
| T-13-05 | S-021 UI コンポーネント群 (`ComparisonForm`, `ComparisonKpiCards`, `AbDistributionBoxPlot`, `BookListPerGroup`) | L | T-13-04 | 完了 |
| T-13-06 | サイドバーリンク有効化 + `messages.ts` / `nav-items.ts` 更新 + `pnpm build` 確認 | S | T-13-05 | 完了 |
| T-13-07 | Vitest 単体テスト: `ab-comparison.ts` クエリロジック | M | T-13-01 | 完了 |
| T-13-08 | Playwright E2E: UC-02 Phase 2 版 (`tests/e2e/ab-comparison.spec.ts` + `ab-comparison-runtime.spec.ts`) | M | T-13-05, T-13-06 | 完了 |

合計 8 タスク。

---

## 5. タスク詳細

### T-13-01 `packages/db/src/ab-comparison.ts` — A/B 集計クエリ実装

**目的**: F-026 の「期間 A vs 期間 B」、または「baseline prompt_version_id vs candidate prompt_version_id」の粒度で
TokenUsage + EvalResult + SalesRecord を JOIN して比較メトリクスを返す RSC 向けクエリを実装する。

**対象ファイル**:
- `packages/db/src/ab-comparison.ts` (新規作成)
- `packages/db/src/index.ts` (export 追加)

**実装仕様**:

```typescript
// packages/db/src/ab-comparison.ts

export type AbGroupKey = 'period_a' | 'period_b' | string; // prompt_version_id or model

/** クエリ入力 */
export interface AbComparisonFilter {
  /**
   * 比較モード:
   *   "period"  — created_at の期間 A/B で分割
   *   "prompt"  — books.prompt_version_ids_json[role] の baseline/candidate で分割
   *   "model"   — books.model_assignment_snapshot[role].model の A/B で分割
   */
  mode: 'period' | 'prompt' | 'model';

  // mode = "period" の場合
  periodA?: { from: Date; to: Date };
  periodB?: { from: Date; to: Date };

  // mode = "prompt" または "model" の場合
  role?: string; // 比較対象役割 (writer | editor | marketer | ...)
  baselineId?: string; // prompt_version_id or model 名
  candidateId?: string;

  /** サンプル数が MIN_SAMPLE を下回るグループは insufficient_data フラグを立てる */
  minSample?: number; // default: 5 (F-026 受け入れ基準)
}

export interface AbGroupStats {
  group_key: AbGroupKey;
  label: string;           // "期間A (2026-01-01 ~ 2026-02-28)" or "baseline:xxx"
  book_count: number;
  avg_quality_score: number | null;
  avg_cost_jpy: number | null;
  avg_lead_time_hours: number | null;
  median_royalty_jpy: number | null;
  total_cached_input_tokens: number;
  total_input_tokens: number;
  cache_hit_rate: number | null;  // cached / (input + cached)
  insufficient_data: boolean;
  book_ids: string[];
}

export interface AbComparisonResult {
  filter: AbComparisonFilter;
  group_a: AbGroupStats;
  group_b: AbGroupStats;
}

export async function getAbComparisonStats(
  prisma: PrismaClient,
  filter: AbComparisonFilter,
): Promise<AbComparisonResult>
```

**実装方針**:
1. `mode === 'period'` のとき:
   - `books.created_at` が `periodA.from ~ periodA.to` の範囲の書籍を group_a とする
   - `periodB.from ~ periodB.to` の範囲を group_b とする
   - 書籍 ID リストを取得後、`TokenUsage`, `EvalResult`, `SalesRecord` を book_id IN で JOIN
2. `mode === 'prompt'` のとき:
   - `books.prompt_version_ids_json` は JSON カラム。アプリ層で全書籍を取得し、`(pvIds as Record<string,string>)[role]` が `baselineId` / `candidateId` に一致するものをフィルタ
   - データ量は月 100 冊以下を想定。全件 fetch + アプリ層フィルタで問題なし
3. `mode === 'model'` のとき:
   - `books.model_assignment_snapshot` の JSON カラム中 `snapshot[role].model` が一致するものをアプリ層フィルタ
4. 各グループで以下を集計:
   - `avg_quality_score`: `EvalResult.score_total` の平均（最新 judged_at のもの）
   - `avg_cost_jpy`: `TokenUsage.cost_jpy` を book_id ごとに合計し、その平均
   - `avg_lead_time_hours`: `Book.done_at - Book.created_at`（hours）の平均
   - `median_royalty_jpy`: `SalesRecord.royalty_jpy` の累計中央値
   - `total_cached_input_tokens` / `total_input_tokens` / `cache_hit_rate`
5. `book_count < minSample` のグループは `insufficient_data: true`

**受け入れ基準**:
- `getAbComparisonStats` が `AbComparisonResult` を返す
- `mode === 'period'` / `'prompt'` / `'model'` 3 モード動作
- `minSample=5` 未満のグループで `insufficient_data: true` となる
- Vitest テストで確認（T-13-07 と連動）
- `packages/db/src/index.ts` から export されている

**参照**: `docs/04 §S-021`, `docs/02 §F-026`, `packages/db/src/books-kpi.ts`（JOIN パターン参考）

---

### T-13-02 `AgentSdkClient` に Prompt Caching を実装 + 単体テスト更新

**目的**: Anthropic Messages API の `cache_control: { type: "ephemeral" }` を `AgentSdkClient` の
`system` プロンプトに付与し、長い system プロンプト（Writer/Editor 向け）でキャッシュ再利用が
発生するようにする。`LLMCompleteArgs` に `enablePromptCaching?: boolean` オプションを追加し、
`withTokenLogging` 側で記録されている `cachedInputTokens` が正しく機能することを確認する。

**対象ファイル**:
- `packages/contracts/src/agents.ts` — `LLMCompleteArgs.enablePromptCaching?: boolean` を追加
- `packages/agents/src/lib/agent-sdk-client.ts` — `system` フィールドへの `cache_control` 付与
- `packages/agents/__tests__/agent-sdk-client.test.ts` — キャッシュ有効時のリクエスト形状テスト追加

**実装仕様**:

`AgentSdkClient.complete()` の中で、`args.enablePromptCaching === true` のとき、
Anthropic `messages.create` の `system` を文字列から配列形式に変換して `cache_control` を付与する:

```typescript
// agent-sdk-client.ts 内 run() 関数の messages.create 呼び出し部分

const systemParam: Anthropic.MessageParam['content'] | string | undefined =
  args.enablePromptCaching && system !== undefined
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;

const response = await client.messages.create({
  model: this.#model,
  max_tokens: args.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  ...(systemParam !== undefined ? { system: systemParam as never } : {}),
  ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  messages: rest,
  tools: tools as never,
});
```

`cache_control` の付与対象は system プロンプトのみとする（最初の user メッセージへの付与は
キャッシュ粒度が細かくなりすぎるため対象外）。

**受け入れ基準**:
- `enablePromptCaching: true` を渡したとき、`messages.create` の `system` 引数が
  `[{ type: 'text', text: '...', cache_control: { type: 'ephemeral' } }]` 形式になる
  （Vitest で msw / mock Anthropic クライアントを使って assert）
- `enablePromptCaching` が未指定または `false` のとき、従来通り文字列 `system` が渡される
- 既存の `agent-sdk-client.test.ts` のテストが全件 PASS
- `cache_creation_input_tokens` / `cache_read_input_tokens` が usage に含まれていれば、
  `toLLMUsage()` が `cachedInputTokens` に正しく集計することを追加テストで確認
- `responseSchema` を渡したとき `ConfigError` を throw する既存動作を維持

**参照**: `packages/agents/src/lib/agent-sdk-client.ts`, `docs/05 §6.1.1`
Anthropic Prompt Caching 仕様: system プロンプト配列の `cache_control: { type: "ephemeral" }`

---

### T-13-03 `AISdkClient` の Anthropic 経路に Prompt Caching を実装 + 単体テスト更新

**目的**: Vercel AI SDK `@ai-sdk/anthropic` 経由で Anthropic を呼ぶ場合、
`experimental_providerMetadata` を使って `cache_control` を渡す。
Writer / Editor / Judge / Optimizer が Anthropic Sonnet を使うとき有効になる。

**対象ファイル**:
- `packages/agents/src/lib/ai-sdk-client.ts` — Anthropic プロバイダ限定でキャッシュ制御を追加
- `packages/agents/__tests__/ai-sdk-client.test.ts` — Anthropic + caching パス確認テスト追加

**実装仕様**:

`AISdkClient.complete()` 内の `generateObject` / `generateText` 呼び出し時、
`provider === 'anthropic'` かつ `args.enablePromptCaching === true` のときのみ、
`experimental_providerMetadata` で `system` の `cacheControl` を付与する:

```typescript
// ai-sdk-client.ts 内 run() の generateText 呼び出し例

const providerMeta =
  this.#provider === 'anthropic' && args.enablePromptCaching
    ? {
        anthropic: {
          cacheControl: { type: 'ephemeral' as const },
        },
      }
    : undefined;

const res = await generateText({
  model,
  ...(system !== undefined ? { system } : {}),
  messages: rest,
  ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
  ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  ...(providerMeta !== undefined ? { experimental_providerMetadata: providerMeta } : {}),
  maxRetries: 0,
});
```

`generateObject` パスも同様に `experimental_providerMetadata` を渡す。
OpenAI / Google プロバイダでは `enablePromptCaching` を無視（プロバイダが対応していないため）。

**受け入れ基準**:
- `provider === 'anthropic'` かつ `enablePromptCaching: true` のとき `experimental_providerMetadata` が付与される
- `provider === 'google'` または `provider === 'openai'` のとき `experimental_providerMetadata` が付与されない
- Vercel AI SDK が返す `res.usage.cachedInputTokens` があれば `LLMCompleteResult.usage.cachedInputTokens` に通過する（既存動作の確認）
- 既存の `ai-sdk-client.test.ts` が全件 PASS

**参照**: `packages/agents/src/lib/ai-sdk-client.ts`, Vercel AI SDK `experimental_providerMetadata`
Anthropic キャッシュの AI SDK サポート: `@ai-sdk/anthropic` v2 の `cacheControl` in `experimental_providerMetadata`

---

### T-13-04 S-021 比較ページ RSC (`apps/web/app/(app)/models/ab/page.tsx`)

**目的**: `/models/ab` ルートを新規作成し、URL の `searchParams`（`mode`, `role`, `dateFrom`, `dateTo`,
`baselineId`, `candidateId`）を受け取って `getAbComparisonStats` を呼び出し、結果を
クライアントコンポーネントに渡す RSC ページを実装する。

**対象ファイル**:
- `apps/web/app/(app)/models/ab/page.tsx` (新規作成)
- `apps/web/lib/ab-comparison-view.ts` (新規作成 — RSC 向けデータ変換、Prisma import を含む)

**実装仕様**:

```
// ページ構造 (RSC)
/models/ab/page.tsx
  ├─ getSessionOrThrow() — 認証チェック
  ├─ searchParams から AbComparisonFilter を構築（デフォルト: mode='period', 今月 vs 先月）
  ├─ getAbComparisonStats(prisma, filter) を呼び出し
  └─ <AbComparisonShell stats={result} filter={filter} /> にデータを渡す

// lib/ab-comparison-view.ts
- Prisma の型を import し、searchParams → AbComparisonFilter 変換ロジックを定義
- クライアントコンポーネントに渡す純粋型（Prisma 非依存）を定義
  → クライアント側は Prisma 型を直接 import しない（Hard rule: client/server 境界）
```

**searchParams 仕様**:

| パラメータ | 型 | デフォルト |
|---|---|---|
| `mode` | `'period' \| 'prompt' \| 'model'` | `'period'` |
| `role` | AgentRole | `'writer'` |
| `dateFromA` | YYYY-MM-DD | 先月1日 |
| `dateToA` | YYYY-MM-DD | 先月末日 |
| `dateFromB` | YYYY-MM-DD | 今月1日 |
| `dateToB` | YYYY-MM-DD | 今日 |
| `baselineId` | string | — |
| `candidateId` | string | — |
| `minSample` | number | 5 |

**受け入れ基準**:
- `/models/ab` が 200 を返す（認証ありのセッションで）
- `getAbComparisonStats` の結果が props に渡る
- `'use client'` の子コンポーネントから Prisma 型が import されていない
- `pnpm --filter @a2p/web build` が通る

**参照**: `apps/web/app/(app)/sales/page.tsx`（RSC パターン参考）, `docs/04 §S-021`

---

### T-13-05 S-021 UI コンポーネント群

**目的**: S-021 の主要コンポーネントを `apps/web/components/models/ab/` 以下に実装する。
`docs/04 §S-021` の 5 セクション（比較設定・サンプル数・KPI カード・SVG グラフ・書籍リスト）を満たす。

**対象ファイル** (すべて新規作成):
- `apps/web/components/models/ab/ab-comparison-shell.tsx` — ページ全体のシェル（`'use client'`）
- `apps/web/components/models/ab/comparison-form.tsx` — モード・役割・期間選択フォーム
- `apps/web/components/models/ab/comparison-kpi-cards.tsx` — A vs B の並置 KPI カード
- `apps/web/components/models/ab/ab-box-plot.tsx` — SVG ボックスプロット相当（純粋 SVG、recharts 不使用）
- `apps/web/components/models/ab/book-list-per-group.tsx` — A 群 / B 群 書籍リスト

**実装仕様**:

`AbComparisonShell` は URL 更新（`router.push`）を行うクライアントコンポーネント。
フォーム操作時に searchParams を更新し、RSC 側が再 fetch する（App Router の標準パターン）。

**ComparisonKpiCards** — 各カードの表示項目:
- 品質スコア平均（A 値 / B 値 / 差分 `±N` / 有意性メッセージ）
- 1 冊コスト平均 JPY
- リードタイム平均（時間）
- 売上中央値 JPY
- キャッシュヒット率 (`cached / (input + cached)` × 100%)
  - Prompt Caching 未使用のとき `—` 表示

**AbBoxPlot** — SVG 実装仕様:
- 外部チャートライブラリ不使用（既存 `SalesTrendChart` と同じ純 SVG アプローチ）
- 各グループの min / Q1 / median / Q3 / max を品質スコアとコストの 2 指標で表示
- `insufficient_data: true` のグループは "データ不足" ラベルのみ表示
- コスト品質・パラメータは型で渡す（Prisma 非依存の純粋オブジェクト）

**BookListPerGroup** — 表示項目:
- 書籍タイトル / 品質スコア / コスト / done_at / S-010 へのリンク

**空状態**: 両グループとも `insufficient_data: true` の場合は「最低 5 冊蓄積後に再アクセスしてください」

**受け入れ基準**:
- `'use client'` の各コンポーネントから `@a2p/db` / Prisma 型を直接 import していない
- 5 冊未満グループで「データ不足」が表示される
- 両グループ揃ったとき KPI カードに差分が表示される
- `pnpm --filter @a2p/web build` が通る（T-13-06 の後で確認）

**参照**: `docs/04 §S-021`, `apps/web/components/sales/sales-trend-chart.tsx`（純 SVG 参考）

---

### T-13-06 サイドバーリンク有効化 + `messages.ts` / `nav-items.ts` 更新 + build 確認

**目的**: SP-11 で `enabled: false` に仮置きしていた `/models/ab` サイドバーリンクを有効化する。
ページ実装（T-13-04/T-13-05）完了後にリンクを切り替え、`pnpm --filter @a2p/web build` が通ることを確認する。

**対象ファイル**:
- `apps/web/components/layout/nav-items.ts` — `ab-compare` の `enabled: false` → `enabled: true`

**確認事項**:
- `pnpm --filter @a2p/web build` がエラーなく通る
- TypeScript の型エラーがない（client/server 境界の Prisma import 漏れがないこと）
- `/models/ab` がブラウザでアクセス可能（401 リダイレクトは認証確認用で正常）

**受け入れ基準**:
- `nav-items.ts` の `ab-compare.enabled === true` になっている
- `pnpm --filter @a2p/web build` が成功する（0 エラー）
- `pnpm --filter @a2p/web typecheck`（または `tsc --noEmit`）が通る

**参照**: `apps/web/components/layout/nav-items.ts`

---

### T-13-07 Vitest 単体テスト: `ab-comparison.ts` クエリロジック

**目的**: `getAbComparisonStats` の 3 モード (`period` / `prompt` / `model`) を Vitest + Prisma mock で
単体テストする。

**対象ファイル**:
- `packages/db/__tests__/ab-comparison.test.ts` (新規作成)

**テストケース**:

| # | テストケース |
|---|---|
| 1 | mode='period': periodA に 3 冊、periodB に 7 冊 → periodA は `insufficient_data: true`（minSample=5 時） |
| 2 | mode='period': 両期間に 6 冊ずつ → `avg_quality_score` / `avg_cost_jpy` が正しく集計される |
| 3 | mode='period': EvalResult なし書籍 → `avg_quality_score: null` |
| 4 | mode='period': SalesRecord なし書籍 → `median_royalty_jpy: null` |
| 5 | mode='prompt': `prompt_version_ids_json[role]` が baselineId と一致する書籍が group_a に入る |
| 6 | mode='model': `model_assignment_snapshot[role].model` が candidateId と一致する書籍が group_b に入る |
| 7 | cache_hit_rate: `cached_input_tokens > 0` のとき正しく計算される |
| 8 | cache_hit_rate: `cached_input_tokens === 0` のとき `null` |

**受け入れ基準**:
- `pnpm --filter @a2p/db test` で 8 ケース全 PASS

**参照**: `packages/db/__tests__/` 既存テストのパターン, `packages/db/src/ab-comparison.ts`

---

### T-13-08 Playwright E2E: UC-02 Phase 2 版

**目的**: UC-02「モデル切替（Writer を Claude Sonnet → Gemini に変更してコスト/品質を比較）」の
S-021 部分を Playwright で E2E テストする。実際の LLM 呼び出しはせず、DB に fixture データを
事前 seed して比較ビューの描画を確認する。

**対象ファイル**:
- `tests/e2e/ab-comparison.spec.ts` (chromium UI) + `tests/e2e/ab-comparison-runtime.spec.ts` (runtime, DB ダイレクト)
  ※ 確立済みパターン（runtime=DBダイレクト + chromium=UI）に従い 2 ファイルに分割。
- `tests/e2e/fixtures/ab-comparison-seed.ts` (新規作成 — テスト用 Book/TokenUsage/EvalResult/SalesRecord seed)

**テストシナリオ**:

```
1. ログイン → /models/ab にアクセス
2. デフォルト表示 (mode=period、先月 vs 今月) で KPI カードが描画される
3. group_a の book_count が fixture の冊数と一致する
4. "データ不足" メッセージが `minSample` 未満グループに表示される
   (fixture: periodA を 3 冊、periodB を 8 冊にする)
5. mode を "prompt" に切替 → role="writer"、baselineId を選択 → 更新後に group_a 書籍リストが表示される
6. 書籍タイトルをクリック → /books/[id] にリダイレクトされる (data-testid="book-list-row-link")
```

**受け入れ基準**:
- `pnpm exec playwright test ab-comparison` が全 PASS（runtime + chromium）
- テストは実際の LLM API を呼ばない（fixture seed のみ）
- 既存 E2E テストを破壊しない

**参照**: `tests/e2e/` 既存 spec, `docs/02 §UC-02`

---

## 6. テスト計画

| タスク | テスト種別 | ファイル | 確認内容 |
|---|---|---|---|
| T-13-01 | — | — | T-13-07 で検証 |
| T-13-02 | Vitest | `packages/agents/__tests__/agent-sdk-client.test.ts` | `cache_control` 付与形式 / 既存テスト PASS |
| T-13-03 | Vitest | `packages/agents/__tests__/ai-sdk-client.test.ts` | Anthropic のみ `experimental_providerMetadata` 付与 |
| T-13-04 | build | `pnpm --filter @a2p/web build` | RSC ビルドエラーなし |
| T-13-05 | build | `pnpm --filter @a2p/web build` | client/server 境界エラーなし |
| T-13-06 | build | `pnpm --filter @a2p/web build` | 0 エラー |
| T-13-07 | Vitest | `packages/db/__tests__/ab-comparison.test.ts` | 8 ケース全 PASS |
| T-13-08 | Playwright | `tests/e2e/ab-comparison.spec.ts` + `ab-comparison-runtime.spec.ts` | 全シナリオ PASS |

---

## 7. 完了判定

以下をすべて満たすこと:

1. `pnpm --filter @a2p/agents test` — T-13-02/T-13-03 テストを含む全件 PASS
2. `pnpm --filter @a2p/db test` — T-13-07 テストを含む全件 PASS
3. `pnpm --filter @a2p/web build` — ビルドエラー 0
4. `pnpm exec playwright test ab-comparison` — 全 PASS（runtime + chromium）
5. サイドバー `/models/ab` リンクが `enabled: true`（グレーアウト解除済み）
6. `packages/db/src/ab-comparison.ts` が `packages/db/src/index.ts` から export されている
7. `pm MODE: REVIEW TARGET: SP-13` で `## PHASE_COMPLETE`

---

## 8. 申し送り（人間ゲート・後続フェーズ用）

### 8.1 人間タスク（実測必要 / 本スプリントのコード完了条件に含めない）

| # | 内容 | 担当 | タイミング |
|---|---|---|---|
| H-13-01 | Prompt Caching の本番有効化判断: `enablePromptCaching: true` を Writer/Editor の呼び出し元（`pipeline.book.writer.chapter.ts` 等）に渡すかどうかの判断。キャッシュヒット率が S-021 比較ビューで 20% 以上になれば有効化を推奨 | 人間（運営者） | SP-13 完了後、本番データ 30 冊以上蓄積後 |
| H-13-02 | Writer × ジャンル別の Gemini Flash 切替実測: S-021 の `mode=model` ビューで Sonnet vs Gemini の品質スコア差・コスト差を実データで確認し、切替可否を判断 | 人間（運営者） | SP-13 完了後、A/B 配信 10 冊以上蓄積後 |
| H-13-03 | 月額コスト削減効果の実測確認: `cost/page.tsx`（S-024）と S-021 比較ビューを組み合わせ、Phase 1 比の削減額を確認後、`docs/dev-plan.md §7 意思決定ログ` に記録 | 人間（運営者） | Phase 2 PHASE_COMPLETE 後 |
| H-13-04 | `docs/dev-plan.md §7` への記録: 「SP-13 で Prompt Caching 実装済み（本番有効化は H-13-01 の人間判断待ち）」の旨を意思決定ログに追記 | 人間（運営者） | SP-13 PHASE_COMPLETE 直後 |

### 8.2 Phase 3 への申し送り

- SP-13 完了後、Phase 2 (`SP-10 〜 SP-13`) が揃えば `pm MODE: REVIEW TARGET: Phase 2` を実行し、`## PHASE_COMPLETE` を確認してから SP-14 に着手すること
- SP-14 (`kdp-browser-base`) 開始前提条件:
  - Railway の `PLAYWRIGHT_CHROMIUM=true` 環境変数 / chromium バイナリ同梱 Dockerfile の整備
  - KDP アカウント認証情報の暗号化保存（`F-044` の `kdp_credentials_enc` 列、Phase 1 先取り済み）
  - `packages/crypto/kdp-credentials.ts` の動作確認（`KDP_CRED_KEY` env 必須）

---

## 9. 実行順（推奨）

```
グループ A（並列可）:
  T-13-01  packages/db/src/ab-comparison.ts
  T-13-02  AgentSdkClient Prompt Caching
  T-13-03  AISdkClient Prompt Caching

グループ B（A 完了後）:
  T-13-07  Vitest: ab-comparison.ts テスト（T-13-01 依存）
  T-13-04  S-021 RSC ページ（T-13-01 依存）

グループ C（B 完了後）:
  T-13-05  S-021 UI コンポーネント群（T-13-04 依存）

グループ D（C 完了後）:
  T-13-06  サイドバーリンク有効化 + build 確認（T-13-05 依存）
  T-13-08  Playwright E2E（T-13-05, T-13-06 依存）
```

---

## 10. 横断規約リマインダ（`CLAUDE.md` Hard Rules 適用）

- **Rule 4**: プロンプトは DB から取得。`enablePromptCaching` は呼び出し引数で渡すのみ。システムプロンプト本文は `loadActivePrompt()` 経由。
- **Rule 5**: `LLMCompleteResult.usage.cachedInputTokens` が返ったとき、`withTokenLogging` が `TokenUsage.cached_input_tokens` に必ず記録する。本スプリントでは記録ロジックは既に実装済み（`T-02-04`）であり、T-13-02/T-13-03 での変更後も同経路を通ることをテストで確認。
- **client/server 境界**: `apps/web/components/models/ab/` 以下のコンポーネントは `'use client'` 宣言。Prisma 型は `apps/web/lib/ab-comparison-view.ts`（サーバ側）に閉じ、クライアントへは純粋オブジェクト型のみ渡す。
- **ADR-001**: SSE / pg_notify を参照する箇所があれば `'jobs'` チャネル名に統一。本スプリントは RSC のみのため対象外。
