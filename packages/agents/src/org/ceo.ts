/**
 * docs/06 — CEO (社長エージェント)。全社状況スナップショットを受け、期間の方針
 * (Objective) ＋ 本部別予算配分 ＋ 各本部長へのブリーフを決定する。
 *
 * promoter / judge と同パターン: loadActivePrompt → createAgentClient → responseSchema。
 * web_search は使わない（構造化出力を優先。市場リサーチは分析本部の担当）。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import { CeoPlanOutputSchema, type CeoPlanOutput } from '@a2p/contracts/org';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** CEO に渡す全社スナップショット（worker が DB から集約して組み立てる）。 */
export interface CompanySnapshot {
  period_label: string;
  books: {
    total: number;
    by_status: Record<string, number>;
    needs_human_review: number;
    published: number;
  };
  sales: {
    last_month_royalty_jpy: number;
    total_royalty_jpy: number;
    top_books: Array<{ title: string; royalty_jpy: number }>;
  };
  cost: {
    month_jpy: number;
    monthly_budget_jpy?: number | null;
  };
  channels: {
    connected: string[];
    auto_enabled: string[];
  };
  open_tasks: number;
  /** 前サイクルの分析示唆など（あれば）。 */
  notes?: string;
}

export interface CeoPlanInput {
  snapshot: CompanySnapshot;
}

export interface CeoPlanDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  /** token_usage に紐づける org_task_id（あれば）。 */
  orgTaskId?: string;
}

export async function planObjective(
  input: CeoPlanInput,
  deps: CeoPlanDeps = {},
): Promise<CeoPlanOutput> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('ceo', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    period_label: input.snapshot.period_label,
  });

  const ctx: LoggingContext = { role: 'ceo' };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('ceo', null, ctx, factoryDeps);

  const completion = await client.complete<CeoPlanOutput>({
    role: 'ceo',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildCeoUserMessage(input.snapshot) },
    ],
    responseSchema: CeoPlanOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return CeoPlanOutputSchema.parse(completion.text);
}

export function buildCeoUserMessage(s: CompanySnapshot): string {
  const byStatus = Object.entries(s.books.by_status)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  const top = s.sales.top_books.length
    ? s.sales.top_books.map((b) => `「${b.title}」¥${b.royalty_jpy.toLocaleString('ja-JP')}`).join(' / ')
    : '(売上データなし)';
  const lines = [
    'あなたは KDP 出版事業を運営する AI 企業の社長(CEO)です。',
    '以下の全社状況を踏まえ、この期間の経営方針(Objective)・本部別の予算配分・',
    '各本部長への簡潔なブリーフを決定してください。',
    '',
    `【対象期間】${s.period_label}`,
    '',
    '【制作在庫】',
    `- 書籍総数: ${s.books.total}（出版済 ${s.books.published} / 要人手レビュー ${s.books.needs_human_review}）`,
    `- ステータス内訳: ${byStatus || '(なし)'}`,
    '',
    '【売上】',
    `- 先月ロイヤリティ: ¥${s.sales.last_month_royalty_jpy.toLocaleString('ja-JP')}`,
    `- 累計ロイヤリティ: ¥${s.sales.total_royalty_jpy.toLocaleString('ja-JP')}`,
    `- 売れ筋: ${top}`,
    '',
    '【コスト】',
    `- 当月コスト: ¥${s.cost.month_jpy.toLocaleString('ja-JP')}`,
    s.cost.monthly_budget_jpy != null
      ? `- 月次予算上限: ¥${s.cost.monthly_budget_jpy.toLocaleString('ja-JP')}`
      : '- 月次予算上限: (未設定)',
    '',
    '【販促チャンネル】',
    `- 接続済み: ${s.channels.connected.join(', ') || '(なし)'}`,
    `- 自動投稿ON: ${s.channels.auto_enabled.join(', ') || '(なし)'}`,
    '',
    `【進行中の全社タスク数】${s.open_tasks}`,
    s.notes ? `\n【申し送り/示唆】\n${s.notes}` : '',
    '',
    '出力要件:',
    '- goals は 2〜5 個。measurable な KPI を kpi に。',
    '- budget_allocation は当月コスト・予算上限を踏まえ本部別に JPY で配分（合計は budget_jpy 以内）。',
    '- division_briefs は「制作/出版/分析/販促/運用/経営管理」の各本部長への1〜3文の指示。',
    '  今サイクルで注力すべき本部だけ埋め、動かさない本部は省略可。',
    '- 暴走防止: 制作点数や投稿量は控えめに。コストが予算を圧迫するなら制作を絞り分析/販促へ寄せる。',
  ];
  return lines.filter((l) => l !== undefined).join('\n');
}
