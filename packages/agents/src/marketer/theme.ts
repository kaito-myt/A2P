/**
 * docs/05 §6.3.1 / F-001 — Marketer エージェント (テーマ生成)。
 *
 * フロー:
 *  1. `loadActivePrompt('marketer', genre)` で active プロンプトを取得
 *  2. プレースホルダ ({brief}/{genre}/{count}/{exclude_titles}) を差し込み
 *  3. `createAgentClient('marketer', genre, ctx)` で AgentSdkClient を取得
 *     (`web_search_20250305` server tool 同梱、`withTokenLogging` 自動ラップ済み)
 *  4. `client.complete({ system, messages })` を 1 回呼ぶ — AgentSdkClient は
 *     `responseSchema` を受け付けないため、テキスト応答から JSON 部分を抽出 → zod 検証
 *  5. 同セッション内 title 重複 + `excludeTitlesRecent` と重複するものを除外
 *
 * エラー方針:
 *  - JSON 抽出/parse 失敗 → `AgentError('marketer.theme.invalid_output', { rawText, cause })`
 *  - zod 検証失敗            → `AgentError('marketer.theme.invalid_output', { issues, rawText })`
 *  - 重複除外後に候補 0 件   → `AgentError('marketer.theme.all_duplicates', { excluded })`
 *  - LLM 呼出失敗 (ProviderError 等) はそのまま透過 (上位 worker の retry 対象)
 *
 * DI: `deps?.createAgentClient` / `deps?.loadActivePrompt` でテスト差し替え可能。
 *     `deps?.prisma` は loadActivePrompt 内部の repo 差し替えに使う (vitest テストで
 *     Prisma を引かないため)。
 */
import { AgentError } from '@a2p/contracts/errors';
import type { LLMClient } from '@a2p/contracts/agents';
import {
  MarketerThemeInputSchema,
  MarketerThemeOutputSchema,
  type MarketerThemeInput,
  type MarketerThemeOutput,
  type ThemeCandidate,
} from '@a2p/contracts/agents/marketer';

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

/** Marketer LLM 呼出の既定 max tokens。10 件分の構造化 JSON を返す余裕。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface GenerateThemesDeps {
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
 * F-001 受入基準: ユーザーキーワード/ブリーフから複数 (既定 10) のテーマ候補を生成する。
 *
 * @throws AgentError JSON 抽出/parse 失敗 / zod 検証失敗 / 全候補が重複で除外
 * @throws ProviderError LLM API 失敗 (透過、上位 worker でリトライ)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function generateMarketerThemes(
  input: MarketerThemeInput,
  deps: GenerateThemesDeps = {},
): Promise<MarketerThemeOutput> {
  // 1. 入力 zod 検証 (呼出側 SA で済んでいる想定だが、二重防衛)
  const parsedInput = MarketerThemeInputSchema.parse(input);

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  // 2. active プロンプト取得 + プレースホルダ差込
  const prompt = await loadPrompt(
    'marketer',
    parsedInput.genre,
    deps.promptLoaderDeps,
  );
  const systemPrompt = fillPlaceholders(prompt.template, {
    brief: parsedInput.keywordOrBrief,
    genre: parsedInput.genre ?? 'general',
    count: parsedInput.count,
    exclude_titles:
      parsedInput.excludeTitlesRecent.length > 0
        ? parsedInput.excludeTitlesRecent.map((t) => ` - ${t}`).join('\n')
        : '(なし)',
  });

  // 3. AgentSdkClient (web_search server tool 同梱、withTokenLogging ラップ済み) 取得
  //    - jobId は graphile-worker の jobs.id 専用 (FK 制約)。テーマ生成は worker 経由
  //      呼び出し時のみ jobId が input に乗る。UI 直接呼び出し時は undefined → null。
  //      themeSessionId を流用すると token_usage.job_id の FK 違反で silent fail する。
  const ctx: LoggingContext = {
    role: 'marketer',
    themeSessionId: parsedInput.themeSessionId,
    jobId: parsedInput.jobId,
  };
  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient(
    'marketer',
    parsedInput.genre,
    ctx,
    factoryDeps,
  );

  // 4. LLM 呼出 — system に差込済プロンプト、user に簡易指示 (テンプレ依存しすぎを避ける)
  const completion = await client.complete({
    role: 'marketer',
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
    throw new AgentError('marketer.theme.invalid_output: empty response', {
      details: { rawText: String(rawText) },
    });
  }

  // 5. JSON 抽出 + zod 検証
  //    schema-aware predicate を渡し、`candidates` キーを持つブロックを優先選択。
  //    これにより LLM が candidates ラッパーの前後に別の {...} ブロック (例:
  //    competitor の単体 JSON、example object) を混ぜても誤採用されず、決定論的
  //    失敗 (前 iteration で起きた `candidates: undefined` schema 違反) を回避する。
  const parsedJson = extractJson(rawText, hasCandidatesArray);
  if (parsedJson === undefined) {
    throw new AgentError('marketer.theme.invalid_output: failed to parse JSON', {
      details: { rawText },
    });
  }

  const validated = MarketerThemeOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AgentError('marketer.theme.invalid_output: schema validation failed', {
      details: { rawText, issues: validated.error.issues },
      cause: validated.error,
    });
  }

  // 6. 重複除外: candidates 内同一 title + excludeTitlesRecent と一致
  const excludeSet = new Set(
    parsedInput.excludeTitlesRecent.map((t) => normalizeTitle(t)),
  );
  const seen = new Set<string>();
  const deduped: ThemeCandidate[] = [];
  for (const c of validated.data.candidates) {
    const norm = normalizeTitle(c.title);
    if (excludeSet.has(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    deduped.push(c);
  }

  if (deduped.length === 0) {
    throw new AgentError('marketer.theme.all_duplicates', {
      details: {
        originalCount: validated.data.candidates.length,
        excludedRecent: parsedInput.excludeTitlesRecent.length,
      },
    });
  }

  const result: MarketerThemeOutput = { candidates: deduped };
  if (validated.data.notes !== undefined) result.notes = validated.data.notes;
  return result;
}

/**
 * title 比較用の正規化 — NFKC 正規化 + 前後空白除去 + lower-case。
 * NFKC により全角/半角・濁点合成等が統一され、`Excel` と `Ｅｘｃｅｌ` を同一視できる。
 */
function normalizeTitle(t: string): string {
  return t.normalize('NFKC').trim().toLowerCase();
}

function buildUserMessage(input: MarketerThemeInput): string {
  const lines = [
    `キーワード/ブリーフ: ${input.keywordOrBrief}`,
    `生成数: ${input.count}`,
    `ジャンル: ${input.genre ?? 'general'}`,
  ];
  if (input.excludeTitlesRecent.length > 0) {
    lines.push(`直近採用済みタイトル (避ける):\n${input.excludeTitlesRecent.map((t) => ` - ${t}`).join('\n')}`);
  }
  lines.push(
    '',
    '出力形式: JSON で `{ "candidates": [...], "notes"?: string }` を返してください。',
    '各 candidate は以下のキーを必ず含めます (docs/05 §6.3.1 準拠):',
    ' - title: string (200 字以内)',
    ' - subtitle?: string (200 字以内、任意)',
    ' - hook: string (差別化要素、800 字以内)',
    ' - target_reader: string (想定読者、300 字以内)',
    ' - competitors: Array<{ title, asin?, author?, url?, rank?, review_summary?, note? }> (web_search で見つけた競合)',
    ' - signals: {',
    '     reasoning: string (選定根拠、1000 字以内),',
    '     market_score: integer 0-100,',
    '     predicted_chapters: integer 3-20 (既定 8),',
    '     search_keywords: string[] (最大 10),',
    '     search_volume?: number, rank_estimate?: number, sources?: string[]',
    '   }',
    '',
    '**出力形式の厳格な制約 (違反すると後段 parser が失敗する)**:',
    ' - 応答は **必ず単一の JSON オブジェクト** とし、トップレベルキーに `candidates` 配列を含めること',
    ' - `candidates` キーを含まない他の JSON オブジェクト (説明用 example、競合書籍の単体 JSON、ノートだけのブロック等) を応答内に混ぜないこと',
    ' - JSON 以外のテキスト (前置きコメント、説明、マークダウン見出し、```json``` フェンス等) は応答に含めないこと',
    ' - 競合書籍は **必ず candidates[].competitors 配列の中** に格納し、トップレベルや別ブロックに置かないこと',
    ' - **JSON 文字列値内では改行は必ず `\\n` (バックスラッシュ + n) でエスケープすること**。',
    '   生の改行文字を文字列の中に入れると JSON.parse が失敗するため、各 string 値は単一行に収めること。',
    ' - 引用文・paraphrase・hook・reasoning など長文を含むフィールドも例外なく `\\n` エスケープし、生改行を絶対に混ぜないこと。',
  );
  return lines.join('\n');
}

/**
 * LLM テキスト応答から JSON オブジェクトを抽出する。
 *
 * 戦略 (T-03-06 iteration 4 で schema-aware 化):
 *  1. 全フェンス (` ```[lang?] ... ``` `) と全 `{` 起点 balanced ブロックから
 *     parse 成功した候補集合を作る
 *  2. `predicate` 指定時: predicate を満たす **最初** の候補を返す
 *     (例: `hasCandidatesArray` を渡すと `{ candidates: [...] }` 形式を優先)
 *  3. predicate 未指定または該当なし: object 型候補のうち **最大** のものを返す
 *     (説明 fence + 答え block のように複数 JSON が混ざる場合、最大 = 最も
 *     情報密度の高いブロックを選ぶ)
 *
 * これにより LLM が candidates ラッパーの前に独立した `{...}` ブロック
 * (競合書籍の単体 JSON 等) を混ぜても誤採用されず、決定論的失敗 (前 iteration
 * で起きた `candidates: undefined` schema 違反) を回避できる。
 *
 * 失敗時は undefined を返す (呼出側で AgentError に変換)。
 */
function extractJson<T = unknown>(
  text: string,
  predicate?: (parsed: unknown) => boolean,
): T | undefined {
  const trimmed = text.trim();
  const candidates: unknown[] = [];

  // 1a) 純粋な JSON テキスト全体
  const direct = tryParse(trimmed);
  if (direct !== undefined) candidates.push(direct);

  // 1b) ```[lang]? ... ``` フェンス全マッチ
  const fenceRe = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    const body = m[1]?.trim();
    if (!body) continue;
    const parsed = tryParse(body);
    if (parsed !== undefined) candidates.push(parsed);
    // fence 内の balanced ブロックも収集 (fence body が JSON 以外の混在テキストの場合)
    collectBalanced(body, candidates);
  }

  // 1c) 閉じ忘れた fence: `\`\`\`json` 以降を fence なし扱いで balanced 収集
  const openFence = /```(?:[a-zA-Z0-9_-]+)?\s*/.exec(trimmed);
  if (openFence) {
    const after = trimmed.slice(openFence.index + openFence[0].length);
    collectBalanced(after, candidates);
  }

  // 1d) 全 `{` 起点 balanced ブロック収集
  collectBalanced(trimmed, candidates);

  // 2) predicate 適合ブロック優先
  if (predicate) {
    for (const c of candidates) {
      if (predicate(c)) return c as T;
    }
    // 適合なし: undefined (呼出側で AgentError) — fallback はしない
    // (predicate を渡した呼出側は「適合 schema を要求」しているため、
    //  最大ブロックを返しても下流 zod で同じ失敗になる)
    return undefined;
  }

  // 3) predicate なし: 最大 object 候補 (後方互換)
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

/**
 * 文字列内の全 `{` 候補から balanced ブロックを切り出し、parse 成功したものを
 * `out` に push する。文字列リテラル内の `{`/`}` は無視する。
 * (前バージョンの `scanBalanced` は first-match return だったが、collect 方式に
 *  改めて全候補を呼出側に渡し、適合性判定を委譲する。)
 */
function collectBalanced(text: string, out: unknown[]): void {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findMatchingBrace(text, start);
    if (end === -1) continue;
    const parsed = tryParse(text.slice(start, end + 1));
    if (parsed !== undefined) out.push(parsed);
  }
}

/**
 * MarketerThemeOutput schema 適合性の事前判定 — トップレベルに `candidates`
 * 配列を持つ object か。zod 検証より緩いが、複数 balanced ブロックから
 * 「答えに使うべきラッパー」を選別するには十分。
 */
function hasCandidatesArray(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return Array.isArray(obj.candidates);
}

/** start 位置の `{` に対応する閉じ `}` の index を返す。見つからなければ -1。 */
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
    // LLM が JSON 文字列値内に生改行を混ぜた場合の defensive fallback。
    // 正常な JSON は sanitizer 通過後も無変更で parse 成功する。
    try {
      return JSON.parse(sanitizeJsonStringNewlines(s));
    } catch {
      return undefined;
    }
  }
}

/**
 * LLM 応答に頻出する「JSON string 値内の生改行」を escape する defensive helper。
 * state machine で inString 状態を追跡し、文字列内の生 `\n` / `\r` / `\t` を
 * `\\n` / `\\r` / `\\t` に置換する。文字列外の改行/インデントには触れない。
 * バックスラッシュ escape (例: `\"`, `\\`) は維持し、二重 escape しない。
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
