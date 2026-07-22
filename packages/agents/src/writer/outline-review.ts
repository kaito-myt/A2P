/**
 * F-003b — Outline Review エージェント (章立ての校正)。
 *
 * generateOutline が機械的制約 (章数/文字数/連番) を保証した後に呼ばれ、章立ての
 * 「意味的な正しさ」を診る: 章の重複、網羅漏れ、順序、粒度の偏り、導入/結びの不備、
 * タイトルとの整合。問題があれば改善版アウトライン (revised_chapters) を返す。
 *
 * judge / cover_art_direction と同パターン (loadActivePrompt → createAgentClient →
 * responseSchema 構造化出力)。
 */
import { genreLabel } from '@a2p/contracts/agents';
import type { LLMClient } from '@a2p/contracts/agents';
import {
  OutlineReviewInputSchema,
  OutlineReviewOutputSchema,
  type OutlineReviewInput,
  type OutlineReviewOutput,
} from '@a2p/contracts/agents/writer';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface ReviewOutlineDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
}

/**
 * アウトラインを構成観点で校正する。
 *
 * @throws ProviderError LLM API 失敗 (透過)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function reviewOutline(
  input: OutlineReviewInput,
  deps: ReviewOutlineDeps = {},
): Promise<OutlineReviewOutput> {
  const parsed = OutlineReviewInputSchema.parse(input);
  const genre = parsed.genre ?? null;

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('outline_review', genre, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    genre: genreLabel(parsed.genre) ?? 'general',
  });

  const ctx: LoggingContext = { role: 'outline_review', bookId: parsed.bookId };
  if (parsed.jobId !== undefined) ctx.jobId = parsed.jobId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('outline_review', genre, ctx, factoryDeps);

  const completion = await client.complete<OutlineReviewOutput>({
    role: 'outline_review',
    genre,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(parsed) },
    ],
    responseSchema: OutlineReviewOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return OutlineReviewOutputSchema.parse(completion.text);
}

function buildUserMessage(input: OutlineReviewInput): string {
  const c = input.themeContext;
  const lines = [
    'あなたは実用書/ビジネス書/自己啓発書の編集者です。以下の書籍の「章立て(アウトライン)」を',
    '構成の観点で校正してください。誤字脱字ではなく、**章の立て方そのものの妥当性**を診ます。',
    '',
    `タイトル: ${c.title}`,
    `副題: ${c.subtitle ?? '(なし)'}`,
    `差別化フック: ${c.hook}`,
    `想定読者: ${c.target_reader}`,
    `ジャンル: ${genreLabel(input.genre) ?? 'general'}`,
    `想定総文字数: ${input.targetTotalChars} 字`,
    '',
    '【校正対象の章立て】',
    ...input.chapters.map(
      (ch) =>
        `${ch.index}. ${ch.heading} (${ch.target_chars}字)\n   要旨: ${ch.summary}\n   小見出し: ${ch.subheadings.join(' / ')}`,
    ),
    '',
    '【診る観点】',
    ' - duplication: 章同士で内容が重複・カブっていないか',
    ' - coverage_gap: タイトル/フックが約束する内容に抜け漏れがないか',
    ' - ordering: 読者が理解しやすい論理順序になっているか (前提→本論→実践→まとめ 等)',
    ' - granularity: 粒度が揃っているか、分量(文字数)配分に不自然な偏りがないか',
    ' - intro_outro: 「はじめに」相当の導入と「おわりに」相当の結びが適切にあるか',
    ' - title_mismatch: 各章がタイトル/副題の約束を果たす内容になっているか',
    '',
    '【出力方針】',
    ' - 問題点は issues に severity/category/対象章index/detail/suggestion で列挙する。',
    ' - 章立てに実質的な問題があれば、**直した完全な章立てを revised_chapters に入れる**',
    '   (generateOutline と同じ形式: index 連番/各章 target_chars/subheadings 2〜10、',
    `    合計 target_chars は ${input.targetTotalChars} 字の ±15% 内、章数 7〜10)。`,
    '   問題が軽微で修正不要なら revised_chapters は省略し overall_ok=true にする。',
    ' - summary に全体講評を日本語で簡潔に書く。',
    '',
    '指定の JSON スキーマに厳密に従って構造化出力してください。',
  ];
  return lines.join('\n');
}
