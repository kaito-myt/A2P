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

  const completion = await client.complete<CoverArtDirectionOutput>({
    role: 'cover_art_direction',
    genre,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(parsed) },
    ],
    responseSchema: CoverArtDirectionOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return CoverArtDirectionOutputSchema.parse(completion.text);
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
    '重要な指針:',
    ' - 画風を最初から「ラノベ風/イラスト」に固定しない。ジャンルと読者に最も刺さる画風を選ぶ。',
    '   実用書/ビジネス書なら「洗練された写真的」「ミニマルな図象＋余白」「大胆なタイポ空間」等、',
    '   自己啓発なら「象徴的・情緒的なイメージ」等、売れ筋の意匠を踏まえて最適な方向を選ぶ。',
    ' - 各案は画風・被写体・構図・雰囲気・配色が明確に異なること。',
    ' - image_prompt は英語で、gpt-image-1 が忠実に描けるよう具体的に記述する',
    '   (被写体/構図/ライティング/色/質感/雰囲気)。',
    ' - **画像内に文字・ロゴ・タイトルは一切入れない**前提で絵の内容だけを書く',
    '   (タイトル等は後で別レイヤーとして合成する)。タイトルを置く余白 (上部か下部) を残す構図にする。',
    ' - concept には「なぜこの絵がこの読者に売れるのか」を日本語で簡潔に書く。',
    '',
    `出力は指定の JSON スキーマ (directions: ${input.count} 件) に厳密に従うこと。`,
  ];
  return lines.join('\n');
}
