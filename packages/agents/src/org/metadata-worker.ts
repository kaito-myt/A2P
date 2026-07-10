/**
 * docs/06 P2 — 入稿担当 (metadata_worker)。出版本部の担当者。
 * 品質判定を通った書籍について KDP メタデータ草案（説明文/キーワード7/カテゴリ/価格）を作る。
 *
 * P2 では成果を org_tasks.result_json に「草案」として格納する（既存 KdpMetadata は上書きしない）。
 * 公開(publish_kdp)は人手承認ゲートのまま。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import { MetadataDraftOutputSchema, type MetadataDraftOutput } from '@a2p/contracts/org';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 3072;

/** メタデータ草案に渡す書籍コンテキスト（worker が DB から集約）。 */
export interface MetadataContext {
  book: {
    title: string;
    subtitle?: string | null;
    genre?: string | null;
    /** 章タイトル等の要約（あれば）。 */
    outline_summary?: string | null;
  };
  /** 本部長の指示（instruction）— set_price なら価格方針など。 */
  instruction: string;
  /** 既存メタデータ（あれば参考に）。 */
  existing?: { description?: string | null; keywords?: string[] | null; price_jpy?: number | null } | null;
  /** set_price フォーカスなら true（価格の根拠を厚めに）。 */
  price_focus?: boolean;
}

export interface MetadataWorkerInput {
  context: MetadataContext;
}

export interface MetadataWorkerDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  orgTaskId?: string;
}

export async function draftMetadata(
  input: MetadataWorkerInput,
  deps: MetadataWorkerDeps = {},
): Promise<MetadataDraftOutput> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt('metadata_worker', null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, {
    genre: input.context.book.genre ?? '実用書',
  });

  const ctx: LoggingContext = { role: 'metadata_worker' };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('metadata_worker', null, ctx, factoryDeps);

  const completion = await client.complete<MetadataDraftOutput>({
    role: 'metadata_worker',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildMetadataWorkerUserMessage(input.context) },
    ],
    responseSchema: MetadataDraftOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return MetadataDraftOutputSchema.parse(completion.text);
}

export function buildMetadataWorkerUserMessage(c: MetadataContext): string {
  const existing = c.existing
    ? [
        '【既存メタデータ（参考）】',
        c.existing.description ? `- 説明文: ${c.existing.description.slice(0, 400)}` : '',
        c.existing.keywords?.length ? `- キーワード: ${c.existing.keywords.join(', ')}` : '',
        c.existing.price_jpy != null ? `- 価格: ¥${c.existing.price_jpy}` : '',
      ]
        .filter((l) => l !== '')
        .join('\n')
    : '';
  const lines = [
    'あなたは KDP 出版事業を運営する AI 企業の「入稿担当」です。',
    '以下の書籍について、Amazon KDP に入稿するためのメタデータ草案を作成してください。',
    '',
    '【書籍】',
    `- タイトル: ${c.book.title}`,
    c.book.subtitle ? `- サブタイトル: ${c.book.subtitle}` : '',
    c.book.genre ? `- ジャンル: ${c.book.genre}` : '',
    c.book.outline_summary ? `- 構成概要: ${c.book.outline_summary.slice(0, 600)}` : '',
    '',
    '【本部長からの指示】',
    c.instruction || '(特記なし。読者の検索意図に刺さる標準的な入稿メタデータを)',
    '',
    existing,
    existing ? '' : '',
    '出力要件:',
    '- description は購入意欲を高める日本語の紹介文（読者ベネフィット中心、誇大表現は避ける）。',
    '- keywords は KDP の 7 枠に合わせて最大 7 個、検索需要のある語を。',
    '- categories は最大 3 個。',
    c.price_focus
      ? '- price_jpy は競合と読者層を踏まえた税抜き想定価格（¥250〜¥1,250 の範囲が無難）。rationale に根拠を厚めに。'
      : '- price_jpy は妥当な想定価格。rationale に簡潔な根拠を。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
