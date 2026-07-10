/**
 * docs/06 P2 — 売上アナリスト (sales_analyst)。分析本部の担当者。
 * SalesRecord ベースの売上スナップショットを受け、トレンド・売れ筋/不振・
 * 次サイクルへの改善示唆（本部横断）を構造化して返す。
 *
 * ceo / manager と同パターン: loadActivePrompt → createAgentClient → responseSchema。
 * web_search は使わない（構造化出力を優先）。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import { SalesAnalysisOutputSchema, type SalesAnalysisOutput } from '@a2p/contracts/org';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 3072;

/** 売上分析に渡すスナップショット（worker が DB から集約）。 */
export interface SalesSnapshot {
  period_label: string;
  total_royalty_jpy: number;
  last_month_royalty_jpy: number;
  months: Array<{ year_month: string; royalty_jpy: number }>;
  per_book: Array<{ title: string; royalty_jpy: number; genre?: string | null }>;
  published_count: number;
  /** 本部長からの実行指示（instruction）。 */
  instruction?: string;
}

export interface SalesAnalystInput {
  snapshot: SalesSnapshot;
}

export interface SalesAnalystDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  orgTaskId?: string;
}

export async function analyzeSales(
  input: SalesAnalystInput,
  deps: SalesAnalystDeps = {},
): Promise<SalesAnalysisOutput> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('sales_analyst', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    period_label: input.snapshot.period_label,
  });

  const ctx: LoggingContext = { role: 'sales_analyst' };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('sales_analyst', null, ctx, factoryDeps);

  const completion = await client.complete<SalesAnalysisOutput>({
    role: 'sales_analyst',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildSalesAnalystUserMessage(input.snapshot) },
    ],
    responseSchema: SalesAnalysisOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return SalesAnalysisOutputSchema.parse(completion.text);
}

export function buildSalesAnalystUserMessage(s: SalesSnapshot): string {
  const months = s.months.length
    ? s.months.map((m) => `- ${m.year_month}: ¥${m.royalty_jpy.toLocaleString('ja-JP')}`).join('\n')
    : '(月次データなし)';
  const perBook = s.per_book.length
    ? s.per_book
        .slice(0, 20)
        .map(
          (b) =>
            `- 「${b.title}」¥${b.royalty_jpy.toLocaleString('ja-JP')}${b.genre ? ` (${b.genre})` : ''}`,
        )
        .join('\n')
    : '(書籍別データなし)';
  const lines = [
    'あなたは KDP 出版事業を運営する AI 企業の「売上アナリスト」です。',
    '以下の売上データを分析し、トレンド・売れ筋/不振書籍・次サイクルの改善示唆をまとめてください。',
    '',
    `【対象期間】${s.period_label}`,
    `【出版済み書籍数】${s.published_count}`,
    `【累計ロイヤリティ】¥${s.total_royalty_jpy.toLocaleString('ja-JP')}`,
    `【先月ロイヤリティ】¥${s.last_month_royalty_jpy.toLocaleString('ja-JP')}`,
    '',
    '【月次推移】',
    months,
    '',
    '【書籍別ロイヤリティ】',
    perBook,
    '',
    s.instruction ? `【本部長からの指示】\n${s.instruction}\n` : '',
    '出力要件:',
    '- summary は経営が3秒で掴める要約。',
    '- suggestions は本部横断の改善提案（division＋action＋根拠）。制作/販促/出版のどこを動かすべきか具体的に。',
    '- データが乏しければ「まず在庫と露出を増やすべき」等、現状に即した現実的な示唆にする。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
