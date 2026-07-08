/**
 * F-051 — Promoter エージェント (販促施策プラン生成)。
 *
 * 出版した本を「売れる」状態にするための具体的な販促プランを生成する。
 * judge / readings と同パターン (loadActivePrompt → createAgentClient → responseSchema)。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import {
  PromotionInputSchema,
  PromotionPlanOutputSchema,
  type PromotionInput,
  type PromotionPlanOutput,
} from '@a2p/contracts/agents/promoter';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 6144;

export interface GeneratePromotionDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
}

/**
 * 本の企画・実績から販促プランを生成する。
 *
 * @throws ProviderError LLM API 失敗 (透過)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function generatePromotionPlan(
  input: PromotionInput,
  deps: GeneratePromotionDeps = {},
): Promise<PromotionPlanOutput> {
  const parsed = PromotionInputSchema.parse(input);
  const genre = parsed.genre ?? null;

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('promoter', genre, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    genre: parsed.genre ?? 'general',
  });

  const ctx: LoggingContext = { role: 'promoter', bookId: parsed.bookId };
  if (parsed.jobId !== undefined) ctx.jobId = parsed.jobId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('promoter', genre, ctx, factoryDeps);

  const completion = await client.complete<PromotionPlanOutput>({
    role: 'promoter',
    genre,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(parsed) },
    ],
    responseSchema: PromotionPlanOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return PromotionPlanOutputSchema.parse(completion.text);
}

function buildUserMessage(input: PromotionInput): string {
  const b = input.book;
  const lines = [
    '以下の Amazon KDP 電子書籍について、出版後に「売れる」状態へ持っていく',
    '具体的な販促プランを作成してください。',
    '',
    `タイトル: ${b.title}`,
    `副題: ${b.subtitle ?? '(なし)'}`,
    `差別化フック: ${b.hook ?? '(なし)'}`,
    `想定読者: ${b.target_reader ?? '(なし)'}`,
    `ジャンル: ${input.genre ?? 'general'}`,
    `著者名: ${b.author ?? '(なし)'}`,
    `現在価格: ${b.price_jpy != null ? `${b.price_jpy}円` : '(未設定)'}`,
    `キーワード: ${b.keywords.length > 0 ? b.keywords.join(', ') : '(なし)'}`,
    `紹介文: ${b.description ? b.description.slice(0, 600) : '(なし)'}`,
  ];
  if (input.performance) {
    lines.push(
      '',
      '【直近の実績】',
      `直近ロイヤリティ: ${input.performance.recent_royalty_jpy ?? '(不明)'}円`,
      `レビュー数: ${input.performance.review_count ?? 0}`,
      `平均星: ${input.performance.avg_stars ?? '(不明)'}`,
    );
  }
  lines.push(
    '',
    '【求める内容】',
    ' - summary: 全体の販促方針。',
    ' - pricing: ローンチ価格 / 通常価格 / KDPセレクト(独占)登録の是非 / 無料キャンペーン・',
    '   Kindleカウントダウン等の使い方。KDPの制度を正しく踏まえる。',
    ' - category_keyword_actions: 1位を取りやすいカテゴリ選定やキーワード再最適化の具体策。',
    ' - review_actions: 初速レビューを増やす具体的アクション (規約順守。レビュー購入や身内の',
    '   やらせは提案しない)。',
    ' - launch_checklist: 出版直後にやることを timing 付きで。',
    ' - promo_copy: **そのままコピペして使える告知文**。x_posts は複数の X(Twitter) 投稿案',
    '   (各140字目安・ハッシュタグ込み)、note_article は note 記事の下書き、blog_outline は',
    '   ブログ告知の骨子。読者の悩みに刺さる訴求にする。誇大表現・虚偽の効能は避ける。',
    ' - ongoing_calendar: 出版後に継続すべき施策を when 付きで。',
    '',
    '指定された JSON スキーマに厳密に従って構造化出力してください。日本語で。',
  );
  return lines.join('\n');
}
