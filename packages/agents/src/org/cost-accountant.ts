/**
 * docs/06 P3 — コスト会計 (cost_accountant)。経営管理本部の担当者。
 * 本部別コスト・書籍別ROI（制作+販促コスト対 売上）の集計結果を受け、
 * 赤字/低ROI書籍の指摘と是正示唆（凍結/再配分/制作絞り込み）を構造化して返す。
 *
 * 集計そのものは worker（決定的処理）が行い、本エージェントは講評＋示唆を担う。
 * sales_analyst と同パターン: loadActivePrompt → createAgentClient → responseSchema。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import { CostReportOutputSchema, type CostReportOutput } from '@a2p/contracts/org';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 3072;

/** コスト集計スナップショット（worker が token_usage / SalesRecord から集約）。 */
export interface CostSnapshot {
  period_label: string;
  total_cost_jpy: number;
  total_royalty_jpy: number;
  monthly_budget_jpy: number | null;
  /** 本部別の予算配分と実コスト。 */
  by_division: Array<{ division: string; label: string; allocated: number | null; spent: number; ratio: number | null }>;
  /** 書籍別 ROI（コスト対 売上）。 */
  per_book: Array<{ title: string; cost_jpy: number; royalty_jpy: number; roi: number | null; genre?: string | null }>;
  /** 本部長からの実行指示（instruction）。 */
  instruction?: string;
}

export interface CostAccountantInput {
  snapshot: CostSnapshot;
}

export interface CostAccountantDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  orgTaskId?: string;
}

export async function reviewCosts(
  input: CostAccountantInput,
  deps: CostAccountantDeps = {},
): Promise<CostReportOutput> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('cost_accountant', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    period_label: input.snapshot.period_label,
  });

  const ctx: LoggingContext = { role: 'cost_accountant' };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('cost_accountant', null, ctx, factoryDeps);

  const completion = await client.complete<CostReportOutput>({
    role: 'cost_accountant',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildCostAccountantUserMessage(input.snapshot) },
    ],
    responseSchema: CostReportOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return CostReportOutputSchema.parse(completion.text);
}

function pct(ratio: number | null): string {
  return ratio == null ? '—' : `${Math.round(ratio * 100)}%`;
}

export function buildCostAccountantUserMessage(s: CostSnapshot): string {
  const byDivision = s.by_division.length
    ? s.by_division
        .map(
          (d) =>
            `- ${d.label}: 実コスト¥${d.spent.toLocaleString('ja-JP')}${d.allocated != null ? ` / 予算¥${d.allocated.toLocaleString('ja-JP')} (${pct(d.ratio)})` : ' (予算未設定)'}`,
        )
        .join('\n')
    : '(本部別データなし)';
  const perBook = s.per_book.length
    ? s.per_book
        .slice(0, 20)
        .map(
          (b) =>
            `- 「${b.title}」コスト¥${b.cost_jpy.toLocaleString('ja-JP')} / 売上¥${b.royalty_jpy.toLocaleString('ja-JP')} (ROI ${b.roi == null ? '—' : `${Math.round(b.roi * 100)}%`})${b.genre ? ` (${b.genre})` : ''}`,
        )
        .join('\n')
    : '(書籍別データなし)';
  const lines = [
    'あなたは KDP 出版事業を運営する AI 企業の「コスト会計(CFO補佐)」です。',
    '以下の本部別コストと書籍別ROIを分析し、赤字/低ROIの指摘と是正示唆をまとめてください。',
    '',
    `【対象期間】${s.period_label}`,
    `【当月コスト】¥${s.total_cost_jpy.toLocaleString('ja-JP')}${s.monthly_budget_jpy != null ? ` / 月次上限¥${s.monthly_budget_jpy.toLocaleString('ja-JP')}` : ''}`,
    `【累計ロイヤリティ】¥${s.total_royalty_jpy.toLocaleString('ja-JP')}`,
    '',
    '【本部別コスト（予算消化）】',
    byDivision,
    '',
    '【書籍別ROI（コスト対 売上）】',
    perBook,
    '',
    s.instruction ? `【本部長/CEOからの指示】\n${s.instruction}\n` : '',
    '出力要件:',
    '- summary は経営が3秒で掴める要約（コスト健全性と予算消化）。',
    '- loss_making は赤字/低ROIの書籍タイトル。',
    '- suggestions は是正提案（division＋action＋根拠）。低ROI本部の制作を絞る/伸びてる本部へ再配分する等を具体的に。',
    '- コストは低いが露出不足で売上0の書籍は「制作より販促」を促す。逆に高コスト赤字は制作停止を検討。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
