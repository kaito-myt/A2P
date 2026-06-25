/**
 * F-020b — Readings エージェント (タイトル/サブタイトル/著者名のフリガナ生成)。
 *
 * judge / cover_text_check と同パターン:
 *  1. loadActivePrompt('readings', genre)
 *  2. createAgentClient('readings', genre, ctx)  (token 記録 wrap 済)
 *  3. client.complete({ messages, responseSchema })  → カタカナ読み
 *
 * ローマ字は LLM に任せず kanaToRomaji で決定的に変換する (本関数の戻り値に含める)。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import {
  ReadingsInputSchema,
  ReadingsOutputSchema,
  type ReadingsInput,
  type ReadingsOutput,
} from '@a2p/contracts/agents/readings';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';
import { kanaToRomaji } from '../lib/kana-to-romaji.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 512;

export interface GenerateReadingsDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
}

/** カナ読み + ローマ字をまとめた結果。 */
export interface ReadingsResult {
  title_kana: string;
  title_romaji: string;
  subtitle_kana: string;
  subtitle_romaji: string;
  author_kana: string;
  author_romaji: string;
}

export async function generateReadings(
  input: ReadingsInput,
  deps: GenerateReadingsDeps = {},
): Promise<ReadingsResult> {
  const parsed = ReadingsInputSchema.parse(input);
  const genre = parsed.genre ?? null;

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('readings', genre, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {});

  const ctx: LoggingContext = { role: 'readings', bookId: parsed.bookId };
  if (parsed.jobId !== undefined) ctx.jobId = parsed.jobId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('readings', genre, ctx, factoryDeps);

  const completion = await client.complete<ReadingsOutput>({
    role: 'readings',
    genre,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(parsed) },
    ],
    responseSchema: ReadingsOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const kana = ReadingsOutputSchema.parse(completion.text);

  return {
    title_kana: kana.title_kana,
    title_romaji: kanaToRomaji(kana.title_kana),
    subtitle_kana: kana.subtitle_kana,
    subtitle_romaji: kanaToRomaji(kana.subtitle_kana),
    author_kana: kana.author_kana,
    author_romaji: kanaToRomaji(kana.author_kana),
  };
}

function buildUserMessage(input: ReadingsInput): string {
  const lines = [
    '以下の日本語の「タイトル」「サブタイトル」「著者名」について、',
    'KDP 入稿用の**カタカナのヨミ（フリガナ）**を生成してください。',
    '',
    `タイトル: ${input.title}`,
    `サブタイトル: ${input.subtitle ?? '(なし)'}`,
    `著者名: ${input.author}`,
    '',
    'ルール:',
    ' - 出力はすべて**全角カタカナ**。ひらがな・漢字・ローマ字を混ぜない。',
    ' - 英単語や数字は一般的な日本語読みをカタカナにする (例: AI→エーアイ, 5→ゴ)。',
    ' - 記号・装飾は読まない。読みが不要/不能な場合は空文字にする。',
    ' - 人名 (著者名) は最も自然な読みを推定する。',
    ' - 出力は指定の JSON スキーマ (title_kana / subtitle_kana / author_kana) に厳密に従う。',
  ];
  return lines.join('\n');
}
