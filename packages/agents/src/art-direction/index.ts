/**
 * Cover Art Direction エージェント — Marketer 目線で「売れる」表紙ビジュアル方向性を決める。
 *
 * ラノベ風固定をやめ、ジャンル・ターゲット読者に刺さる絵作りを本ごとに選ばせる。
 * 出力の `image_prompt` (英語) を gpt-image-1 に渡し、文字は別レイヤーで合成する
 * (compose-cover)。よって本エージェントは「絵の内容」だけを設計する。
 *
 * judge / readings と同パターン:
 *  1. loadActivePrompt('cover_art_direction', genre)
 *  2. createAgentClient('cover_art_direction', genre, ctx)  (token 記録 wrap 済)
 *  3. client.complete({ messages, responseSchema })  → directions[]
 */
import type { LLMClient } from '@a2p/contracts/agents';
import { AgentError } from '@a2p/contracts/errors';
import {
  CoverArtDirectionInputSchema,
  CoverArtDirectionOutputSchema,
  type CoverArtDirectionInput,
  type CoverArtDirectionOutput,
} from '@a2p/contracts/agents/thumbnail';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

export interface GenerateCoverArtDirectionDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
}

/**
 * 本の企画から「売れる」表紙アート方向性を count 案生成する。
 *
 * @throws ProviderError LLM API 失敗 (透過)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function generateCoverArtDirection(
  input: CoverArtDirectionInput,
  deps: GenerateCoverArtDirectionDeps = {},
): Promise<CoverArtDirectionOutput> {
  const parsed = CoverArtDirectionInputSchema.parse(input);
  const genre = parsed.genre ?? null;

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('cover_art_direction', genre, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    genre: parsed.genre ?? 'general',
    count: parsed.count,
  });

  const ctx: LoggingContext = { role: 'cover_art_direction', bookId: parsed.bookId };
  if (parsed.jobId !== undefined) ctx.jobId = parsed.jobId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('cover_art_direction', genre, ctx, factoryDeps);

  // AgentSdkClient (web_search 同梱) は responseSchema を受け付けないため、marketer と
  // 同じくテキスト応答から JSON を抽出して zod 検証する。
  const completion = await client.complete({
    role: 'cover_art_direction',
    genre,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(parsed) },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const raw = typeof completion.text === 'string' ? completion.text : JSON.stringify(completion.text);
  const json = extractJson(raw);
  const validated = CoverArtDirectionOutputSchema.safeParse(json);
  if (!validated.success) {
    throw new AgentError('cover_art_direction: 応答を CoverArtDirectionOutput として検証できませんでした', {
      details: { issues: validated.error.issues, rawPreview: raw.slice(0, 500) },
    });
  }
  return validated.data;
}

/**
 * LLM のテキスト応答から JSON オブジェクトを抽出する。
 * ```json フェンスや前後の散文を許容し、最初の `{` 〜 最後の `}` を試す。
 * 文字列値内の生改行は JSON.parse を壊すためエスケープしてリトライする。
 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text.trim());

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      try {
        return JSON.parse(sanitizeJsonStringNewlines(c));
      } catch {
        /* try next candidate */
      }
    }
  }
  throw new AgentError('cover_art_direction: 応答から JSON を抽出できませんでした', {
    details: { rawPreview: text.slice(0, 500) },
  });
}

/** JSON 文字列リテラル内の生改行/タブをエスケープして JSON.parse を通す。 */
function sanitizeJsonStringNewlines(text: string): string {
  let inString = false;
  let escaped = false;
  let out = '';
  for (const ch of text) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString && ch === '\n') {
      out += '\\n';
      continue;
    }
    if (inString && ch === '\r') continue;
    if (inString && ch === '\t') {
      out += '\\t';
      continue;
    }
    out += ch;
  }
  return out;
}

function buildUserMessage(input: CoverArtDirectionInput): string {
  const c = input.themeContext;
  const lines = [
    'あなたは KDP (Amazon 電子書籍) の表紙アートディレクター兼マーケターです。',
    '以下の本について、「Amazon の一覧で目を引き、クリック・購入につながる」表紙の',
    `ビジュアル方向性を ${input.count} 案、互いに大きく異なるアプローチで提案してください。`,
    '',
    `タイトル: ${c.title}`,
    `サブタイトル: ${c.subtitle ?? '(なし)'}`,
    `差別化フック: ${c.hook}`,
    `想定読者: ${c.target_reader}`,
    `ジャンル: ${input.genre ?? 'general'}`,
    '',
    '## 手順 (必ずこの順で考える)',
    '1. **Amazon Kindle の売れ筋表紙を web_search で実地調査する**。この本のジャンル/サブジャンル/',
    '   トピックに近い、実際に売れている(ランキング上位の)電子書籍の**表紙デザインの傾向**を調べる。',
    '   例: 「Amazon Kindle <ジャンル/トピック> ベストセラー 表紙」「kindle <topic> bestseller book cover」等で検索し、',
    '   支配的な画風(写真的/イラスト/アニメ・マンガ調/ミニマル・タイポ/象徴的/3D/手描き等)、配色、',
    '   構図、被写体の傾向を把握する。',
    '2. その調査を踏まえ、**この本に最適な画風を判断する**。「ラノベ風」も「リアル(写真)風」も、',
    '   どちらかに固定しない。売れ筋の王道に寄せるか、あえて外して目立たせるかも含めて、',
    '   この本・この読者に最も刺さる方向を選ぶ。',
    '3. 互いに**画風・被写体・構図・雰囲気・配色が明確に異なる** ' + String(input.count) + ' 案を作る',
    '   (例: 王道に寄せた案 / 差別化で目立たせる案 / タイポ主体の案 など、幅を持たせる)。',
    '',
    '## 各案の要件',
    ' - image_prompt は英語で、gpt-image-1 が忠実に描けるよう具体的に記述する',
    '   (被写体/構図/ライティング/色/質感/雰囲気)。画風は案ごとに明示する。',
    ' - **画像内に文字・ロゴ・タイトルは一切入れない**前提で絵の内容だけを書く',
    '   (タイトル等は後で別レイヤーとして合成する)。タイトルを置く余白 (通常は下部) を残す構図にする。',
    ' - concept (日本語) には「調査した売れ筋の傾向」と「なぜこの画風がこの読者に売れるのか」を簡潔に書く。',
    ' - style_label に画風 (例: "写真的" "アニメ調イラスト" "ミニマル・タイポ" "象徴的" 等) を必ず入れる。',
    '',
    '## 出力',
    'web_search の後、**最終回答は JSON オブジェクトのみ**を出力する (前後に散文を付けない)。',
    'スキーマ: {"directions": [{"concept": string(日本語), "image_prompt": string(英語),',
    ' "palette"?: string, "style_label"?: string}, ...]} で directions は ' + String(input.count) + ' 件。',
  ];
  return lines.join('\n');
}
