/**
 * docs/06 P2 — 市場アナリスト (market_analyst)。分析本部の担当者。
 * 本部長の指示（ジャンル/競合/検索需要）を受け、伸びるジャンルの機会と
 * 次テーマ案、本部横断の改善示唆を構造化して返す。
 *
 * 注: 将来は Marketer の web_search 基盤を流用するが、web_search を使う AgentSdkClient は
 * responseSchema を許容しないため、P2 では AISdkClient（構造化出力）で運用する。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import { MarketResearchOutputSchema, type MarketResearchOutput } from '@a2p/contracts/org';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 3072;

/** 市場リサーチに渡すコンテキスト（worker が DB から集約）。 */
export interface MarketContext {
  period_label: string;
  /** 本部長からの実行指示（instruction）。 */
  instruction: string;
  /** 現状の在庫ジャンル内訳（genre → 冊数）。 */
  genre_inventory: Record<string, number>;
  /** 売れ筋（分析素材）。 */
  top_books: Array<{ title: string; royalty_jpy: number; genre?: string | null }>;
}

export interface MarketAnalystInput {
  context: MarketContext;
}

export interface MarketAnalystDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  orgTaskId?: string;
}

export async function researchMarket(
  input: MarketAnalystInput,
  deps: MarketAnalystDeps = {},
): Promise<MarketResearchOutput> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('market_analyst', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    period_label: input.context.period_label,
  });

  const ctx: LoggingContext = { role: 'market_analyst' };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('market_analyst', null, ctx, factoryDeps);

  const completion = await client.complete<MarketResearchOutput>({
    role: 'market_analyst',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildMarketAnalystUserMessage(input.context) },
    ],
    responseSchema: MarketResearchOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return MarketResearchOutputSchema.parse(completion.text);
}

export function buildMarketAnalystUserMessage(c: MarketContext): string {
  const inv = Object.entries(c.genre_inventory);
  const inventory = inv.length ? inv.map(([g, n]) => `- ${g}: ${n}冊`).join('\n') : '(在庫なし)';
  const top = c.top_books.length
    ? c.top_books
        .slice(0, 10)
        .map((b) => `- 「${b.title}」¥${b.royalty_jpy.toLocaleString('ja-JP')}${b.genre ? ` (${b.genre})` : ''}`)
        .join('\n')
    : '(売れ筋データなし)';
  const lines = [
    'あなたは KDP 出版事業（実用書・ビジネス書・自己啓発）を運営する AI 企業の「市場アナリスト」です。',
    '本部長の指示を受け、伸びるジャンルの機会と、次に制作すべきテーマ案をまとめてください。',
    '',
    `【対象期間】${c.period_label}`,
    '',
    '【本部長からの指示】',
    c.instruction || '(特記なし。自社在庫と売れ筋を踏まえ機会を提案)',
    '',
    '【現在の在庫ジャンル内訳】',
    inventory,
    '',
    '【自社の売れ筋】',
    top,
    '',
    '出力要件:',
    '- genre_opportunities は実用書/ビジネス書/自己啓発の範囲で、需要が見込める切り口を根拠付きで。',
    '- theme_ideas は制作本部がそのまま企画に使えるタイトル案＋切り口。',
    '- suggestions は本部横断の改善提案（division＋action＋根拠）。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
