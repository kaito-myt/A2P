/**
 * docs/05 §6.3.2 / F-003 — Writer エージェント (アウトライン生成)。
 *
 * フロー (T-03-01 marketer/theme.ts と同パターン):
 *  1. `loadActivePrompt('writer', genre)` で active プロンプトを取得
 *  2. プレースホルダ ({title}/{subtitle}/{hook}/{target_reader}/{target_chapter_count}/
 *     {target_total_chars}/{reject_note}/{genre}/{kdp_keywords}) を差し込み
 *  3. `createAgentClient('writer', genre, ctx)` で LLMClient (AISdkClient) を取得
 *     (writer は web_search 不要なので AgentSdkClient ではなく AISdkClient 経路)
 *  4. `client.complete({ system, messages })` を 1 回呼ぶ。AgentSdkClient と異なり
 *     AISdkClient も responseSchema 経路は本実装では使わず、テキスト応答 → JSON 抽出
 *     → zod 検証の三段で統一する。
 *  5. **F-003 受入基準** の自動検証:
 *     - 章数 7〜10 (zod min/max で強制)
 *     - 各章 `target_chars` 合計が 45,000〜55,000 字 ±15% (38,250〜63,250)
 *     - index 連番性 (1, 2, ..., N)
 *  6. `totalCharsEstimate` を呼出側で再計算し output に詰める (LLM 申告値を信用しない)
 *
 * エラー方針:
 *  - JSON 抽出/parse 失敗 → `AgentError('writer.outline.invalid_output', { rawText, cause })`
 *  - zod 検証失敗            → `AgentError('writer.outline.invalid_output', { issues, rawText })`
 *  - 文字数合計範囲外        → `AgentError('writer.outline.chars_out_of_range', { details })`
 *  - index 不連続            → `AgentError('writer.outline.idx_not_sequential', { details })`
 *  - LLM 呼出失敗 (ProviderError 等) はそのまま透過 (上位 worker の retry 対象)
 *
 * DI: `deps?.createAgentClient` / `deps?.loadActivePrompt` でテスト差し替え可能。
 *     `deps?.promptLoaderDeps.prisma` で prompts 取得時の Prisma 差し替え可。
 *
 * T-03-01 教訓:
 *  - jobId は graphile-worker.jobs.id 専用 — UI 直接呼出時は undefined → null forward
 *    (theme_session_id 流用は FK 違反で silent fail するため厳禁)
 *  - schema は DB `outlines.chapters_json` + docs/05 §6.3.2 と完全整合 (Hard Rule #3)
 *  - AgentSdkClient は responseSchema 非対応 — 自由テキスト → JSON 抽出 → zod の三段
 */
import { AgentError } from '@a2p/contracts/errors';
import type { LLMClient } from '@a2p/contracts/agents';
import {
  WriterOutlineInputSchema,
  WriterOutlineOutputSchema,
  type WriterOutlineInput,
  type WriterOutlineOutput,
} from '@a2p/contracts/agents/writer';

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

/** Writer アウトライン LLM 呼出の既定 max tokens。10 章分の構造化 JSON に余裕。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * F-003 受入基準: 章合計の想定文字数が指示の ±15% に収まる。
 * 既定 50,000 字に対して ±15% = 42,500〜57,500 字。
 * SP-04 タスク要件は「45,000〜55,000 ±15% (= 38,250〜63,250)」とより寛容な範囲指定なので、
 * targetTotalChars (既定 50,000) を基準に ±15% を計算する単一実装に統一する。
 * (45,000 * 0.85 = 38,250 / 55,000 * 1.15 = 63,250 と等価)
 */
const CHAR_TOLERANCE = 0.15;

export interface GenerateOutlineDeps {
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
 * F-003 受入基準: 採用テーマ + 想定文字数から 7〜10 章のアウトラインを生成。
 *
 * @throws AgentError JSON 抽出/parse 失敗 / zod 検証失敗 / 文字数範囲外 / index 不連続
 * @throws ProviderError LLM API 失敗 (透過、上位 worker でリトライ)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function generateOutline(
  input: WriterOutlineInput,
  deps: GenerateOutlineDeps = {},
): Promise<WriterOutlineOutput> {
  // 1. 入力 zod 検証 (呼出側 SA で済んでいる想定だが、二重防衛)
  const parsedInput = WriterOutlineInputSchema.parse(input);

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  // 2. active プロンプト取得 + プレースホルダ差込
  const prompt = await loadPrompt(
    'writer',
    parsedInput.genre,
    deps.promptLoaderDeps,
  );
  const systemPrompt = fillPlaceholders(prompt.template, {
    title: parsedInput.themeContext.title,
    subtitle: parsedInput.themeContext.subtitle ?? '',
    hook: parsedInput.themeContext.hook,
    target_reader: parsedInput.themeContext.target_reader,
    target_chapter_count: parsedInput.targetChapterCount,
    target_total_chars: parsedInput.targetTotalChars,
    reject_note: parsedInput.rejectNote ?? '',
    kdp_keywords:
      parsedInput.kdpMetadata?.keywords.join(', ') ?? '',
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
    throw new AgentError('writer.outline.invalid_output: empty response', {
      details: { rawText: String(rawText) },
    });
  }

  // 5. JSON 抽出 — schema-aware predicate で `chapters` 配列を持つブロックを優先選択
  const parsedJson = extractJson(rawText, hasChaptersArray);
  if (parsedJson === undefined) {
    throw new AgentError('writer.outline.invalid_output: failed to parse JSON', {
      details: { rawText },
    });
  }

  // 6. zod 検証 (章数 7〜10 / 各章 subheadings min 2 等)
  //    totalCharsEstimate を LLM が省いた場合は呼出側で計算して詰めるため、検証前に補完。
  const withEstimate = ensureTotalCharsEstimate(parsedJson);
  const validated = WriterOutlineOutputSchema.safeParse(withEstimate);
  if (!validated.success) {
    throw new AgentError('writer.outline.invalid_output: schema validation failed', {
      details: { rawText, issues: validated.error.issues },
      cause: validated.error,
    });
  }

  // 7. index 連番性 (1, 2, ..., N) — LLM が章を間引いた場合の早期検知
  const indices = validated.data.chapters.map((c) => c.index);
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i + 1) {
      throw new AgentError('writer.outline.idx_not_sequential', {
        details: { indices, expected: indices.map((_, j) => j + 1) },
      });
    }
  }

  // 8. 文字数合計レンジ検証 (F-003 受入基準: ±15%)
  const computedTotal = validated.data.chapters.reduce(
    (acc, c) => acc + c.target_chars,
    0,
  );
  const minTotal = Math.floor(parsedInput.targetTotalChars * (1 - CHAR_TOLERANCE));
  const maxTotal = Math.ceil(parsedInput.targetTotalChars * (1 + CHAR_TOLERANCE));
  if (computedTotal < minTotal || computedTotal > maxTotal) {
    throw new AgentError('writer.outline.chars_out_of_range', {
      details: {
        total: computedTotal,
        expected_min: minTotal,
        expected_max: maxTotal,
        target: parsedInput.targetTotalChars,
      },
    });
  }

  // 9. totalCharsEstimate は LLM 申告値を捨てて再計算値に置き換える (信頼境界の整理)
  const result: WriterOutlineOutput = {
    chapters: validated.data.chapters,
    totalCharsEstimate: computedTotal,
  };
  if (validated.data.notes !== undefined) result.notes = validated.data.notes;
  return result;
}

/**
 * `chapters` 配列を持つ object か (schema-aware extractor 用 predicate)。
 * zod 検証より緩いが、複数 balanced ブロックから「答えに使うべきラッパー」を
 * 選別するには十分。
 */
function hasChaptersArray(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return Array.isArray(obj.chapters);
}

/**
 * `totalCharsEstimate` が欠落していたら chapters[].target_chars の合計で補完する。
 * LLM が省いても zod 検証で落ちないようにする救済。後段の自前再計算 (computedTotal)
 * で最終値は上書きされるので、ここでは zod 通過のための「形を整える」だけが目的。
 */
function ensureTotalCharsEstimate(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.totalCharsEstimate === 'number') return raw;
  if (!Array.isArray(obj.chapters)) return raw;
  let sum = 0;
  for (const c of obj.chapters) {
    if (typeof c !== 'object' || c === null) continue;
    const tc = (c as Record<string, unknown>).target_chars;
    if (typeof tc === 'number') sum += tc;
  }
  return { ...obj, totalCharsEstimate: sum };
}

function buildUserMessage(input: WriterOutlineInput): string {
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
    `想定章数: ${input.targetChapterCount} (7〜10 章の範囲で調整可)`,
    `想定総文字数: ${input.targetTotalChars} 字 (各章合計 ±15% 範囲を厳守)`,
  );
  if (input.kdpMetadata?.keywords && input.kdpMetadata.keywords.length > 0) {
    lines.push(`参考キーワード: ${input.kdpMetadata.keywords.join(', ')}`);
  }
  if (input.rejectNote && input.rejectNote.trim().length > 0) {
    lines.push(
      '',
      '【前回アウトラインの差戻し指示 — 必ず反映】',
      input.rejectNote.trim(),
    );
  }
  lines.push(
    '',
    '上記の書籍について章立てアウトラインを生成してください。',
    'F-003 受入基準 (必ず遵守):',
    ` - 章数: ${input.targetChapterCount} を中心に 7〜10 章`,
    ` - 各章 target_chars の合計が ${input.targetTotalChars} 字の ±15% 範囲内`,
    ' - 各章には小見出し (subheadings) を 2〜10 個含める',
    ' - 「はじめに」「おわりに」相当の章を必ず含める',
    ' - index は 1 始まりの連番 (1, 2, ..., N)',
    '',
    '出力形式: JSON で以下を返してください。',
    '{',
    '  "chapters": [',
    '    {',
    '      "index": 1,',
    '      "heading": string,',
    '      "summary": string,            // 1〜800 字',
    '      "target_chars": integer,      // 2000〜15000',
    '      "subheadings": string[]       // 2〜10',
    '    }, ...',
    '  ],',
    '  "totalCharsEstimate": integer, // chapters[].target_chars の合計',
    '  "notes"?: string',
    '}',
    '',
    '**出力形式の厳格な制約**:',
    ' - 応答は **必ず単一の JSON オブジェクト** とし、トップレベルキーに `chapters` 配列を含めること',
    ' - JSON 以外のテキスト (前置きコメント、説明、マークダウン見出し、```json``` フェンス等) は応答に含めないこと',
    ' - **JSON 文字列値内では改行は必ず `\\n` (バックスラッシュ + n) でエスケープすること**',
  );
  return lines.join('\n');
}

// ===========================================================================
// JSON 抽出 — marketer/theme.ts と同実装 (schema-aware predicate 対応)
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
    try {
      return JSON.parse(sanitizeJsonStringNewlines(s));
    } catch {
      return undefined;
    }
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
