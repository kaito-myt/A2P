/**
 * F-053 — モデル・バエオフ。
 *
 * 「同じ役割の active プロンプト × 同じ入力」を複数モデルで走らせ、出力・コスト・
 * レイテンシを集め、comparator (judge の割当モデル) が品質をランク付けする。
 *
 * createAgentClient の `assignmentOverride` で役割の割当を無視し任意モデルを使う。
 */
import type { AgentRole, Genre, LLMClient } from '@a2p/contracts/agents';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
} from '../lib/prompt-loader.js';
import type { LoggingContext } from '../lib/with-token-logging.js';

export interface BakeoffCandidate {
  provider: string;
  model: string;
}

export interface BakeoffInput {
  /** 役割に与えるユーザーメッセージ (サンプル入力)。 */
  user: string;
  /** system プロンプトに追記する任意の指示。 */
  system_extra?: string;
}

export interface BakeoffCandidateResult {
  provider: string;
  model: string;
  output?: string;
  costJpy?: number;
  latencyMs?: number;
  error?: string;
}

export interface RunBakeoffDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  now?: () => number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 3000;

/** 1 候補モデルで役割プロンプトを実行し、出力・コスト・レイテンシを返す (throw しない)。 */
export async function runBakeoffCandidate(
  args: { runId: string; role: AgentRole; genre: Genre | null; candidate: BakeoffCandidate; input: BakeoffInput },
  deps: RunBakeoffDeps = {},
): Promise<BakeoffCandidateResult> {
  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;
  const now = deps.now ?? (() => Date.now());
  const { provider, model } = args.candidate;

  try {
    const prompt = await loadPrompt(args.role, args.genre);
    // 役割共通の {{genre}} だけ埋める (他プレースホルダは全候補共通で残す=公平比較)。
    const system = fillPlaceholders(prompt.template, { genre: args.genre ?? 'general' });
    const systemContent = args.input.system_extra
      ? `${system}\n\n${args.input.system_extra}`
      : system;

    const ctx: LoggingContext = { role: args.role };
    const client: LLMClient = await makeClient(args.role, args.genre, ctx, {
      assignmentOverride: { provider, model },
    });

    const started = now();
    const completion = await client.complete({
      role: args.role,
      genre: args.genre,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: args.input.user },
      ],
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
    const latencyMs = now() - started;

    const output = typeof completion.text === 'string' ? completion.text : JSON.stringify(completion.text);
    return { provider, model, output, costJpy: completion.costJpy, latencyMs };
  } catch (err) {
    return { provider, model, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

export interface BakeoffRanking {
  index: number; // candidate index
  rank: number; // 1 = best
  score: number; // 0-100
  rationale: string;
}

/**
 * comparator: 候補出力を匿名(#0,#1,...)で提示し、judge の割当モデルにランク付けさせる。
 * 出力できた候補のみ対象。失敗候補は呼び出し側で末尾に置く。
 */
export async function rankBakeoffOutputs(
  args: { role: AgentRole; genre: Genre | null; input: BakeoffInput; outputs: Array<{ index: number; output: string }> },
  deps: RunBakeoffDeps = {},
): Promise<BakeoffRanking[]> {
  if (args.outputs.length === 0) return [];
  if (args.outputs.length === 1) {
    return [{ index: args.outputs[0]!.index, rank: 1, score: 100, rationale: '単一候補' }];
  }
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  const ctx: LoggingContext = { role: 'judge' };
  const client: LLMClient = await makeClient('judge', null, ctx, {});

  const sys = [
    'あなたは AI モデルの出力品質を評価する審査員です。',
    `役割「${args.role}」のタスクに対する複数モデルの出力を比較し、品質でランク付けします。`,
    '判断基準: 指示への忠実さ、内容の的確さ・具体性、日本語の自然さ、実用性。モデル名は伏せてあります。',
  ].join('\n');
  const cand = args.outputs
    .map((o) => `### 候補 #${o.index}\n${o.output.slice(0, 4000)}`)
    .join('\n\n');
  const user = [
    `# タスク入力\n${args.input.user.slice(0, 2000)}`,
    '',
    `# 各候補の出力\n${cand}`,
    '',
    '# 出力形式',
    '各候補について rank(1=最良), score(0-100), rationale(日本語1文) を付け、**JSON配列のみ**を返す:',
    '[{"index": <候補番号>, "rank": <順位>, "score": <0-100>, "rationale": "<講評>"}, ...]',
  ].join('\n');

  const completion = await client.complete({
    role: 'judge',
    genre: null,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    maxOutputTokens: 1500,
  });
  const raw = typeof completion.text === 'string' ? completion.text : JSON.stringify(completion.text);
  const parsed = extractJsonArray(raw);
  const valid = new Set(args.outputs.map((o) => o.index));
  const out: BakeoffRanking[] = [];
  for (const item of parsed) {
    if (
      item &&
      typeof item.index === 'number' &&
      valid.has(item.index) &&
      typeof item.rank === 'number'
    ) {
      out.push({
        index: item.index,
        rank: item.rank,
        score: typeof item.score === 'number' ? item.score : 0,
        rationale: typeof item.rationale === 'string' ? item.rationale : '',
      });
    }
  }
  return out;
}

interface RankingLike {
  index?: unknown;
  rank?: unknown;
  score?: unknown;
  rationale?: unknown;
}

function extractJsonArray(text: string): RankingLike[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      if (Array.isArray(j)) return j as RankingLike[];
    } catch {
      /* next */
    }
  }
  return [];
}
