/**
 * F-007b — Cover Text Verifier (サムネ文字崩れチェック)。
 *
 * 生成済みカバー画像をビジョンモデルに渡し、描画された日本語タイトルが
 *   - 判読可能か (title_legible)
 *   - 期待タイトルと一致するか (title_matches)
 *   - mojibake / 崩れた・存在しない文字が無いか (garbled_text_detected)
 *   - 偽の著者名・ロゴ等の余分テキストが無いか (extra_text_detected)
 * を検証し、総合判定 `ok` を返す。
 *
 * フロー (judge と同パターン):
 *  1. `loadActivePrompt('cover_text_check', genre)` で active プロンプト取得
 *  2. プレースホルダ ({title}/{subtitle}) を差込んで system プロンプト生成
 *  3. `createAgentClient('cover_text_check', genre, ctx)` で LLMClient (token 記録 wrap 済) 取得
 *  4. `client.complete({ messages: [system, user+image], responseSchema })` で構造化出力
 *
 * gpt-image-1 は画像生成専用なので、検証には別のビジョンモデル
 * (既定 ModelAssignment: anthropic / claude-sonnet-4-6) を使う。
 *
 * エラー方針:
 *  - LLM 呼出失敗 (ProviderError 等) はそのまま透過 (呼び出し側で best-effort 扱い)
 *  - active プロンプト不在 / API キー不在 → ConfigError
 *
 * DI: `deps.createAgentClient` / `deps.loadActivePrompt` でテスト差し替え可能。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import {
  CoverTextCheckInputSchema,
  CoverTextCheckOutputSchema,
  type CoverTextCheckInput,
  type CoverTextCheckOutput,
} from '@a2p/contracts/agents/thumbnail';

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

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export interface VerifyCoverTextDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
}

/**
 * カバー画像のタイトル文字を検証する。
 *
 * @throws ProviderError LLM API 失敗 (透過)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function verifyCoverText(
  input: CoverTextCheckInput,
  deps: VerifyCoverTextDeps = {},
): Promise<CoverTextCheckOutput> {
  const parsed = CoverTextCheckInputSchema.parse(input);

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const genre = parsed.genre ?? null;

  const prompt = await loadPrompt('cover_text_check', genre, deps.promptLoaderDeps);

  const systemPrompt = fillPlaceholders(prompt.template, {
    title: parsed.title,
    subtitle: parsed.subtitle ?? '',
  });

  const ctx: LoggingContext = {
    role: 'cover_text_check',
    bookId: parsed.bookId,
  };
  if (parsed.jobId !== undefined) {
    ctx.jobId = parsed.jobId;
  }

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient('cover_text_check', genre, ctx, factoryDeps);

  const userText = buildUserMessage(parsed);

  const completion = await client.complete<CoverTextCheckOutput>({
    role: 'cover_text_check',
    genre,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: userText,
        images: [{ data: parsed.imageBase64, mimeType: parsed.mimeType }],
      },
    ],
    responseSchema: CoverTextCheckOutputSchema,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  });

  // responseSchema 指定時、completion.text は検証済みオブジェクト。
  // 念のため parse して型を確定させる。
  return CoverTextCheckOutputSchema.parse(completion.text);
}

function buildUserMessage(input: CoverTextCheckInput): string {
  const lines = [
    'この画像は KDP 電子書籍のカバー (表紙) です。',
    '画像に描かれている文字を注意深く読み取り、タイトル文字が崩れていないか検証してください。',
    '',
    '【このカバーに描かれているべき文字】',
    `- タイトル: 「${input.title}」`,
  ];
  if (input.subtitle) {
    lines.push(`- 副題: 「${input.subtitle}」`);
  }
  lines.push(
    '',
    '検証観点:',
    ' - title_legible: タイトル文字がはっきり判読できるか',
    ' - title_matches: 読み取れたタイトルが上記の期待タイトルと一致するか',
    ' - garbled_text_detected: 崩れた/歪んだ/存在しない漢字・かな (mojibake)、不自然な合字や欠損があるか',
    ' - extra_text_detected: 期待していない余分な文字 (偽の著者名・英字ロゴ・ラベル・意味不明な文字列) が描かれているか',
    '',
    'transcribed_text には画像から実際に読み取れた全テキストを記入してください。',
    'issues には問題点を日本語で簡潔に列挙してください (無ければ空配列)。',
    'ok は「タイトルが判読でき、期待タイトルと一致し、崩れ文字も余分文字も無い」場合のみ true にしてください。',
  );
  return lines.join('\n');
}
