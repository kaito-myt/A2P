/**
 * docs/05 §6.3.5 / F-008 / SP-10 T-10-01 — Quality Judge エージェント。
 *
 * フロー (Editor と同パターン):
 *  1. `loadActivePrompt('judge', genre)` で active プロンプトを取得
 *  2. プレースホルダ ({theme_title}/{theme_subtitle}/{theme_hook}/{target_reader}/
 *     {genre}/{chapter_count}/{draft_chapters}/{outline_summary}) を差込
 *  3. `createAgentClient('judge', genre, ctx)` で LLMClient (withTokenLogging ラップ済) 取得
 *  4. `client.complete({ messages, maxOutputTokens: 4096 })` を 1 回呼ぶ
 *  5. JSON 抽出 → zod parse (editor と同実装の extractJson + predicate 方式)
 *  6. score_total = 6 軸合計 / 6 (均等重み、小数切り捨て) をサーバ側で再計算
 *     LLM 出力の score_total は検証のみに使い、最終値は計算値で上書きする
 *
 * エラー方針:
 *  - JSON 抽出/parse 失敗 → `AgentError('judge.invalid_output', { rawText, cause })`
 *  - LLM 呼出失敗 (ProviderError 等) はそのまま透過 (上位 worker の retry 対象)
 *  - active プロンプト不在 / API キー不在 → ConfigError (loadActivePrompt / createAgentClient が throw)
 *
 * DI: `deps?.createAgentClient` / `deps?.loadActivePrompt` でテスト差し替え可能。
 */
import { AgentError } from '@a2p/contracts/errors';
import type { LLMClient } from '@a2p/contracts/agents';
import {
  JudgeInputSchema,
  JudgeOutputSchema,
  type JudgeInput,
  type JudgeOutput,
} from '@a2p/contracts/agents/judge';

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

export interface JudgeBookDeps {
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
 * F-008 受入基準: 6 軸採点を行い JudgeOutput を返す。
 * score_total はサーバ側で 6 軸均等平均（切り捨て）に再計算する。
 *
 * @throws AgentError JSON 抽出/parse 失敗
 * @throws ProviderError LLM API 失敗 (透過、上位 worker でリトライ)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function judgeBook(
  input: JudgeInput,
  deps: JudgeBookDeps = {},
): Promise<JudgeOutput> {
  const parsedInput = JudgeInputSchema.parse(input);

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt(
    'judge',
    parsedInput.genre,
    deps.promptLoaderDeps,
  );

  const systemPrompt = fillPlaceholders(prompt.template, {
    theme_title: parsedInput.theme_context.title,
    theme_subtitle: parsedInput.theme_context.subtitle ?? '',
    theme_hook: parsedInput.theme_context.hook,
    target_reader: parsedInput.theme_context.target_reader,
    genre: parsedInput.genre ?? 'general',
    chapter_count: parsedInput.chapters.length,
    draft_chapters: JSON.stringify(parsedInput.chapters),
    outline_summary: parsedInput.outline_summary,
  });

  const ctx: LoggingContext = {
    role: 'judge',
    bookId: parsedInput.book_id,
  };
  if (parsedInput.job_id !== undefined) {
    ctx.jobId = parsedInput.job_id;
  }

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient(
    'judge',
    parsedInput.genre,
    ctx,
    factoryDeps,
  );

  const completion = await client.complete({
    role: 'judge',
    genre: parsedInput.genre,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(parsedInput) },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const rawText = completion.text;
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw new AgentError('judge.invalid_output: empty response', {
      details: { rawText: String(rawText) },
    });
  }

  const parsedJson = extractJson(rawText, hasJudgeShape);
  if (parsedJson === undefined) {
    throw new AgentError('judge.invalid_output: failed to parse JSON', {
      details: { rawText },
    });
  }

  const validated = JudgeOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AgentError('judge.invalid_output: schema validation failed', {
      details: { rawText, issues: validated.error.issues },
      cause: validated.error,
    });
  }

  // score_total をサーバ側で再計算（LLM 出力を鵜呑みにしない）
  const bd = validated.data.score_breakdown;
  const axes = [
    bd.benefit_clarity,
    bd.logical_consistency,
    bd.style_consistency,
    bd.japanese_naturalness,
    bd.title_alignment,
    bd.genre_fit,
  ];
  const score_total = Math.floor(axes.reduce((sum, v) => sum + v, 0) / axes.length);

  return {
    score_total,
    score_breakdown: validated.data.score_breakdown,
    judge_comments: validated.data.judge_comments,
  };
}

/**
 * score_breakdown を持つ object か (schema-aware extractor 用 predicate)。
 */
function hasJudgeShape(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return typeof obj.score_breakdown === 'object' && obj.score_breakdown !== null;
}

function buildUserMessage(input: JudgeInput): string {
  const lines = [
    `書籍タイトル: ${input.theme_context.title}`,
  ];
  if (input.theme_context.subtitle) {
    lines.push(`副題: ${input.theme_context.subtitle}`);
  }
  lines.push(
    `差別化フック: ${input.theme_context.hook}`,
    `想定読者: ${input.theme_context.target_reader}`,
    `ジャンル: ${input.genre ?? 'general'}`,
    `章数: ${input.chapters.length}`,
    '',
    '【アウトライン概要】',
    input.outline_summary,
    '',
    '【採点対象の全章 (JSON 配列)】',
    JSON.stringify(input.chapters, null, 2),
    '',
    '上記の原稿を以下の 6 軸で採点してください。各軸 0-100 の整数で評価してください。',
    '',
    '採点軸:',
    ' - benefit_clarity: 読者へのベネフィット明確性',
    ' - logical_consistency: 論理的一貫性',
    ' - style_consistency: 文体の一貫性',
    ' - japanese_naturalness: 日本語の自然さ',
    ' - title_alignment: タイトルとの整合性',
    ' - genre_fit: ジャンル適合度',
    '',
    '出力形式: JSON で以下を返してください。',
    '{',
    '  "score_total": integer,  // 6 軸の均等平均（参考値、サーバ側で再計算）',
    '  "score_breakdown": {',
    '    "benefit_clarity": integer,',
    '    "logical_consistency": integer,',
    '    "style_consistency": integer,',
    '    "japanese_naturalness": integer,',
    '    "title_alignment": integer,',
    '    "genre_fit": integer',
    '  },',
    '  "judge_comments": {',
    '    "benefit_clarity": "string",  // 軸ごとの日本語コメント',
    '    "logical_consistency": "string",',
    '    "style_consistency": "string",',
    '    "japanese_naturalness": "string",',
    '    "title_alignment": "string",',
    '    "genre_fit": "string",',
    '    "overall": "string"  // 総評（任意）',
    '  }',
    '}',
    '',
    '**出力形式の厳格な制約**:',
    ' - 応答は **必ず単一の JSON オブジェクト** とし、score_breakdown を含めること',
    ' - JSON 以外のテキスト (前置きコメント、説明、```json``` フェンス等) は含めないこと',
    ' - **JSON 文字列値内では改行は必ず `\\n` でエスケープすること**',
  );
  return lines.join('\n');
}

// ===========================================================================
// JSON 抽出 — editor/index.ts と同実装 (schema-aware predicate 対応)
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
