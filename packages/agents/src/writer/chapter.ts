/**
 * docs/05 §6.3.2 / F-004 — Writer エージェント (章執筆)。
 *
 * フロー (T-04-01 outline.ts と同パターン):
 *  1. `loadActivePrompt('writer', genre)` で active プロンプトを取得
 *     (writer 役の active プロンプトは outline と chapter で共有。プロンプト本文側で
 *     {chapter_heading} などの章固有プレースホルダ有無で分岐される設計)
 *  2. プレースホルダ ({chapter_index}/{chapter_heading}/{chapter_summary}/
 *     {chapter_subheadings}/{target_chars}/{theme_title}/{theme_subtitle}/{theme_hook}/
 *     {target_reader}/{previous_chapters_summary}/{feedback}/{genre}) を差し込み
 *  3. `createAgentClient('writer', genre, ctx)` で LLMClient (AISdkClient) を取得
 *  4. `client.complete({ system, user, maxOutputTokens: 16384 })` を 1 回呼ぶ
 *     (章本文は ~10000 字想定なので 8192 では足りない。16K で安全マージン)
 *  5. **F-004 受入基準** の自動検証:
 *     - body_md の文字数 = `[...body_md].length` (codepoint 数、絵文字 surrogate pair 安全)
 *     - 計算値が `outlineChapter.target_chars` の ±20% 範囲内
 *  6. char_count は LLM 申告値を捨てて計算値で上書き (信頼境界、outline と同パターン)
 *  7. heading は outlineChapter.heading の echo 既定だが、LLM が返した値を優先
 *     (Writer が章タイトルを微調整した場合を許容)
 *
 * エラー方針 (outline と同型):
 *  - JSON 抽出/parse 失敗   → `AgentError('writer.chapter.invalid_output', { rawText, cause })`
 *  - zod 検証失敗            → `AgentError('writer.chapter.invalid_output', { issues, rawText })`
 *  - 文字数範囲外            → `AgentError('writer.chapter.chars_out_of_range', { details })`
 *  - LLM 呼出失敗 (ProviderError 等) はそのまま透過 (上位 worker の retry 対象)
 *
 * DI: `deps?.createAgentClient` / `deps?.loadActivePrompt` でテスト差し替え可能。
 *
 * T-03-01 / T-04-01 教訓:
 *  - jobId は graphile-worker.jobs.id 専用 — UI 直接呼出時は undefined → null forward
 *    (theme_session_id 流用は FK 違反で silent fail するため厳禁)
 *  - schema は DB `chapters` 列 (heading / body_md / char_count) + docs/05 §6.3.2 と
 *    完全整合 (Hard Rule #3)。warnings 等は追加しない。
 *  - AgentSdkClient は responseSchema 非対応 — 自由テキスト → JSON 抽出 → zod の三段
 */
import { AgentError } from '@a2p/contracts/errors';
import type { LLMClient } from '@a2p/contracts/agents';
import {
  WriterChapterInputSchema,
  WriterChapterOutputSchema,
  type RevisionFeedbackItem,
  type WriterChapterInput,
  type WriterChapterOutput,
} from '@a2p/contracts/agents/writer';

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

/**
 * 章本文 LLM 呼出の既定 max tokens。1 章 ~10000 字想定 (日本語 1.5 tok/char 換算で
 * ~15000 tok) に加え JSON 構造分の余裕を持たせて 16384。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/**
 * F-004 受入基準: 章単体の文字数が target_chars の ±20% に収まる (docs/02 L203 / SP-04 §4 T-04-02)。
 * F-003 outline 総文字数 ±15% とは別レイヤー — 章執筆はリトライ濫発を避けるため緩い tolerance
 * を採用し、合計の整合は outline 段階で担保する設計。
 */
// 章執筆はリトライ濫発を避けるため緩い tolerance。±20% だと創作文で頻繁に外れて
// 章が恒久失敗し書籍が「実行中」で無限に止まる事故が起きたため ±35% に緩和。
const CHAR_TOLERANCE = 0.35;

export interface GenerateChapterDeps {
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
 * F-004 受入基準: 章 outline + テーマ文脈から 1 章の本文 (Markdown) を生成。
 *
 * @throws AgentError JSON 抽出/parse 失敗 / zod 検証失敗 / 文字数範囲外
 * @throws ProviderError LLM API 失敗 (透過、上位 worker でリトライ)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function generateChapter(
  input: WriterChapterInput,
  deps: GenerateChapterDeps = {},
): Promise<WriterChapterOutput> {
  // 1. 入力 zod 検証 (呼出側 SA で済んでいる想定だが、二重防衛)
  const parsedInput = WriterChapterInputSchema.parse(input);

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  // 2. active プロンプト取得 + プレースホルダ差込
  const prompt = await loadPrompt(
    'writer',
    parsedInput.genre,
    deps.promptLoaderDeps,
  );
  const systemPrompt = fillPlaceholders(prompt.template, {
    chapter_index: parsedInput.outlineChapter.index,
    chapter_heading: parsedInput.outlineChapter.heading,
    chapter_summary: parsedInput.outlineChapter.summary,
    chapter_subheadings: parsedInput.outlineChapter.subheadings.join(' / '),
    target_chars: parsedInput.outlineChapter.target_chars,
    theme_title: parsedInput.themeContext.title,
    theme_subtitle: parsedInput.themeContext.subtitle ?? '',
    theme_hook: parsedInput.themeContext.hook,
    target_reader: parsedInput.themeContext.target_reader,
    previous_chapters_summary: parsedInput.previousChaptersSummary ?? '',
    feedback: formatFeedback(parsedInput.feedback),
    genre: parsedInput.genre ?? 'general',
  });

  // 3. LLMClient (withTokenLogging ラップ済み) 取得
  //    jobId は input から forward — 未指定なら ctx に key を含めず token_usage.job_id=null
  //    bookId は Writer 起動時点で確定済み → ctx.bookId に必ず詰める
  const ctx: LoggingContext = {
    role: 'writer',
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
    'writer',
    parsedInput.genre,
    ctx,
    factoryDeps,
  );

  // 4. LLM 呼出
  const completion = await client.complete({
    role: 'writer',
    genre: parsedInput.genre,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: buildUserMessage(parsedInput),
      },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const rawText = completion.text;
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw new AgentError('writer.chapter.invalid_output: empty response', {
      details: { rawText: String(rawText) },
    });
  }

  // 5. JSON 抽出 — schema-aware predicate で `body_md` を持つブロックを優先選択
  const parsedJson = extractJson(rawText, hasBodyMd);
  if (parsedJson === undefined) {
    throw new AgentError('writer.chapter.invalid_output: failed to parse JSON', {
      details: { rawText },
    });
  }

  // 6. zod 検証前に char_count / heading 欠落を救済 (LLM が省くケース)
  const normalized = normalizePartialOutput(parsedJson, parsedInput.outlineChapter.heading);
  const validated = WriterChapterOutputSchema.safeParse(normalized);
  if (!validated.success) {
    throw new AgentError('writer.chapter.invalid_output: schema validation failed', {
      details: { rawText, issues: validated.error.issues },
      cause: validated.error,
    });
  }

  // 7. 文字数集計を呼出側で再計算 (LLM 申告値は信用しない)。
  //    codepoint 数で数える ([...str].length) — 絵文字 surrogate pair を 2 文字で
  //    数えない (string.length だと "🎉" が 2 になる)。
  const actualChars = [...validated.data.body_md].length;
  const target = parsedInput.outlineChapter.target_chars;
  const minChars = Math.floor(target * (1 - CHAR_TOLERANCE));
  const maxChars = Math.ceil(target * (1 + CHAR_TOLERANCE));
  if (actualChars < minChars || actualChars > maxChars) {
    throw new AgentError('writer.chapter.chars_out_of_range', {
      details: {
        actual: actualChars,
        expected_min: minChars,
        expected_max: maxChars,
        target,
        tolerance: CHAR_TOLERANCE,
      },
    });
  }

  // 8. char_count は計算値で上書き (LLM 申告値を捨てる、信頼境界の整理)
  return {
    heading: validated.data.heading,
    body_md: validated.data.body_md,
    char_count: actualChars,
  };
}

/**
 * `body_md` を string で持つ object か (schema-aware extractor 用 predicate)。
 * zod 検証より緩いが、複数 balanced ブロックから「答えに使うべきラッパー」を
 * 選別するには十分。
 */
function hasBodyMd(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return typeof obj.body_md === 'string';
}

/**
 * LLM が `heading` や `char_count` を省いた場合の救済。
 * - heading 欠落 → outlineChapter.heading で補完
 * - char_count 欠落 → body_md から codepoint 数で計算して補完
 * zod 通過のための「形を整える」だけが目的。最終 char_count は呼出側で再計算上書き。
 */
function normalizePartialOutput(raw: unknown, fallbackHeading: string): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  if (typeof out.heading !== 'string' || out.heading.trim().length === 0) {
    out.heading = fallbackHeading;
  }
  if (typeof out.char_count !== 'number' && typeof out.body_md === 'string') {
    out.char_count = [...(out.body_md as string)].length;
  }
  return out;
}

/**
 * F-050 feedback (Array<{body, priority}>) を prompt 注入用の文字列に整形する。
 * priority 順 (must → should → may) に並べ替え、Writer が must を優先して反映できるようにする。
 * undefined / 空配列なら空文字を返す (placeholder にそのまま入る)。
 */
function formatFeedback(feedback: RevisionFeedbackItem[] | undefined): string {
  if (!feedback || feedback.length === 0) return '';
  const order = { must: 0, should: 1, may: 2 } as const;
  const sorted = [...feedback].sort((a, b) => order[a.priority] - order[b.priority]);
  return sorted
    .map((f) => `- [${f.priority.toUpperCase()}] ${f.body}`)
    .join('\n');
}

function buildUserMessage(input: WriterChapterInput): string {
  const lines = [
    `書籍タイトル: ${input.themeContext.title}`,
  ];
  if (input.themeContext.subtitle) {
    lines.push(`副題: ${input.themeContext.subtitle}`);
  }
  lines.push(
    `差別化フック: ${input.themeContext.hook}`,
    `想定読者: ${input.themeContext.target_reader}`,
    `ジャンル: ${input.genre ?? 'general'}`,
    '',
    '【執筆対象の章】',
    `第${input.outlineChapter.index}章: ${input.outlineChapter.heading}`,
    `章の要旨: ${input.outlineChapter.summary}`,
    `小見出し (順守): ${input.outlineChapter.subheadings.map((s, i) => `${i + 1}. ${s}`).join(' / ')}`,
    `目標文字数: ${input.outlineChapter.target_chars} 字 (±20% 厳守)`,
  );

  if (input.previousChaptersSummary && input.previousChaptersSummary.trim().length > 0) {
    lines.push(
      '',
      '【直前章までの要約 — 文体・論調の一貫性を保つこと】',
      input.previousChaptersSummary.trim(),
    );
  }

  if (input.feedback && input.feedback.length > 0) {
    lines.push(
      '',
      '【修正コメント — 必ず反映 (must は最優先、should/may は可能な範囲で)】',
      formatFeedback(input.feedback),
    );
  }

  lines.push(
    '',
    '上記の章について本文 (Markdown) を執筆してください。',
    'F-004 受入基準 (必ず遵守):',
    ` - 文字数: ${input.outlineChapter.target_chars} 字 の ±20% 範囲内 (本文純粋な文字数。Markdown 記号は含む、コードブロックは少なめに)`,
    ' - 小見出しは指定された順序で `## ` 見出しとして含める',
    ' - 章冒頭で導入、各小見出しごとに具体例・実践手順を含め、章末でまとめる',
    ' - 文体は「ですます」調で統一 (Editor が後段で検出するため違反すると差戻しになる)',
    '',
    '出力形式: JSON で以下を返してください。',
    '{',
    '  "heading": string,              // 章タイトル (基本は指定見出しを echo、微調整可)',
    '  "body_md": string,              // 本文 Markdown',
    '  "char_count": integer           // body_md の文字数 (codepoint 数)',
    '}',
    '',
    '**出力形式の厳格な制約**:',
    ' - 応答は **必ず単一の JSON オブジェクト** とし、トップレベルキーに `body_md` を含めること',
    ' - JSON 以外のテキスト (前置きコメント、説明、```json``` フェンス等) は応答に含めないこと',
    ' - **JSON 文字列値内では改行は必ず `\\n` (バックスラッシュ + n) でエスケープすること**',
  );
  return lines.join('\n');
}

// ===========================================================================
// JSON 抽出 — outline.ts / marketer/theme.ts と同実装 (schema-aware predicate 対応)
// 将来 lib/json-extract.ts に集約する余地は残すが、現時点では各エージェント側で
// 完結させ重複を許容する (Marketer/Writer/Editor で形が同じため共通化しやすい)。
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
  // 未エスケープの内側二重引用符まで修復してリトライ。
  try {
    return JSON.parse(sanitizeLlmJson(s));
  } catch {
    return undefined;
  }
}

/**
 * LLM 応答 JSON 内の string 値に混入する生改行 (\n / \r / \t) を escape する
 * defensive helper。state machine で inString 状態を追跡する。
 */
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
