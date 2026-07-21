/**
 * F-060 — OpenAI Text-to-Speech ラッパ。
 *
 * TikTok スライド動画のナレーション音声を合成する。`client.audio.speech.create` を
 * 遅延 import で呼び、mp3 の Buffer を返す。コスト記録は呼び出し側（レンダラ）が
 * token_usage に role='tts_audio' で行う（本関数は char 数だけ返す）。
 */
import { ConfigError, ProviderError } from '@a2p/contracts/errors';

const PROVIDER = 'openai';
const DEFAULT_MODEL = 'gpt-4o-mini-tts';
/** 落ち着いた日本語ナレーション向けの既定ボイス。 */
const DEFAULT_VOICE = 'alloy';

export interface SynthesizeSpeechArgs {
  /** 読み上げるテキスト（最大 4096 文字）。 */
  input: string;
  /** TTS モデル。既定 gpt-4o-mini-tts。 */
  model?: string;
  /** ボイス。既定 alloy。 */
  voice?: string;
  /** 話速 0.25–4.0。既定 1.0。 */
  speed?: number;
  /** 声の演出指示（gpt-4o-mini-tts のみ有効）。 */
  instructions?: string;
}

export interface SynthesizeSpeechResult {
  /** mp3 バイナリ。 */
  audio: Buffer;
  /** 課金の基準になる入力文字数。 */
  charCount: number;
  model: string;
}

/** OpenAI SDK の audio.speech 最小形（テストで差し替え可能に）。 */
export interface OpenAISpeechClient {
  audio: {
    speech: {
      create(body: {
        input: string;
        model: string;
        voice: string;
        response_format?: string;
        speed?: number;
        instructions?: string;
      }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
    };
  };
}

export interface SynthesizeSpeechDeps {
  getApiKey?: () => Promise<string>;
  openaiFactory?: (apiKey: string) => OpenAISpeechClient;
}

async function defaultGetApiKey(): Promise<string> {
  const mod = await import('../lib/get-api-key.js');
  return mod.getApiKey('openai');
}

async function defaultOpenaiFactory(apiKey: string): Promise<OpenAISpeechClient> {
  const mod = await import('openai');
  const OpenAI =
    (mod as { default?: new (opts: { apiKey: string }) => OpenAISpeechClient }).default ??
    (mod as unknown as new (opts: { apiKey: string }) => OpenAISpeechClient);
  return new OpenAI({ apiKey });
}

export async function synthesizeSpeech(
  args: SynthesizeSpeechArgs,
  deps: SynthesizeSpeechDeps = {},
): Promise<SynthesizeSpeechResult> {
  const input = (args.input ?? '').trim();
  if (input.length === 0) {
    throw new ConfigError('synthesizeSpeech: input is required');
  }
  if (input.length > 4096) {
    throw new ConfigError(`synthesizeSpeech: input too long (${input.length} > 4096)`);
  }
  const model = args.model ?? DEFAULT_MODEL;
  const voice = args.voice ?? DEFAULT_VOICE;

  const apiKey = await (deps.getApiKey ?? defaultGetApiKey)();
  const client = await (deps.openaiFactory
    ? Promise.resolve(deps.openaiFactory(apiKey))
    : defaultOpenaiFactory(apiKey));

  try {
    const res = await client.audio.speech.create({
      input,
      model,
      voice,
      response_format: 'mp3',
      ...(args.speed !== undefined ? { speed: args.speed } : {}),
      ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new ProviderError(`${PROVIDER} audio.speech returned empty audio`, { retryable: false });
    }
    return { audio: buf, charCount: input.length, model };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      `${PROVIDER} audio.speech failed: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: false, cause: err },
    );
  }
}
