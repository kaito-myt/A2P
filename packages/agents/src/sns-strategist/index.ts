/**
 * F-057 — SNS アカウント運用設計担当 (sns_strategist)。
 *
 * 接続済みチャンネル 1 つに対して「誰が・何を発信するアカウントか」を設計する
 * ランタイムエージェント。concept/display_name/bio/発信の柱/トーン/投稿頻度/
 * ハッシュタグ/グロース戦術/アイコン・カバー画像プロンプトまでを一括で出す。
 *
 * account-strategist と同パターン: loadActivePrompt → createAgentClient → responseSchema。
 * 画像生成 (generateStrategyImages) は gpt-image-1 を使い、文字を描かせず後段(運営者)が
 * プロフィールに適用する前提。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import {
  AccountStrategyProfileSchema,
  type AccountStrategyProfile,
  type SnsStrategistInput,
} from '@a2p/contracts/agents/sns-strategist';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';
import { generateImage as defaultGenerateImage, type GenerateImageFn } from '../tools/image-gen.js';

// リッチな日本語プロファイル(柱+画像プロンプト2本)は 3072 では途中切れし
// generateObject が "No object generated" になるため十分に確保する。
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** チャンネル種別 → 日本語ラベル (プロンプト内表示用)。 */
const CHANNEL_LABEL: Record<string, string> = {
  x: 'X (旧 Twitter)',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  note: 'note',
  blog: 'ブログ (自社所有)',
};

/** チャンネル別の bio 文字数目安 (プロンプトに埋め込み)。 */
const BIO_LIMIT: Record<string, number> = {
  x: 160,
  instagram: 150,
  tiktok: 80,
  note: 400,
  blog: 400,
};

export interface SnsStrategistDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  orgTaskId?: string;
}

/**
 * SNS アカウント運用プロファイルを設計する。
 */
export async function planSnsStrategy(
  input: SnsStrategistInput,
  deps: SnsStrategistDeps = {},
): Promise<AccountStrategyProfile> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const channelLabel = CHANNEL_LABEL[input.channel] ?? input.channel;
  const bioLimit = BIO_LIMIT[input.channel] ?? 300;

  const prompt = await loadPrompt('sns_strategist', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    channel_label: channelLabel,
    bio_limit: String(bioLimit),
  });

  const ctx: LoggingContext = { role: 'sns_strategist' };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('sns_strategist', null, ctx, factoryDeps);

  const completion = await client.complete<AccountStrategyProfile>({
    role: 'sns_strategist',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildSnsStrategistUserMessage(input, channelLabel, bioLimit) },
    ],
    responseSchema: AccountStrategyProfileSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return AccountStrategyProfileSchema.parse(completion.text);
}

export function buildSnsStrategistUserMessage(
  input: SnsStrategistInput,
  channelLabel: string,
  bioLimit: number,
): string {
  const inv = Object.entries(input.catalog.genre_inventory ?? {});
  const inventory = inv.length ? inv.map(([g, n]) => `- ${g}: ${n}冊`).join('\n') : '(在庫データなし)';
  const titles = input.catalog.sample_titles.length
    ? input.catalog.sample_titles.slice(0, 15).map((t) => `- ${t}`).join('\n')
    : '(なし)';
  const readers = input.catalog.target_readers.length
    ? input.catalog.target_readers.slice(0, 12).map((t) => `- ${t}`).join('\n')
    : '(なし)';

  const lines = [
    `あなたは KDP 出版事業の SNS アカウント運用を設計する担当です。対象チャンネルは「${channelLabel}」。`,
    'このチャンネルで運用する **1 アカウント** の設計を、そのまま実運用できる具体度で出してください。',
    '',
    `【対象チャンネル】${channelLabel}`,
    input.current_handle ? `【現在のハンドル】${input.current_handle}` : '【現在のハンドル】(未設定)',
    '',
    '【販売中の本ジャンル内訳】',
    inventory,
    '',
    '【代表的な書名】',
    titles,
    '',
    '【想定ターゲット読者】',
    readers,
    '',
    input.instruction ? `【運営者からの指示】\n${input.instruction}\n` : '',
    '設計要件:',
    '- concept: このアカウントは「本を売る宣伝垢」ではなく、読者に毎回価値を配る存在として位置づける。',
    '  在庫ジャンルの読者が「フォローする理由」を一言で言えるポジショニングにする。',
    `- display_name: 覚えやすく検索されやすい表示名 (30字以内目安)。`,
    '- handle_suggestion: @なし英数字/アンダースコア。',
    `- bio: ${channelLabel} のプロフィール欄にそのまま貼れる文 (${bioLimit}字以内)。価値提案＋人物像＋導線を含める。`,
    '- content_pillars: 発信の柱を3〜6本。各柱に name / description / そのまま投稿できる example_post。',
    '- tone_of_voice: 語り口 (敬体/常体・絵文字の是非・一人称など)。',
    '- posting_cadence: 現実的な投稿頻度と、そのチャンネルで反応が良い時間帯(JST)。',
    '- hashtag_strategy: core(毎回)/rotating(話題別)。各タグは # 付き。X/TikTok はタグ過多を避ける。',
    '- growth_tactics: そのチャンネルの伸ばし方 (X=スレッド/引用/リプ, Instagram=カルーセル/リール, ',
    '  TikTok=フック優先の短尺, note=SEO長文, blog=内部リンク/回遊)。2〜8個。',
    '- avatar_prompt / banner_prompt: gpt-image-1 用の英語または日本語プロンプト。**画像に文字・ロゴ・',
    '  数字を一切入れない**前提で、世界観・色・被写体・雰囲気を具体的に。avatar は正方形、banner は横長。',
    '- 誇張せず、在庫と読者に接地した現実的な設計にする。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

// ---------------------------------------------------------------------------
// アイコン / カバー画像生成 (gpt-image-1)
// ---------------------------------------------------------------------------

/** 文字を描かせないためのガード文を画像プロンプトに付す。 */
const NO_TEXT_GUARD =
  ' 重要: 画像内に文字・ロゴ・数字・記号を一切描かないこと。テキストなしの純粋なビジュアルのみ。';

export interface StrategyImages {
  /** 正方形アイコン (1024x1024, PNG)。 */
  avatar: Buffer;
  /** 横長カバー/ヘッダー (1536x1024, PNG)。 */
  banner: Buffer;
}

export interface GenerateStrategyImagesDeps {
  /** テスト差し替え / withImageLogging 済み関数の注入口。既定は素の generateImage。 */
  generateImage?: GenerateImageFn;
}

/**
 * プロファイルの avatar_prompt / banner_prompt から、アイコンとカバー画像を生成する。
 * 文字化けを避けるため gpt-image-1 には文字を描かせない (NO_TEXT_GUARD)。
 */
export async function generateStrategyImages(
  profile: Pick<AccountStrategyProfile, 'avatar_prompt' | 'banner_prompt'>,
  deps: GenerateStrategyImagesDeps = {},
): Promise<StrategyImages> {
  const gen = deps.generateImage ?? defaultGenerateImage;

  const avatarRes = await gen({
    prompt: `${profile.avatar_prompt}${NO_TEXT_GUARD}`,
    width: 1024,
    height: 1024,
    quality: 'medium',
    outputFormat: 'png',
  });
  const bannerRes = await gen({
    prompt: `${profile.banner_prompt}${NO_TEXT_GUARD}`,
    width: 1536,
    height: 1024,
    quality: 'medium',
    // 育成投稿(F-059)の IG メディアに流用するため JPEG(IG は JPEG 必須)。
    outputFormat: 'jpeg',
    outputCompression: 90,
  });

  const avatar = avatarRes.images[0];
  const banner = bannerRes.images[0];
  if (!avatar || !banner) {
    throw new Error('generateStrategyImages: 画像生成結果が空です');
  }
  return { avatar, banner };
}
