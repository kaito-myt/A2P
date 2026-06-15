/**
 * docs/05 §6.3.1 / F-002 — Marketer エージェント (長期出版プラン生成)。
 *
 * フロー (T-08-01):
 *  1. `loadActivePrompt('marketer_plan', null)` で active プロンプトを取得
 *  2. プレースホルダ ({months}/{target_count}/{published_books}/{sales_trend}) 差込
 *  3. `createAgentClient('marketer_plan', null, ctx)` で AISdkClient を取得
 *     (marketer_plan は web_search 不要のため AISdkClient が使われる)
 *     (`withTokenLogging` 自動ラップ済み)
 *  4. `client.complete({ system, messages })` を 1 回呼ぶ
 *     テキスト応答から JSON 部分を抽出 → zod 検証
 *  5. F-002 受入基準: 期間内総冊数が target_count ±20% に収まることを検証
 *     既存シリーズがあれば続編候補 1 件以上を検証
 *
 * エラー方針:
 *  - JSON 抽出/parse 失敗 → `AgentError('marketer.plan.invalid_output', { rawText, cause })`
 *  - zod 検証失敗            → `AgentError('marketer.plan.invalid_output', { issues, rawText })`
 *  - 総冊数 ±20% 外          → `AgentError('marketer.plan.count_out_of_range', { total, target })`
 *  - 続編候補なし (シリーズあり) → `AgentError('marketer.plan.no_sequel_candidate', {})`
 *  - LLM 呼出失敗 (ProviderError 等) はそのまま透過 (上位 worker の retry 対象)
 *
 * DI: `deps?.createAgentClient` / `deps?.loadActivePrompt` でテスト差し替え可能。
 *     `deps?.promptLoaderDeps.prisma` で prompts 取得時の Prisma 差し替え可。
 */
import { AgentError } from '@a2p/contracts/errors';
import type { LLMClient } from '@a2p/contracts/agents';
import {
  MarketerPlanInputSchema,
  MarketerPlanOutputSchema,
  type MarketerPlanInput,
  type MarketerPlanOutput,
} from '@a2p/contracts/agents/marketer';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type {
  LoggingContext,
  WithTokenLoggingDeps,
} from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

/** Marketer 長期プラン LLM 呼出の既定 max tokens。月次 JSON 配列を返す余裕。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface GeneratePlanDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  /** prompt-loader 内 Prisma 差し替え用 deps。 */
  promptLoaderDeps?: PromptLoaderDeps;
  /** factory 内 ModelAssignment / withTokenLogging 差し替え用 deps。 */
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  /** factory 内 getApiKey 差し替え (テストで env / DB を引かない)。 */
  getApiKey?: (provider: string) => Promise<string>;
}

/**
 * F-002 受入基準: アカウントの既出版実績 + 売上トレンドから月単位の長期出版プランを生成。
 *
 * @throws AgentError JSON 抽出/parse 失敗 / zod 検証失敗 / 総冊数範囲外 / 続編候補なし
 * @throws ProviderError LLM API 失敗 (透過、上位 worker でリトライ)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function generatePlan(
  input: MarketerPlanInput,
  deps: GeneratePlanDeps = {},
): Promise<MarketerPlanOutput> {
  // 1. 入力 zod 検証 (二重防衛)
  const parsedInput = MarketerPlanInputSchema.parse(input);

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  // 2. active プロンプト取得 + プレースホルダ差込
  //    marketer_plan は genre 横断 (plan はジャンル混在を想定) → genre=null 固定
  const prompt = await loadPrompt(
    'marketer_plan',
    null,
    deps.promptLoaderDeps,
  );
  const systemPrompt = fillPlaceholders(prompt.template, {
    months: parsedInput.months,
    target_count: parsedInput.target_count,
    published_books: formatPublishedBooks(parsedInput.published_books),
    sales_trend: formatSalesTrend(parsedInput.sales_trend),
  });

  // 3. AISdkClient (withTokenLogging ラップ済み) 取得
  //    jobId は SA 内同期呼び出しが主なため通常 undefined → token_usage.job_id = null
  const ctx: LoggingContext = {
    role: 'marketer_plan',
  };
  if (parsedInput.jobId !== undefined) {
    ctx.jobId = parsedInput.jobId;
  }

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient(
    'marketer_plan',
    null,
    ctx,
    factoryDeps,
  );

  // 4. LLM 呼出
  const completion = await client.complete({
    role: 'marketer_plan',
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(parsedInput) },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const rawText = completion.text;
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw new AgentError('marketer.plan.invalid_output: empty response', {
      details: { rawText: String(rawText) },
    });
  }

  // 5. JSON 抽出
  const parsedJson = extractJson(rawText);
  if (parsedJson === undefined) {
    throw new AgentError('marketer.plan.invalid_output: failed to parse JSON', {
      details: { rawText },
    });
  }

  // 6. zod 検証
  const validated = MarketerPlanOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new AgentError('marketer.plan.invalid_output: schema validation failed', {
      details: { rawText, issues: validated.error.issues },
      cause: validated.error,
    });
  }

  // 7. F-002 受入基準: 期間内総冊数が target_count ±20% に収まること
  const totalPlanned = validated.data.months.reduce(
    (sum, m) => sum + m.planned_count,
    0,
  );
  const allowedMin = Math.floor(parsedInput.target_count * 0.8);
  const allowedMax = Math.ceil(parsedInput.target_count * 1.2);
  if (totalPlanned < allowedMin || totalPlanned > allowedMax) {
    throw new AgentError('marketer.plan.count_out_of_range', {
      details: {
        total: totalPlanned,
        target: parsedInput.target_count,
        allowedMin,
        allowedMax,
      },
    });
  }

  // 8. F-002 受入基準: 既存シリーズ (published_books) があれば続編候補 1 件以上
  if (parsedInput.published_books.length > 0) {
    const hasSequel = validated.data.months.some(
      (m) => m.series_candidates.length > 0,
    );
    if (!hasSequel) {
      throw new AgentError('marketer.plan.no_sequel_candidate', {
        details: { published_books_count: parsedInput.published_books.length },
      });
    }
  }

  const result: MarketerPlanOutput = { months: validated.data.months };
  if (validated.data.notes !== undefined) result.notes = validated.data.notes;
  return result;
}

// ---------------------------------------------------------------------------
// ユーザーメッセージ構築
// ---------------------------------------------------------------------------

function buildUserMessage(input: MarketerPlanInput): string {
  const lines = [
    `計画期間: ${input.months} ヶ月`,
    `目標出版冊数 (期間合計): ${input.target_count} 冊`,
    '',
    '上記の既出版実績・売上トレンドを踏まえ、月単位の長期出版プランを生成してください。',
    '',
    '受入基準 (必ず遵守):',
    ` - 期間内の全月の planned_count 合計が ${input.target_count} の ±20% 以内に収まること`,
    ' - 既存シリーズが 1 冊以上ある場合は、少なくとも 1 ヶ月に 1 件以上の続編候補 (series_candidates) を含めること',
    '',
    '出力形式: JSON で以下を返してください。',
    '{',
    '  "months": [',
    '    {',
    '      "ym": "2026-07",           // "YYYY-MM" 形式',
    '      "planned_count": 3,         // その月の出版予定冊数',
    '      "theme_categories": ["副業", "ChatGPT 活用"],  // 重点テーマカテゴリ',
    '      "series_candidates": ["副業で月 5 万円 Vol.2"] // 続編候補 (なければ空配列)',
    '    }',
    '    // ... months 分繰り返す',
    '  ],',
    '  "notes": "任意: 戦略メモ"',
    '}',
    '',
    '**出力形式の制約**:',
    ' - 応答は単一の JSON オブジェクト (months キーを含む) のみとすること',
    ' - JSON 以外のテキストを応答に含めないこと',
    ' - ym は計画開始月から連続した月を昇順で並べること',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// プレースホルダ用テキスト整形
// ---------------------------------------------------------------------------

function formatPublishedBooks(
  books: MarketerPlanInput['published_books'],
): string {
  if (books.length === 0) return '(出版実績なし)';
  const lines = books.slice(0, 30).map((b) => {
    const stars = b.avg_stars !== null ? ` ★${b.avg_stars.toFixed(1)}` : '';
    return ` - ${b.title} [${b.genre}] 最新月売上: ${b.recent_royalty_jpy}円 レビュー: ${b.review_count}件${stars}`;
  });
  return lines.join('\n');
}

function formatSalesTrend(
  trend: MarketerPlanInput['sales_trend'],
): string {
  if (trend.length === 0) return '(売上データなし)';
  const lines = trend.slice(0, 12).map(
    (t) => ` - ${t.ym}: ${t.total_royalty_jpy.toLocaleString()}円`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON 抽出ユーティリティ (metadata.ts と同パターン)
// ---------------------------------------------------------------------------

function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch && fenceMatch[1]) {
    const inFence = tryParse(fenceMatch[1].trim());
    if (inFence !== undefined) return inFence;
  }

  const start = trimmed.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = trimmed.slice(start, i + 1);
        return tryParse(slice);
      }
    }
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
