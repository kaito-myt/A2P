/**
 * docs/05 §6.3.1 / F-040 — Marketer エージェント (KDP メタデータ生成)。
 *
 * フロー (T-03-01 theme.ts と同パターン):
 *  1. `loadActivePrompt('marketer', genre)` で active プロンプトを取得
 *  2. プレースホルダ ({title}/{subtitle}/{hook}/{target_reader}/{competitors}/{genre}) 差込
 *  3. `createAgentClient('marketer', genre, ctx)` で AgentSdkClient を取得
 *     (`web_search_20250305` server tool 同梱、`withTokenLogging` 自動ラップ済み)
 *  4. `client.complete({ system, messages })` を 1 回呼ぶ — AgentSdkClient は
 *     `responseSchema` を受け付けないため、テキスト応答から JSON 部分を抽出 → zod 検証
 *  5. KDP 制約 (description ≤ 4000 / keywords ≤ 7 / categories = 2 / price >= 99)
 *     を `KdpMetadataSchema` で zod 強制 + NFKC 正規化済 keywords の重複除外
 *
 * エラー方針:
 *  - JSON 抽出/parse 失敗 → `AgentError('marketer.metadata.invalid_output', { rawText, cause })`
 *  - zod 検証失敗            → `AgentError('marketer.metadata.invalid_output', { issues, rawText })`
 *  - LLM 呼出失敗 (ProviderError 等) はそのまま透過 (上位 worker の retry 対象)
 *
 * DI: `deps?.createAgentClient` / `deps?.loadActivePrompt` でテスト差し替え可能。
 *     `deps?.promptLoaderDeps.prisma` で prompts 取得時の Prisma 差し替え可。
 *
 * T-03-01 教訓:
 *  - jobId は graphile-worker.jobs.id 専用 — UI 直接呼出時は undefined → null forward
 *    (theme_session_id 流用は FK 違反で silent fail するため厳禁)
 *  - schema は DB `kdp_metadata` 列 + docs/05 §6.3.1 と完全整合 (Hard Rule #3)
 *  - AgentSdkClient は responseSchema 非対応 — 自由テキスト → JSON 抽出 → zod の三段
 */
import { genreLabel } from '@a2p/contracts/agents';
import { AgentError } from '@a2p/contracts/errors';
import type { LLMClient } from '@a2p/contracts/agents';
import {
  MarketerMetadataInputSchema,
  MarketerMetadataOutputSchema,
  type MarketerMetadataInput,
  type MarketerMetadataOutput,
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

/** Marketer KDP メタデータ LLM 呼出の既定 max tokens。description 4000 字 + 周辺で 4096 で十分。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface GenerateMetadataDeps {
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
 * F-040 受入基準: 採用テーマ + 書籍文脈から KDP 入稿用 メタデータ
 * (description / categories / keywords / suggested_price_jpy) を生成。
 *
 * @throws AgentError JSON 抽出/parse 失敗 / zod 検証失敗 / KDP 制約違反
 * @throws ProviderError LLM API 失敗 (透過、上位 worker でリトライ)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function generateMarketerMetadata(
  input: MarketerMetadataInput,
  deps: GenerateMetadataDeps = {},
): Promise<MarketerMetadataOutput> {
  // 1. 入力 zod 検証 (二重防衛)
  const parsedInput = MarketerMetadataInputSchema.parse(input);

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  // 2. active プロンプト取得 + プレースホルダ差込
  const prompt = await loadPrompt(
    'marketer',
    parsedInput.genre,
    deps.promptLoaderDeps,
  );
  const systemPrompt = fillPlaceholders(prompt.template, {
    title: parsedInput.themeContext.title,
    subtitle: parsedInput.themeContext.subtitle ?? '',
    hook: parsedInput.themeContext.hook,
    target_reader: parsedInput.themeContext.target_reader,
    competitors: summarizeCompetitors(parsedInput.themeContext.competitors),
    genre: genreLabel(parsedInput.genre) ?? 'general',
  });

  // 3. AgentSdkClient (withTokenLogging ラップ済み) 取得
  //    jobId は input から forward — 未指定なら ctx に key を含めず token_usage.job_id=null
  const ctx: LoggingContext = {
    role: 'marketer',
  };
  if (parsedInput.themeSessionId !== undefined) {
    ctx.themeSessionId = parsedInput.themeSessionId;
  }
  if (parsedInput.bookId !== undefined) {
    ctx.bookId = parsedInput.bookId;
  }
  if (parsedInput.jobId !== undefined) {
    ctx.jobId = parsedInput.jobId;
  }

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient(
    'marketer',
    parsedInput.genre,
    ctx,
    factoryDeps,
  );

  // 4. LLM 呼出
  const completion = await client.complete({
    role: 'marketer',
    genre: parsedInput.genre,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: buildUserMessage(parsedInput),
      },
    ],
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const rawText = completion.text;
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw new AgentError('marketer.metadata.invalid_output: empty response', {
      details: { rawText: String(rawText) },
    });
  }

  // 5. JSON 抽出
  const parsedJson = extractJson(rawText);
  if (parsedJson === undefined) {
    throw new AgentError('marketer.metadata.invalid_output: failed to parse JSON', {
      details: { rawText },
    });
  }

  // 6. keywords NFKC 正規化 + 重複除外 (LLM が同義語を被せた場合の安全弁)
  //    重複除外を zod 検証の前に行うのは、max(7) に被り込みでひっかかるのを救うため。
  const preNormalized = normalizeKeywordsIfPresent(parsedJson);

  // 7. zod 検証 (KDP 制約はここで強制: description ≤ 4000 / categories.length=2 /
  //    keywords ≤ 7 / suggested_price_jpy ≥ 99)
  const validated = MarketerMetadataOutputSchema.safeParse(preNormalized);
  if (!validated.success) {
    throw new AgentError('marketer.metadata.invalid_output: schema validation failed', {
      details: { rawText, issues: validated.error.issues },
      cause: validated.error,
    });
  }

  const result: MarketerMetadataOutput = { metadata: validated.data.metadata };
  if (validated.data.notes !== undefined) result.notes = validated.data.notes;
  return result;
}

/**
 * LLM 応答 JSON 内の `metadata.keywords` を NFKC 正規化 + 大小無視で重複除外する。
 *
 * WHY: KDP は 7 個まで。LLM が「副業」「フクギョウ」「ふくぎょう」を別カウントで返してきても
 *      実質同一なので 1 件に縮約する。元配列の最初の出現を残す (順序保持)。
 *      入力が想定外の形状なら何もせずそのまま返す (zod 検証で reject される)。
 */
function normalizeKeywordsIfPresent(raw: unknown): unknown {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('metadata' in raw) ||
    typeof (raw as { metadata: unknown }).metadata !== 'object' ||
    (raw as { metadata: unknown }).metadata === null
  ) {
    return raw;
  }
  const meta = (raw as { metadata: Record<string, unknown> }).metadata;
  const keywords = meta.keywords;
  if (!Array.isArray(keywords)) return raw;

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const k of keywords) {
    if (typeof k !== 'string') continue;
    const norm = k.normalize('NFKC').trim().toLowerCase();
    if (norm.length === 0) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    deduped.push(k.normalize('NFKC').trim());
  }
  return {
    ...(raw as object),
    metadata: { ...meta, keywords: deduped },
  };
}

/** competitors 配列を Marketer 向けの簡易テキストに整形 (system プロンプト差込用)。 */
function summarizeCompetitors(competitors: unknown[]): string {
  if (!Array.isArray(competitors) || competitors.length === 0) return '(参考競合なし)';
  const lines: string[] = [];
  for (const c of competitors.slice(0, 10)) {
    if (typeof c !== 'object' || c === null) continue;
    const obj = c as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title : '(no title)';
    const asin = typeof obj.asin === 'string' ? ` [${obj.asin}]` : '';
    const url = typeof obj.url === 'string' ? ` ${obj.url}` : '';
    lines.push(` - ${title}${asin}${url}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(参考競合なし)';
}

function buildUserMessage(input: MarketerMetadataInput): string {
  const lines = [
    `書籍タイトル: ${input.themeContext.title}`,
  ];
  if (input.themeContext.subtitle) {
    lines.push(`副題: ${input.themeContext.subtitle}`);
  }
  lines.push(
    `差別化フック: ${input.themeContext.hook}`,
    `想定読者: ${input.themeContext.target_reader}`,
    `ジャンル: ${genreLabel(input.genre) ?? 'general'}`,
    '',
    '上記の書籍について Amazon KDP 入稿用メタデータを生成してください。',
    'KDP 制約 (必ず遵守):',
    ' - description: 日本語、50〜4000 文字 (プレーンテキスト、HTML タグ不要)',
    ' - categories: KDP 公式カテゴリツリーから 2 個 (例: "Kindle ストア > Kindleストア > Kindle本 > ビジネス・経済 > 起業")',
    ' - keywords: 1〜7 個 (各 50 字以内、検索意図の異なるものを選ぶ)',
    ' - suggested_price_jpy: 99〜99999 の整数 (Kindle 一般的レンジは 250〜980)',
    '',
    '出力形式: JSON で以下を返してください。',
    '{',
    '  "metadata": {',
    '    "description": string,',
    '    "categories": [string, string],',
    '    "keywords": string[],',
    '    "suggested_price_jpy": integer',
    '  },',
    '  "notes"?: string  // 任意: 差別化ポイントや価格根拠など',
    '}',
  );
  return lines.join('\n');
}

/**
 * LLM テキスト応答から JSON オブジェクトを抽出する。
 *
 * 受け付ける形式:
 *  1. 純粋な JSON テキスト全体
 *  2. ` ```json ... ``` ` フェンス
 *  3. テキスト中の最初の `{ ... }` 〜 対応する `}` (balanced) ブロック
 *
 * 失敗時は undefined を返す (呼出側で AgentError に変換)。
 *
 * NOTE: theme.ts に同等関数があるが、Marketer 系内で完結させるため意図的に重複させる
 *       (将来 lib/json-extract.ts に集約する余地は残す)。
 */
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
