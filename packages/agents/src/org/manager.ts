/**
 * docs/06 — 本部長 (マネージャー) エージェント。CEO の方針＋本部ブリーフを受け、
 * 自本部のタスク (org_tasks) に分解して起票案を返す。
 *
 * 6 本部（制作/出版/分析/販促/運用/経営管理）で同一関数を役割違いで使い回す。
 * role は DIVISION_MANAGER_ROLE[division] で解決する。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import type { AgentRole } from '@a2p/contracts/agents';
import {
  DIVISION_KINDS,
  DIVISION_LABELS,
  DIVISION_MANAGER_ROLE,
  ManagerPlanOutputSchema,
  type Division,
  type ManagerPlanOutput,
} from '@a2p/contracts/org';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** 本部長に提示する意思決定コンテキスト（worker が DB から組み立てる）。 */
export interface DivisionContext {
  /** CEO の方針サマリ。 */
  objective: {
    title: string;
    goals: string[];
    kpi: string[];
    notes?: string;
  };
  /** この本部への CEO ブリーフ。 */
  brief: string;
  /** 対象候補の書籍（id を提示し、タスクの book_id に選ばせる）。 */
  books: Array<{
    id: string;
    title: string;
    status: string;
    publish_status: string;
    genre?: string | null;
  }>;
  /** 販促本部向け: 接続済みチャンネル。 */
  channels?: Array<{ channel: string; auto_enabled: boolean; handle?: string | null }>;
  /** 既存の未完了タスク（重複起票を避けるため提示）。 */
  open_tasks?: Array<{ kind: string; title: string; status: string }>;
  /** この本部の予算配分(JPY)。 */
  budget_jpy?: number | null;
}

export interface ManagerPlanInput {
  division: Division;
  context: DivisionContext;
}

export interface ManagerPlanDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  orgTaskId?: string;
}

export async function planDivisionTasks(
  input: ManagerPlanInput,
  deps: ManagerPlanDeps = {},
): Promise<ManagerPlanOutput> {
  const { division, context } = input;
  const role = DIVISION_MANAGER_ROLE[division] as AgentRole;

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt(role, null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    division: DIVISION_LABELS[division],
    allowed_kinds: DIVISION_KINDS[division].join(', '),
  });

  const ctx: LoggingContext = { role };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient(role, null, ctx, factoryDeps);

  const completion = await client.complete<ManagerPlanOutput>({
    role,
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildManagerUserMessage(division, context) },
    ],
    responseSchema: ManagerPlanOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const parsed = ManagerPlanOutputSchema.parse(completion.text);
  // 本部外の kind を除外（安全側 — LLM が越境した場合は捨てる）。
  const allowed = new Set<string>(DIVISION_KINDS[division]);
  return { tasks: parsed.tasks.filter((t) => allowed.has(t.kind)) };
}

export function buildManagerUserMessage(division: Division, c: DivisionContext): string {
  const books = c.books.length
    ? c.books
        .map(
          (b) =>
            `- [${b.id}]「${b.title}」status=${b.status} publish=${b.publish_status}${b.genre ? ` genre=${b.genre}` : ''}`,
        )
        .join('\n')
    : '(候補書籍なし)';
  const channels = c.channels?.length
    ? c.channels.map((ch) => `- ${ch.channel}: 自動投稿${ch.auto_enabled ? 'ON' : 'OFF'} ${ch.handle ?? ''}`).join('\n')
    : '(接続済みチャンネルなし)';
  const openTasks = c.open_tasks?.length
    ? c.open_tasks.map((t) => `- [${t.status}] ${t.kind}: ${t.title}`).join('\n')
    : '(なし)';

  const lines = [
    `あなたは KDP 出版事業を運営する AI 企業の「${DIVISION_LABELS[division]}本部長」です。`,
    '社長(CEO)の方針とブリーフを受け、自本部が今サイクルで着手すべきタスクを',
    'ToDo（org_tasks）へ分解して起票してください。',
    '',
    '【CEO 方針】',
    `- タイトル: ${c.objective.title}`,
    `- ゴール: ${c.objective.goals.join(' / ') || '(なし)'}`,
    `- KPI: ${c.objective.kpi.join(' / ') || '(なし)'}`,
    c.objective.notes ? `- 補足: ${c.objective.notes}` : '',
    '',
    '【あなたの本部へのブリーフ】',
    c.brief || '(特記なし。方針に沿って必要最小限のタスクを起票)',
    '',
    c.budget_jpy != null ? `【本部予算(当サイクル)】¥${c.budget_jpy.toLocaleString('ja-JP')}` : '【本部予算】(未指定)',
    '',
    '【対象候補の書籍】',
    books,
    '',
    ...(division === 'promotion' ? ['【接続済みチャンネル】', channels, ''] : []),
    '【既存の未完了タスク（重複を避ける）】',
    openTasks,
    '',
    '出力要件:',
    `- kind は次のいずれかのみ: ${DIVISION_KINDS[division].join(', ')}`,
    '- 書籍対象タスクは book_id に上記候補の ID を入れる（横断タスクは省略）。',
    '- instruction は担当エージェントがそのまま実行できる具体的な指示にする。',
    '- 既存タスクと重複するものは起票しない。今サイクルで本当に必要なものだけ（最大 8 件目安）。',
    '- 販促の新規アカウント作成は create_account/connect_account（人手前提）で起票してよい。',
  ];
  return lines.filter((l) => l !== '' && l !== undefined).join('\n');
}
