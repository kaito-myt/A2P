/**
 * F-064 — 研究駆動の販促プレイブック担当 (promo_strategist)。
 *
 * web_search で「そのジャンル/プラットフォームで今伸びている本紹介・販促投稿」の傾向を
 * 実地リサーチし、投稿生成に注入できる構造化プレイブック(PromoPlaybook)を出力する。
 * marketer と同じく AgentSdkClient(web_search server tool) 経由 + generateText + extractLlmJson。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import {
  PromoStrategistOutputSchema,
  type PromoStrategistInput,
  type PromoPlaybook,
} from '@a2p/contracts/agents/promo-strategist';
import { genreLabel } from '@a2p/contracts/genres';

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

export interface PromoStrategistDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
}

export async function generatePromoPlaybook(
  input: PromoStrategistInput,
  deps: PromoStrategistDeps = {},
): Promise<PromoPlaybook> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const channelLabel = CHANNEL_LABEL[input.channel] ?? input.channel;
  const genre = genreLabel(input.genre ?? undefined) ?? '実用書・ビジネス書・自己啓発';
  const prompt = await loadPrompt('promo_strategist', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, { channel_label: channelLabel, genre });

  const ctx: LoggingContext = { role: 'promo_strategist' };
  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('promo_strategist', null, ctx, factoryDeps);

  const completion = await client.complete<string>({
    role: 'promo_strategist',
    genre: input.genre ?? null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildStrategistUserMessage(input, channelLabel, genre) },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const parsed = extractLlmJson<unknown>(completion.text);
  if (parsed === undefined) {
    throw new Error('promo_strategist: 応答から JSON を抽出できませんでした');
  }
  return PromoStrategistOutputSchema.parse(parsed);
}

export function buildStrategistUserMessage(
  input: PromoStrategistInput,
  channelLabel: string,
  genre: string,
): string {
  const recent = input.recent_posts.length
    ? input.recent_posts.slice(0, 6).map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
    : '(まだ無し)';

  return [
    `「${channelLabel}」で、${genre} の電子書籍(Kindle)を売るための販促プレイブックを作ります。`,
    'web_search で「今この分野/プラットフォームで実際に伸びている本紹介・販促投稿」を調べ、',
    '再現可能な勝ちパターンを抽出してください。一般論でなく具体・実践的に。',
    '',
    input.concept ? `【アカウントのコンセプト】\n${input.concept}` : '',
    '',
    '【現状の投稿サンプル(改善対象の把握用)】',
    recent,
    '',
    '調べること:',
    `- ${channelLabel} で伸びている本紹介/読書系アカウントの投稿の型(フック・見出し・構成)`,
    '- 反応(保存/シェア/フォロー)を生むキャプション/CTA の書き方',
    '- 効果的なハッシュタグ(規模別: ビッグ/ミッド/ニッチ)',
    '- 投稿に向く時間帯(JST)',
    channelLabel.includes('TikTok') ? '- 短尺動画で視聴維持するテンポ/フック/尺' : '- 画像クリエイティブで購買を促す要素',
    '',
    '出力は JSON の PromoPlaybook のみ:',
    '{"channel":string,"summary":string,"hook_formulas":[{"name","template","example"}],',
    '"headline_styles":[string],"content_angles":[string],',
    '"hashtag_tiers":{"big":[string],"mid":[string],"niche":[string]},',
    '"cta_patterns":[string],"posting_times":[string],"creative_notes":[string],"do_this":[string]}。',
    'do_this は投稿生成へそのまま渡す短い実践指針(3〜6行)。',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
