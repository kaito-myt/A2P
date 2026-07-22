/**
 * F-061 — 日次投稿見直し担当 (content_optimizer)。
 *
 * 予定投稿(scheduled)の本文を、アカウント戦略・直近の投稿傾向・(任意で)外部シグナルを
 * 踏まえて推敲・改善する。宣伝(promo)投稿は購入導線/URL を保持し、育成(value)投稿は
 * 価値提供の質を高める。ハッシュタグは後段で付与するため本文には足さない。
 *
 * content_creator と同じく generateText + extractLlmJson で受ける（形状ドリフト耐性）。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import {
  ContentOptimizerOutputSchema,
  type ContentOptimizerInput,
  type ContentOptimizerOutput,
} from '@a2p/contracts/agents/content-optimizer';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import { extractLlmJson } from '../lib/sanitize-llm-json.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

const CHANNEL_LABEL: Record<string, string> = {
  x: 'X (旧 Twitter)',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  note: 'note',
  blog: 'ブログ (自社所有)',
};

export interface ContentOptimizerDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
}

export async function optimizeScheduledPosts(
  input: ContentOptimizerInput,
  deps: ContentOptimizerDeps = {},
): Promise<ContentOptimizerOutput> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const channelLabel = CHANNEL_LABEL[input.channel] ?? input.channel;
  const prompt = await loadPrompt('content_optimizer', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, { channel_label: channelLabel });

  const ctx: LoggingContext = { role: 'content_optimizer' };
  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('content_optimizer', null, ctx, factoryDeps);

  const completion = await client.complete<string>({
    role: 'content_optimizer',
    genre: input.genre ?? null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildOptimizerUserMessage(input, channelLabel) },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const parsed = extractLlmJson<unknown>(completion.text);
  if (parsed === undefined) {
    throw new Error('content_optimizer: 応答から JSON を抽出できませんでした');
  }
  return ContentOptimizerOutputSchema.parse(parsed);
}

export function buildOptimizerUserMessage(
  input: ContentOptimizerInput,
  channelLabel: string,
): string {
  const tags = input.hashtag_core.length ? input.hashtag_core.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ') : '(なし)';
  const recent = input.recent_posted.length
    ? input.recent_posted.slice(0, 8).map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
    : '(まだ無し)';
  const trending = input.signals?.trending_hashtags?.length
    ? input.signals.trending_hashtags.join(' ')
    : '(未取得)';
  const engagement = input.signals?.engagement_notes?.length
    ? input.signals.engagement_notes.map((n) => `- ${n}`).join('\n')
    : '(未取得)';

  const drafts = input.drafts
    .map((d, i) => `[${i + 1}] id=${d.id} kind=${d.kind}\n${d.body}`)
    .join('\n\n');

  return [
    `あなたは「${channelLabel}」の予定投稿を、公開前に見直して改善する編集者です。`,
    'エンゲージメント(反応/保存/フォロー)と、最終的な本の売上につながるよう、各投稿の本文を推敲します。',
    '',
    input.concept ? `【アカウントのコンセプト】\n${input.concept}` : '',
    input.tone_of_voice ? `【トーン&マナー】\n${input.tone_of_voice}` : '',
    `【定番ハッシュタグ(参考・本文には足さない)】\n${tags}`,
    '',
    '【直近の投稿(傾向把握用。丸写ししない)】',
    recent,
    '',
    '【外部シグナル】',
    `トレンドのハッシュタグ候補: ${trending}`,
    `直近の反応メモ:\n${engagement}`,
    '',
    '【見直し対象(この投稿群を改善する)】',
    drafts,
    '',
    '改善方針:',
    '- 冒頭1行でスクロールを止めるフック(問い/意外な事実/ベネフィット)を効かせる。',
    '- 具体的で、保存/共有したくなる情報にする。誇張・煽り・テンプレ感は避け、誠実に。',
    "- kind='promo'(販促)は、本の魅力と『KU会員は無料』等の導線・URL を必ず保持する(URLは消さない・改変しない)。",
    "- kind='value'(育成)は宣伝を入れない。ハッシュタグは本文に足さない(後段で付与)。",
    '- 文字数はチャンネルに適した長さに収める(X は日本語で概ね120字以内)。',
    '- 元が十分良ければ無理に変えず changed=false とし、revised_body には元の本文をそのまま返す。',
    '',
    '出力は JSON のみ。スキーマ: {"revisions":[{"id":string,"changed":boolean,"revised_body":string,"reason":string}]}。',
    '各 draft の id を必ず1件ずつ含めること。',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
