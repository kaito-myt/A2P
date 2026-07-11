/**
 * docs/06 P3 — 販促アナリスト (promo_analyst)。販促本部の担当者。
 * 投稿実績（PromotionPost の投稿/失敗/予約状況）と売上を突き合わせ、
 * 効いている施策・不振・次サイクルの改善示唆（本部横断）を構造化して返す。
 *
 * sales_analyst と同パターン: loadActivePrompt → createAgentClient → responseSchema。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import { PromoAnalysisOutputSchema, type PromoAnalysisOutput } from '@a2p/contracts/org';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 3072;

/** 販促効果検証に渡すスナップショット（worker が DB から集約）。 */
export interface PromoSnapshot {
  period_label: string;
  /** チャンネル別の投稿状況（posted/scheduled/failed 件数）。 */
  channels: Array<{ channel: string; posted: number; scheduled: number; failed: number; auto_enabled: boolean }>;
  /** 書籍別の投稿実績×売上。 */
  per_book: Array<{ title: string; posted: number; royalty_jpy: number; genre?: string | null }>;
  total_posted: number;
  total_failed: number;
  /** 本部長からの実行指示（instruction）。 */
  instruction?: string;
}

export interface PromoAnalystInput {
  snapshot: PromoSnapshot;
}

export interface PromoAnalystDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  orgTaskId?: string;
}

export async function analyzePromotion(
  input: PromoAnalystInput,
  deps: PromoAnalystDeps = {},
): Promise<PromoAnalysisOutput> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('promo_analyst', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    period_label: input.snapshot.period_label,
  });

  const ctx: LoggingContext = { role: 'promo_analyst' };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('promo_analyst', null, ctx, factoryDeps);

  const completion = await client.complete<PromoAnalysisOutput>({
    role: 'promo_analyst',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildPromoAnalystUserMessage(input.snapshot) },
    ],
    responseSchema: PromoAnalysisOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return PromoAnalysisOutputSchema.parse(completion.text);
}

export function buildPromoAnalystUserMessage(s: PromoSnapshot): string {
  const channels = s.channels.length
    ? s.channels
        .map(
          (c) =>
            `- ${c.channel}: 投稿${c.posted} / 予約${c.scheduled} / 失敗${c.failed}${c.auto_enabled ? ' (自動ON)' : ' (自動OFF)'}`,
        )
        .join('\n')
    : '(チャンネル実績なし)';
  const perBook = s.per_book.length
    ? s.per_book
        .slice(0, 20)
        .map(
          (b) =>
            `- 「${b.title}」投稿${b.posted}件 → ¥${b.royalty_jpy.toLocaleString('ja-JP')}${b.genre ? ` (${b.genre})` : ''}`,
        )
        .join('\n')
    : '(書籍別実績なし)';
  const lines = [
    'あなたは KDP 出版事業を運営する AI 企業の「販促アナリスト」です。',
    '以下の投稿実績と売上を突き合わせ、効いている販促・不振・次サイクルの改善示唆をまとめてください。',
    '',
    `【対象期間】${s.period_label}`,
    `【累計投稿】${s.total_posted}件 / 【失敗】${s.total_failed}件`,
    '',
    '【チャンネル別】',
    channels,
    '',
    '【書籍別（投稿→売上）】',
    perBook,
    '',
    s.instruction ? `【本部長からの指示】\n${s.instruction}\n` : '',
    '出力要件:',
    '- summary は経営が3秒で掴める要約。',
    '- highlights は効いている施策/チャンネル、underperformers は投稿しても伸びない箇所。',
    '- suggestions は本部横断の改善提案（division＋action＋根拠）。販促の頻度/チャンネル/告知文、または制作・出版の連動を具体的に。',
    '- 投稿失敗が多いチャンネルは接続/自動設定の見直しを sysops/promotion へ促す。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
