/**
 * F-062 — 週次コスト改善提案担当 (cost_optimizer)。
 *
 * コスト内訳・現行モデル割当・単価カタログ・運用設定を受け取り、コスト改善案とその影響、
 * および安全に自動実行できるアクションを構造化して返す。content_optimizer 同様
 * generateText + extractLlmJson で受ける（形状ドリフト耐性）。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import {
  CostOptimizerOutputSchema,
  type CostOptimizerInput,
  type CostOptimizerOutput,
} from '@a2p/contracts/agents/cost-optimizer';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import { extractLlmJson } from '../lib/sanitize-llm-json.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 6144;

export interface CostOptimizerDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
}

export async function analyzeCost(
  input: CostOptimizerInput,
  deps: CostOptimizerDeps = {},
): Promise<CostOptimizerOutput> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('cost_optimizer', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {});

  const ctx: LoggingContext = { role: 'cost_optimizer' };
  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('cost_optimizer', null, ctx, factoryDeps);

  const completion = await client.complete<string>({
    role: 'cost_optimizer',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildCostOptimizerUserMessage(input) },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const parsed = extractLlmJson<unknown>(completion.text);
  if (parsed === undefined) {
    throw new Error('cost_optimizer: 応答から JSON を抽出できませんでした');
  }
  return CostOptimizerOutputSchema.parse(parsed);
}

export function buildCostOptimizerUserMessage(input: CostOptimizerInput): string {
  const byRole = input.by_role_model.length
    ? input.by_role_model
        .slice()
        .sort((a, b) => b.cost_jpy - a.cost_jpy)
        .slice(0, 20)
        .map(
          (r) =>
            `- 役割=${r.role} ${r.provider}/${r.model}: ${Math.round(r.cost_jpy)}円 (呼出${r.calls}回, in${r.input_tokens}/out${r.output_tokens}tok, 画像${r.image_count})`,
        )
        .join('\n')
    : '(データ無し)';
  const assigns = input.current_assignments.length
    ? input.current_assignments.map((a) => `- ${a.role}${a.genre ? `/${a.genre}` : ''}: ${a.provider}/${a.model}`).join('\n')
    : '(なし)';
  const catalog = input.catalog.length
    ? input.catalog
        .map(
          (c) =>
            `- ${c.provider}/${c.model}: in$${c.input_price_per_mtok_usd ?? '?'} out$${c.output_price_per_mtok_usd ?? '?'}/Mtok${c.image_price_per_image_usd != null ? ` img$${c.image_price_per_image_usd}/枚` : ''}`,
        )
        .join('\n')
    : '(なし)';
  const settings = Object.keys(input.settings).length
    ? Object.entries(input.settings).map(([k, v]) => `- ${k} = ${String(v)}`).join('\n')
    : '(なし)';

  return [
    'あなたは KDP 出版事業の運用コストを最適化するアナリストです。',
    `対象期間: ${input.period_label}。総コスト: ${Math.round(input.total_cost_jpy)}円。`,
    '',
    '【役割×モデル別コスト（高い順）】',
    byRole,
    '',
    '【現行のモデル割当】',
    assigns,
    '',
    '【単価カタログ（現行）】',
    catalog,
    '',
    '【運用設定（現在値）】',
    settings,
    '',
    '指示:',
    '- コストの大きい箇所を特定し、品質を大きく落とさずに削減できる具体的な改善案を挙げる。',
    '- 各案に「推定月間削減額(円)」と「影響/リスク(品質・スピード・売上への影響)」を必ず添える。',
    '- 可能なら安全・可逆な実行アクションを付ける:',
    "  * モデル切替: action={kind:'switch_model_assignment', role, genre(任意), provider, model}。",
    '    切替先モデルは必ず単価カタログに存在するものにする。品質が重要な役割(writer 等)は慎重に。',
    "  * 設定変更: action={kind:'set_app_setting', key, value}。key は次のみ許可:",
    '    promo_dispatch_cron(投稿ディスパッチ頻度, cron文字列), promo_review_cron(日次見直し時刻, cron文字列),',
    '    promo_daily_review_enabled(日次見直しON/OFF, boolean)。',
    "  * それ以外の助言は action={kind:'advisory'} とする(自動実行しない)。",
    '- 実データに基づき、根拠のある案だけを最大8件まで。誇張しない。',
    '',
    '出力は JSON のみ。スキーマ: {"proposals":[{"category":"model|cadence|feature|other","title":string,"description":string,"estimated_saving_jpy":number,"impact_note":string,"action":{...}}]}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
