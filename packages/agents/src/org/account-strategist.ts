/**
 * docs/06 P4 — アカウント戦略担当 (account_strategist)。販促本部の担当者。
 * ジャンル/ターゲットの在庫と既存の接続済みアカウントを踏まえ、多アカウント運用の戦略
 * （どのニッチ専用アカウントを増やすか＋既存の活用方針）を立案する。
 *
 * 重要: 新規アカウント作成そのものは規約/KYC のため org は行わない（create_account=needs_human）。
 * 本エージェントは「作成仕様（handle案/bio/投稿方針）」まで埋めて人手作成を最小工数にする。
 *
 * sales_analyst と同パターン: loadActivePrompt → createAgentClient → responseSchema。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import { AccountStrategyOutputSchema, type AccountStrategyOutput } from '@a2p/contracts/org';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 3072;

/** アカウント戦略に渡すスナップショット（worker が DB から集約）。 */
export interface AccountSnapshot {
  period_label: string;
  /** 既に接続済み（運用中）のアカウント。 */
  connected: Array<{ channel: string; handle: string | null; niche: string | null }>;
  /** 作成待ち（pending）で台帳にあるアカウント。 */
  pending: Array<{ channel: string; niche: string }>;
  /** 在庫本のジャンル×点数（どの切り口に読者がいるか）。 */
  genre_inventory: Record<string, number>;
  /** 想定ターゲット読者のサンプル。 */
  target_samples: string[];
  /** 本部長からの実行指示（instruction）。 */
  instruction?: string;
}

export interface AccountStrategistInput {
  snapshot: AccountSnapshot;
}

export interface AccountStrategistDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  orgTaskId?: string;
}

export async function planAccountStrategy(
  input: AccountStrategistInput,
  deps: AccountStrategistDeps = {},
): Promise<AccountStrategyOutput> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('account_strategist', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    period_label: input.snapshot.period_label,
  });

  const ctx: LoggingContext = { role: 'account_strategist' };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('account_strategist', null, ctx, factoryDeps);

  const completion = await client.complete<AccountStrategyOutput>({
    role: 'account_strategist',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildAccountStrategistUserMessage(input.snapshot) },
    ],
    responseSchema: AccountStrategyOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return AccountStrategyOutputSchema.parse(completion.text);
}

export function buildAccountStrategistUserMessage(s: AccountSnapshot): string {
  const connected = s.connected.length
    ? s.connected.map((c) => `- ${c.channel}: ${c.handle ?? '(ハンドル未設定)'}${c.niche ? ` / ${c.niche}` : ''}`).join('\n')
    : '(接続済みアカウントなし)';
  const pending = s.pending.length
    ? s.pending.map((p) => `- ${p.channel}: ${p.niche}（作成待ち）`).join('\n')
    : '(作成待ちなし)';
  const inventory = Object.entries(s.genre_inventory).length
    ? Object.entries(s.genre_inventory).map(([g, n]) => `- ${g}: ${n}冊`).join('\n')
    : '(在庫データなし)';
  const targets = s.target_samples.length ? s.target_samples.slice(0, 10).map((t) => `- ${t}`).join('\n') : '(なし)';

  const lines = [
    'あなたは KDP 出版事業を運営する AI 企業の「アカウント戦略担当」です。',
    '在庫本のジャンル/ターゲットと既存の接続済みアカウントを踏まえ、SNS等の多アカウント運用戦略を立てます。',
    '',
    `【対象期間】${s.period_label}`,
    '',
    '【接続済みアカウント（運用中）】',
    connected,
    '',
    '【作成待ちアカウント（台帳）】',
    pending,
    '',
    '【在庫本ジャンル内訳】',
    inventory,
    '',
    '【ターゲット読者サンプル】',
    targets,
    '',
    s.instruction ? `【本部長からの指示】\n${s.instruction}\n` : '',
    '出力要件:',
    '- recommended_accounts: 読者が居るのに専用アカウントが無いニッチについて、増設すべきアカウントを提案。',
    '  各案は channel／niche／target_reader／handle_suggestion（英数字・@なし）／bio（そのまま貼れる自己紹介）／',
    '  posting_policy（投稿頻度・内容方針）／rationale を必ず埋める。**作成そのものは人手が行う前提**なので、',
    '  運営者が数分でサインアップ&接続できるだけの具体的な作成仕様にする。',
    '- 既に接続済み/作成待ちと重複するニッチは提案しない（過剰なアカウント乱立は避ける）。',
    '- routing: 既存の接続済みアカウントを、どの本/ジャンルの告知に使うかの方針。',
    '- suggestions は division＋action＋根拠。制作/出版との連動も。誇張せず現実的に。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
