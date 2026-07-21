/**
 * F-060 — TikTok スライド動画の多エージェント台本パイプライン。
 *
 * 5 つの役割を順に回して VideoScript を作る:
 *   1. scenario   構成台本（強フック→小出し→引き=射幸心）
 *   2. creator    絵コンテ（各ビートに背景画像プロンプト＋テロップ）
 *   3. editor     尺配分・カット・テロップ整形 → VideoScript を確定
 *   4. proofreader 校閲（誤字/事実/過度な誇張の是正）
 *   5. marketer   フック/CTA/ハッシュタグの最終強化
 *
 * 各エージェントは generateText + extractLlmJson（responseSchema は使わない＝安定）。
 */
import type { LLMClient } from '@a2p/contracts/agents';
import {
  VideoScenarioSchema,
  StoryboardSchema,
  VideoScriptSchema,
  type TikTokVideoInput,
  type VideoScenario,
  type Storyboard,
  type VideoScript,
} from '@a2p/contracts/agents/tiktok-video';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import { extractLlmJson } from '../lib/sanitize-llm-json.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type { LoggingContext, WithTokenLoggingDeps } from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

const MAX_OUTPUT_TOKENS = 8192;

type Role =
  | 'tiktok_scenario'
  | 'tiktok_creator'
  | 'tiktok_editor'
  | 'tiktok_proofreader'
  | 'tiktok_marketer';

export interface TikTokVideoDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  promptLoaderDeps?: PromptLoaderDeps;
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  getApiKey?: (provider: string) => Promise<string>;
  orgTaskId?: string;
}

/** 1 エージェントを呼び、テキスト応答を返す（内部ヘルパ）。 */
async function runAgent(
  role: Role,
  placeholders: Record<string, string>,
  userMessage: string,
  deps: TikTokVideoDeps,
): Promise<string> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const prompt = await loadPrompt(role, null, deps.promptLoaderDeps);
  const systemPrompt = fillPlaceholders(prompt.template, placeholders);

  const ctx: LoggingContext = { role };
  if (deps.orgTaskId !== undefined) ctx.orgTaskId = deps.orgTaskId;

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient(role, null, ctx, factoryDeps);
  const completion = await client.complete<string>({
    role,
    genre: null,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  return completion.text;
}

function fmtInput(input: TikTokVideoInput): string {
  const titles = input.sample_titles.length
    ? input.sample_titles.slice(0, 10).map((t) => `- ${t}`).join('\n')
    : '(なし)';
  const bookLine = input.book
    ? `【宣伝する本】${input.book.title}${input.book.hook ? `（フック: ${input.book.hook}）` : ''}`
    : '【宣伝する本】なし（アカウント育成のための価値提供動画）';
  return [
    input.concept ? `【アカウントのコンセプト】\n${input.concept}` : '',
    input.tone_of_voice ? `【トーン&マナー】\n${input.tone_of_voice}` : '',
    `【今回のネタ（軸）】${input.topic}`,
    bookLine,
    `【目標尺】${input.target_seconds} 秒`,
    '【世界観の参考（売り込みには使わない）】',
    titles,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * TikTok スライド動画の台本（VideoScript）を多エージェントで生成する。
 */
export async function createTikTokVideoScript(
  input: TikTokVideoInput,
  deps: TikTokVideoDeps = {},
): Promise<VideoScript> {
  const ph = { target_seconds: String(input.target_seconds) };

  // 1. シナリオ（構成台本）
  const scenarioRaw = await runAgent(
    'tiktok_scenario',
    ph,
    `${fmtInput(input)}\n\n出力: VideoScenario の JSON（hook, beats[], cliffhanger）。` +
      `冒頭2秒で心を掴む強フックと、途中で答えを小出しにして「続きが気になる」引きを作ること。`,
    deps,
  );
  const scenario = VideoScenarioSchema.parse(extractLlmJsonOrThrow(scenarioRaw, 'tiktok_scenario'));

  // 2. 絵コンテ（背景画像プロンプト＋テロップ）
  const storyboardRaw = await runAgent(
    'tiktok_creator',
    ph,
    `${fmtInput(input)}\n\n【構成台本】\n${JSON.stringify(scenario)}\n\n` +
      `出力: Storyboard の JSON（scenes[]: narration, caption(画面テロップ・短く強く), image_prompt(縦型背景・文字なし)）。`,
    deps,
  );
  const storyboard = StoryboardSchema.parse(extractLlmJsonOrThrow(storyboardRaw, 'tiktok_creator'));

  // 3. 編集（尺配分・テロップ整形 → VideoScript 確定）
  const editedRaw = await runAgent(
    'tiktok_editor',
    ph,
    `${fmtInput(input)}\n\n【絵コンテ】\n${JSON.stringify(storyboard)}\n\n` +
      `出力: VideoScript の JSON（title, scenes[]: narration/caption/image_prompt/seconds, caption(TikTok本文), hashtags[]）。` +
      `合計尺が約 ${input.target_seconds} 秒になるよう各 seconds を配分。先頭シーンを最強フックに。`,
    deps,
  );
  let script = VideoScriptSchema.parse(extractLlmJsonOrThrow(editedRaw, 'tiktok_editor'));

  // 4. 校閲
  const proofedRaw = await runAgent(
    'tiktok_proofreader',
    ph,
    `次の VideoScript を校閲し、誤字脱字・事実誤り・過度な誇大表現・不自然な日本語を直して、` +
      `同じ JSON スキーマ（VideoScript）で返す。構成や射幸的な引きは壊さない。\n\n${JSON.stringify(script)}`,
    deps,
  );
  script = VideoScriptSchema.parse(extractLlmJsonOrThrow(proofedRaw, 'tiktok_proofreader'));

  // 5. マーケ最終強化（フック/CTA/ハッシュタグ）
  const coreTags = input.core_hashtags.length ? `定番ハッシュタグ: ${input.core_hashtags.join(' ')}` : '';
  const finalRaw = await runAgent(
    'tiktok_marketer',
    ph,
    `次の VideoScript のフック・クリフハンガー・TikTok本文(caption)・ハッシュタグを、視聴維持と` +
      `プロフィール誘導が最大化するよう最終強化して、同じ JSON スキーマ（VideoScript）で返す。${coreTags}\n\n` +
      `${JSON.stringify(script)}`,
    deps,
  );
  script = VideoScriptSchema.parse(extractLlmJsonOrThrow(finalRaw, 'tiktok_marketer'));

  return script;
}

function extractLlmJsonOrThrow(text: string, role: string): unknown {
  const parsed = extractLlmJson<unknown>(text);
  if (parsed === undefined) {
    throw new Error(`${role}: 応答から JSON を抽出できませんでした`);
  }
  return parsed;
}

// 中間出力の型を再エクスポート（テスト/呼び出し側の便宜）。
export type { VideoScenario, Storyboard, VideoScript };
