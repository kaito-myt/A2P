/**
 * docs/05 ss6.3.4 / F-006 -- Thumbnail Designer (cover text proposals).
 *
 * Flow (Editor / Writer pattern):
 *  1. `loadActivePrompt('thumbnail_text', genre)` for active prompt
 *  2. Placeholder injection ({title}/{subtitle}/{hook}/{target_reader}/{genre}/{count})
 *  3. `createAgentClient('thumbnail_text', genre, ctx)` for LLMClient (withTokenLogging wrapped)
 *  4. `client.complete({ system, user, maxOutputTokens })` -- single call
 *  5. JSON extraction -> zod validation (3-5 proposals)
 *
 * Error policy (same as Writer / Editor):
 *  - JSON extraction/parse failure -> AgentError('thumbnail_text.invalid_output')
 *  - zod validation failure -> AgentError('thumbnail_text.invalid_output')
 *  - LLM call failure (ProviderError etc.) -> pass-through (upper worker retries)
 *
 * DI: `deps?.createAgentClient` / `deps?.loadActivePrompt` for test substitution.
 */
import { genreLabel } from '@a2p/contracts/agents';
import { AgentError } from '@a2p/contracts/errors';
import type { LLMClient } from '@a2p/contracts/agents';
import {
  ThumbnailTextInputSchema,
  ThumbnailTextOutputSchema,
  type ThumbnailTextInput,
  type ThumbnailTextOutput,
} from '@a2p/contracts/agents/thumbnail';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import { sanitizeLlmJson } from '../lib/sanitize-llm-json.js';
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

export interface GenerateCoverTextDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
}

/**
 * F-006: Generate 3-5 cover text proposals for a book.
 *
 * @throws AgentError JSON extraction/parse failure / zod validation failure
 * @throws ProviderError LLM API failure (pass-through, upper worker retries)
 * @throws ConfigError   active prompt missing / API key missing
 */
export async function generateCoverText(
  input: ThumbnailTextInput,
  deps: GenerateCoverTextDeps = {},
): Promise<ThumbnailTextOutput> {
  const parsedInput = ThumbnailTextInputSchema.parse(input);

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt(
    'thumbnail_text',
    parsedInput.genre,
    deps.promptLoaderDeps,
  );
  const systemPrompt = fillPlaceholders(prompt.template, {
    title: parsedInput.themeContext.title,
    subtitle: parsedInput.themeContext.subtitle ?? '',
    hook: parsedInput.themeContext.hook,
    target_reader: parsedInput.themeContext.target_reader,
    genre: genreLabel(parsedInput.genre) ?? 'general',
    count: parsedInput.count,
  });

  const ctx: LoggingContext = {
    role: 'thumbnail_text',
    bookId: parsedInput.bookId,
  };
  if (parsedInput.jobId !== undefined) {
    ctx.jobId = parsedInput.jobId;
  }

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient(
    'thumbnail_text',
    parsedInput.genre,
    ctx,
    factoryDeps,
  );

  const completion = await client.complete({
    role: 'thumbnail_text',
    genre: parsedInput.genre,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(parsedInput) },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const rawText = completion.text;
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw new AgentError('thumbnail_text.invalid_output: empty response', {
      details: { rawText: String(rawText) },
    });
  }

  const parsedJson = extractJson(rawText, hasProposalsArray);
  if (parsedJson === undefined) {
    throw new AgentError('thumbnail_text.invalid_output: failed to parse JSON', {
      details: { rawText },
    });
  }

  const validated = ThumbnailTextOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AgentError('thumbnail_text.invalid_output: schema validation failed', {
      details: { rawText, issues: validated.error.issues },
      cause: validated.error,
    });
  }

  return validated.data;
}

function hasProposalsArray(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return Array.isArray(obj.proposals);
}

function buildUserMessage(input: ThumbnailTextInput): string {
  const lines = [
    `書籍タイトル: ${input.themeContext.title}`,
  ];
  if (input.themeContext.subtitle) {
    lines.push(`副題: ${input.themeContext.subtitle}`);
  }
  lines.push(
    `差別化フック: ${input.themeContext.hook}`,
    `想定読者: ${input.themeContext.target_reader}`,
    `ジャンル: ${genreLabel(input.genre) ?? 'general'}`,
    '',
    `上記の書籍について、表紙に載せるテキスト案を ${input.count} 案生成してください。`,
    '',
    'F-006 受入基準 (必ず遵守):',
    ` - 必ず ${input.count} 案を生成する (最低 3 案)`,
    ' - 各案にはタイトル (title) を必ず含める',
    ' - サブタイトル (subtitle) と帯文 (band_copy) は任意だが、読者の目を引く表現を推奨',
    ' - ジャンル (実用書/ビジネス書/自己啓発) に合った意匠原則を意識する',
    ' - 案ごとに異なるアプローチ (エモーショナル/データ訴求/問いかけ型 等) で差別化する',
    '',
    '出力形式: JSON で以下を返してください。',
    '{',
    '  "proposals": [',
    '    {',
    '      "title": string,             // 表紙タイトル (必須)',
    '      "subtitle"?: string,         // サブタイトル (任意)',
    '      "band_copy"?: string         // 帯文 (任意)',
    '    }, ...',
    '  ]',
    '}',
    '',
    '**出力形式の厳格な制約**:',
    ' - 応答は **必ず単一の JSON オブジェクト** とし、トップレベルキーに `proposals` 配列を含めること',
    ' - JSON 以外のテキスト (前置きコメント、説明、```json``` フェンス等) は応答に含めないこと',
  );
  return lines.join('\n');
}

// ===========================================================================
// JSON extraction -- same implementation as Writer / Editor
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
    /* fall through */
  }
  try {
    return JSON.parse(sanitizeJsonStringNewlines(s));
  } catch {
    /* fall through */
  }
  // 未エスケープの内側二重引用符（例: "平安の"陽キャ"がSNS..."）まで修復してリトライ。
  try {
    return JSON.parse(sanitizeLlmJson(s));
  } catch {
    return undefined;
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
