/**
 * docs/05 §6.3.7 / F-009 / SP-11 T-11-01 — Prompt Optimizer エージェント。
 *
 * フロー (Judge と同パターン):
 *  1. `loadActivePrompt('optimizer', null)` で active プロンプトを取得
 *  2. プレースホルダ ({role}/{genre}/{eval_count}/{current_prompt}/
 *     {eval_summary}/{sales_summary}) を差込
 *  3. `createAgentClient('optimizer', null, ctx)` で LLMClient (withTokenLogging ラップ済) 取得
 *  4. `client.complete({ messages, maxOutputTokens: 4096 })` を 1 回呼ぶ
 *  5. JSON 抽出 → zod parse (judge と同実装の extractJson + predicate 方式)
 *
 * エラー方針:
 *  - 空レスポンス → `AgentError('optimizer.invalid_output: empty response', ...)`
 *  - JSON 抽出失敗 → `AgentError('optimizer.invalid_output: failed to parse JSON', ...)`
 *  - schema 検証失敗 → `AgentError('optimizer.invalid_output: schema validation failed', ...)`
 *  - LLM 呼出失敗 (ProviderError 等) はそのまま透過 (上位 worker の retry 対象)
 *  - active プロンプト不在 / API キー不在 → ConfigError (loadActivePrompt / createAgentClient が throw)
 *
 * Hard Rule 5: createAgentClient が返すクライアントは既に withTokenLogging ラップ済み。
 * 手動で withTokenLogging を呼ばないこと。bookId は null (システムタスク)。
 *
 * DI: `deps?.createAgentClient` / `deps?.loadActivePrompt` でテスト差し替え可能。
 */
import { AgentError } from '@a2p/contracts/errors';
import type { LLMClient } from '@a2p/contracts/agents';
import {
  OptimizerInputSchema,
  OptimizerOutputSchema,
  type OptimizerInput,
  type OptimizerOutput,
} from '@a2p/contracts/agents/optimizer';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type {
  LoggingContext,
  WithTokenLoggingDeps,
} from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface OptimizerDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  /** prompt-loader 内 Prisma 差し替え用 deps。 */
  promptLoaderDeps?: PromptLoaderDeps;
  /** factory 内 ModelAssignment / withTokenLogging 差し替え用 deps。 */
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  /** factory 内 getApiKey 差し替え (テストで env / DB を引かない)。 */
  getApiKey?: (provider: string) => Promise<string>;
}

/**
 * F-009 Prompt Optimizer エージェント。
 * 直近 eval_results / sales_records を基にプロンプト改訂案を生成する。
 *
 * @throws AgentError JSON 抽出/parse 失敗
 * @throws ProviderError LLM API 失敗 (透過、上位 worker でリトライ)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function optimizePrompt(
  input: OptimizerInput,
  deps: OptimizerDeps = {},
): Promise<OptimizerOutput> {
  const parsedInput = OptimizerInputSchema.parse(input);

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  // optimizer は genre=null の汎用プロンプトを使用（システムタスクのため）
  const prompt = await loadPrompt('optimizer', null, deps.promptLoaderDeps);

  const evalSummary = buildEvalSummary(parsedInput.recent_evals);
  const salesSummary = buildSalesSummary(parsedInput.recent_sales);

  const systemPrompt = fillPlaceholders(prompt.template, {
    role: parsedInput.role,
    genre: parsedInput.genre ?? '全ジャンル',
    eval_count: parsedInput.recent_evals.length,
    current_prompt: parsedInput.current_prompt.body,
    eval_summary: evalSummary,
    sales_summary: salesSummary,
  });

  const ctx: LoggingContext = {
    role: 'optimizer',
    // bookId は設定しない (システムタスク — token_usage.book_id = null)
  };
  if (parsedInput.job_id !== undefined) {
    ctx.jobId = parsedInput.job_id;
  }

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient(
    'optimizer',
    null,
    ctx,
    factoryDeps,
  );

  const completion = await client.complete({
    role: 'optimizer',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(parsedInput) },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const rawText = completion.text;
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw new AgentError('optimizer.invalid_output: empty response', {
      details: { rawText: String(rawText) },
    });
  }

  const parsedJson = extractJson(rawText, hasOptimizerShape);
  if (parsedJson === undefined) {
    throw new AgentError('optimizer.invalid_output: failed to parse JSON', {
      details: { rawText },
    });
  }

  const validated = OptimizerOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AgentError('optimizer.invalid_output: schema validation failed', {
      details: { rawText, issues: validated.error.issues },
      cause: validated.error,
    });
  }

  return validated.data;
}

/**
 * proposed_body を持つ object か (schema-aware extractor 用 predicate)。
 */
function hasOptimizerShape(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return typeof obj.proposed_body === 'string' && obj.proposed_body.length > 0;
}

function buildEvalSummary(
  evals: OptimizerInput['recent_evals'],
): string {
  if (evals.length === 0) return '評価データなし';
  const avgScore =
    evals.reduce((sum, e) => sum + e.score_total, 0) / evals.length;
  return [
    `評価件数: ${evals.length}`,
    `平均スコア: ${avgScore.toFixed(1)}`,
    '詳細:',
    ...evals.map(
      (e) =>
        `  - book_id=${e.book_id} score=${e.score_total} prompt_version=${e.prompt_version_id}`,
    ),
  ].join('\n');
}

function buildSalesSummary(
  sales: OptimizerInput['recent_sales'],
): string {
  if (sales.length === 0) return '販売データなし';
  const totalRoyalty = sales.reduce((sum, s) => sum + s.royalty_jpy, 0);
  return [
    `販売件数: ${sales.length}`,
    `合計ロイヤリティ: ${totalRoyalty.toLocaleString('ja-JP')} 円`,
    '詳細:',
    ...sales.map(
      (s) =>
        `  - book_id=${s.book_id} royalty=${s.royalty_jpy}円 stars=${s.avg_stars ?? 'N/A'}`,
    ),
  ].join('\n');
}

function buildUserMessage(input: OptimizerInput): string {
  const lines = [
    `対象役割: ${input.role}`,
    `対象ジャンル: ${input.genre ?? '全ジャンル (genre=null)'}`,
    `現行プロンプトバージョン: v${input.current_prompt.version} (id=${input.current_prompt.id})`,
    '',
    '【現行プロンプト本文】',
    input.current_prompt.body,
    '',
    '【直近の評価結果サマリ】',
    buildEvalSummary(input.recent_evals),
    '',
    '【直近の販売実績サマリ】',
    buildSalesSummary(input.recent_sales),
    '',
    '上記を踏まえ、プロンプトを改訂してください。',
    '',
    '出力形式: JSON で以下を返してください。',
    '{',
    '  "proposed_body": "<改訂後のプロンプト全文>",',
    '  "diff": "<unified diff 形式の差分>",',
    '  "rationale": "<改訂理由（日本語）>",',
    '  "expected_effect": {',
    '    "score_delta": <期待スコア改善量（省略可）>,',
    '    "sales_delta_pct": <期待売上改善率（省略可）>',
    '  },',
    '  "sample_output": "<改訂後プロンプトを使った場合の出力例（省略可）>"',
    '}',
    '',
    '**出力形式の厳格な制約**:',
    ' - 応答は **必ず単一の JSON オブジェクト** とし、proposed_body を含めること',
    ' - JSON 以外のテキスト (前置きコメント、説明、```json``` フェンス等) は含めないこと',
    ' - **JSON 文字列値内では改行は必ず \\n でエスケープすること**',
  ];
  return lines.join('\n');
}

// ===========================================================================
// JSON 抽出 — judge/index.ts と同実装 (schema-aware predicate 対応)
// ===========================================================================

function extractJson<T = unknown>(
  text: string,
  predicate?: (parsed: unknown) => boolean,
): T | undefined {
  const trimmed = text.trim();
  const candidates: unknown[] = [];

  const direct = tryParse(trimmed);
  if (direct !== undefined) candidates.push(direct);

  const fenceRe = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    const body = m[1]?.trim();
    if (!body) continue;
    const parsed = tryParse(body);
    if (parsed !== undefined) candidates.push(parsed);
    collectBalanced(body, candidates);
  }

  const openFence = /```(?:[a-zA-Z0-9_-]+)?\s*/.exec(trimmed);
  if (openFence) {
    const after = trimmed.slice(openFence.index + openFence[0].length);
    collectBalanced(after, candidates);
  }

  collectBalanced(trimmed, candidates);

  if (predicate) {
    for (const c of candidates) {
      if (predicate(c)) return c as T;
    }
    return undefined;
  }

  let largest: unknown | undefined;
  let largestSize = -1;
  for (const c of candidates) {
    if (typeof c === 'object' && c !== null) {
      const size = JSON.stringify(c).length;
      if (size > largestSize) {
        largest = c;
        largestSize = size;
      }
    }
  }
  return largest as T | undefined;
}

function collectBalanced(text: string, out: unknown[]): void {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findMatchingBrace(text, start);
    if (end === -1) continue;
    const parsed = tryParse(text.slice(start, end + 1));
    if (parsed !== undefined) out.push(parsed);
  }
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(sanitizeJsonStringNewlines(s));
    } catch {
      return undefined;
    }
  }
}

function sanitizeJsonStringNewlines(text: string): string {
  let result = '';
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      result += ch;
      inString = !inString;
      continue;
    }
    if (inString) {
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') {
        result += '\\r';
        continue;
      }
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
    }
    result += ch;
  }
  return result;
}
