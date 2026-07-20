/**
 * F-059 — 育成投稿担当 (content_creator)。
 *
 * アカウント戦略の「発信の柱」から、宣伝ではない価値提供型の投稿を生成する。
 * フォロワー獲得(=アカウントを育てる)ための投稿。sns_strategist と同パターン。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import {
  AccountContentOutputSchema,
  type AccountContentOutput,
  type ContentCreatorInput,
} from '@a2p/contracts/agents/content-creator';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import { extractLlmJson } from '../lib/sanitize-llm-json.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

// 複数の育成投稿(日本語)を JSON で返すため、途中切れしないよう十分に確保する。
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

const CHANNEL_LABEL: Record<string, string> = {
  x: 'X (旧 Twitter)',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  note: 'note',
  blog: 'ブログ (自社所有)',
};

/** チャンネル別の1投稿の長さ目安 (プロンプトに埋め込む)。 */
const LEN_GUIDE: Record<string, string> = {
  x: '日本語で110〜130字程度(140字以内。ハッシュタグ・URLは含めない)',
  instagram: 'キャプション2〜4文＋自然な余白',
  tiktok: '短いフック1文＋補足1〜2文(写真モードのキャプション)',
  note: '見出し＋2〜4段落のミニ記事',
  blog: '見出し＋2〜4段落の記事',
};

export interface ContentCreatorDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  orgTaskId?: string;
}

export async function createAccountContent(
  input: ContentCreatorInput,
  deps: ContentCreatorDeps = {},
): Promise<AccountContentOutput> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const channelLabel = CHANNEL_LABEL[input.channel] ?? input.channel;
  const lenGuide = LEN_GUIDE[input.channel] ?? '簡潔に';

  const prompt = await loadPrompt('content_creator', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    channel_label: channelLabel,
    length_guide: lenGuide,
  });

  const ctx: LoggingContext = { role: 'content_creator' };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('content_creator', null, ctx, factoryDeps);

  // generateObject は不安定なため generateText + extractLlmJson で受ける(sns_strategist と同様)。
  const completion = await client.complete<string>({
    role: 'content_creator',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildContentCreatorUserMessage(input, channelLabel, lenGuide) },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const parsed = extractLlmJson<unknown>(completion.text);
  if (parsed === undefined) {
    throw new Error('content_creator: 応答から JSON を抽出できませんでした');
  }
  return AccountContentOutputSchema.parse(parsed);
}

export function buildContentCreatorUserMessage(
  input: ContentCreatorInput,
  channelLabel: string,
  lenGuide: string,
): string {
  const pillars = input.pillars
    .map((p, i) => `${i + 1}. ${p.name}${p.description ? ` — ${p.description}` : ''}${p.example_post ? `\n   例: ${p.example_post}` : ''}`)
    .join('\n');
  const readers = input.target_readers.length ? input.target_readers.slice(0, 8).map((t) => `- ${t}`).join('\n') : '(なし)';
  const titles = input.sample_titles.length ? input.sample_titles.slice(0, 10).map((t) => `- ${t}`).join('\n') : '(なし)';

  const lines = [
    `あなたは「${channelLabel}」でフォロワーを増やすための **育成投稿(価値提供型)** を作る担当です。`,
    'これは宣伝(本の告知)ではありません。読者が「役に立った/共感した/保存したい」と思い、フォローしたくなる投稿を作ります。',
    '',
    input.concept ? `【アカウントのコンセプト】\n${input.concept}` : '',
    input.tone_of_voice ? `【トーン&マナー】\n${input.tone_of_voice}` : '',
    '',
    '【発信の柱(この軸で作る)】',
    pillars,
    '',
    '【想定読者】',
    readers,
    '',
    '【世界観の参考(※売り込みには使わない・本の宣伝はしない)】',
    titles,
    '',
    `【作る数】${input.count} 投稿`,
    '',
    '要件:',
    `- 各投稿は完成文でそのまま投稿できる状態にする。長さの目安: ${lenGuide}。`,
    '- **本やAmazonの宣伝・購入誘導・URLは入れない**(それは別の宣伝投稿が担う)。ハッシュタグも入れない(後段で付与)。',
    '- 発信の柱をバランス良く使い、実用的で具体的、保存・共有したくなる内容にする。',
    '- 各投稿に、どの柱かを pillar(柱の name)として付ける。',
    '- トーンを一貫させ、テンプレっぽさや誇張・煽りを避ける。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
