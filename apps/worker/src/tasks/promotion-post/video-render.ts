/**
 * F-060 — TikTok スライド動画レンダラ。
 *
 * VideoScript の各シーンについて:
 *   1. gpt-image-1 で縦型(1024x1536)背景画像を生成（文字なし）
 *   2. Noto Sans JP でテロップ(caption)を焼き込み（composeCoverTypography 流用）
 *   3. OpenAI TTS でナレーション音声(mp3)を合成
 *   4. ffmpeg で「画像＋音声」を 1080x1920 の 1 クリップに（音声尺で自動）
 * 全クリップを concat して 9:16 mp4 を返す。
 *
 * child_process(ffmpeg) と一時ファイルを使う。ffmpeg 実行は DI 可能（テスト差し替え）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateImage as defaultGenerateImage,
  withImageLogging,
  synthesizeSpeech as defaultSynthesizeSpeech,
  type GenerateImageFn,
  type WithImageLoggingDeps,
} from '@a2p/agents';
import { composeCoverTypography } from '@a2p/output-image';
import type { VideoScene } from '@a2p/contracts/agents/tiktok-video';
import { createLogger, type Logger } from '@a2p/contracts/logger';

const execFileAsync = promisify(execFile);

const VIDEO_W = 1080;
const VIDEO_H = 1920;

export type RunFfmpegFn = (args: string[]) => Promise<void>;

export interface RenderVideoDeps {
  logger?: Logger;
  generateImage?: GenerateImageFn;
  withImageLoggingDeps?: WithImageLoggingDeps;
  synthesizeSpeech?: typeof defaultSynthesizeSpeech;
  /** テロップ焼き込み（既定は composeCoverTypography）。 */
  composeTelop?: (image: Buffer, caption: string) => Promise<Buffer>;
  /** ffmpeg 実行（既定は execFile('ffmpeg', args)）。 */
  runFfmpeg?: RunFfmpegFn;
  /** TTS コスト記録（既定は token_usage へ INSERT）。 */
  logTtsCost?: (charCount: number, model: string) => Promise<void>;
}

async function defaultRunFfmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function defaultComposeTelop(image: Buffer, caption: string): Promise<Buffer> {
  return composeCoverTypography(image, { title: caption }, { placement: 'bottom' });
}

async function defaultLogTtsCost(charCount: number, model: string): Promise<void> {
  try {
    const { prisma } = await import('@a2p/db');
    // gpt-4o-mini-tts の概算: $0.60 / 1M chars, fx 155 → 1文字≈0.0000930円。ModelCatalog 未整備のため簡易。
    const costJpy = Math.round(charCount * 0.6e-6 * 155 * 100) / 100;
    await prisma.tokenUsage.create({
      data: {
        book_id: null,
        theme_session_id: null,
        job_id: null,
        provider: 'openai',
        model,
        role: 'tts_audio',
        input_tokens: charCount,
        output_tokens: 0,
        cached_input_tokens: 0,
        image_count: 0,
        unit_price_snapshot: { tts_usd_per_mchar: 0.6, fx_rate_usd_jpy: 155 },
        cost_jpy: costJpy,
      },
    });
  } catch {
    /* コスト記録失敗はレンダリングを止めない */
  }
}

/** 1080x1920 にカバー配置し、setsar=1・yuv420p で統一エンコード。 */
function sceneClipArgs(imagePath: string, audioPath: string, outPath: string): string[] {
  return [
    '-loop', '1', '-i', imagePath,
    '-i', audioPath,
    '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '30',
    '-vf', `scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H},setsar=1`,
    // ナレーションを 1.12倍でブリスクに（テンポUP・視聴維持）。atempo はピッチ保持。
    '-filter:a', 'atempo=1.12',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-shortest', outPath,
  ];
}

export interface RenderVideoResult {
  video: Buffer;
  sceneCount: number;
}

/**
 * VideoScript のシーン列から 9:16 mp4 を生成して Buffer で返す。
 */
export async function renderSlideVideo(
  scenes: VideoScene[],
  deps: RenderVideoDeps = {},
): Promise<RenderVideoResult> {
  const log = deps.logger ?? createLogger('worker.promotion.video-render');
  const baseGen: GenerateImageFn = deps.generateImage ?? defaultGenerateImage;
  const genImage = withImageLogging(baseGen, { role: 'promo_image' }, deps.withImageLoggingDeps);
  const tts = deps.synthesizeSpeech ?? defaultSynthesizeSpeech;
  const composeTelop = deps.composeTelop ?? defaultComposeTelop;
  const runFfmpeg = deps.runFfmpeg ?? defaultRunFfmpeg;
  const logTts = deps.logTtsCost ?? defaultLogTtsCost;

  if (scenes.length === 0) {
    throw new Error('renderSlideVideo: scenes is empty');
  }

  const dir = await mkdtemp(join(tmpdir(), 'a2p-video-'));
  try {
    const clipPaths: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]!;
      // 1. 背景画像（縦型・文字なし）
      const img = await genImage({
        prompt: `${scene.image_prompt} 縦型構図。重要: 画像内に文字・ロゴ・数字を一切描かない。`,
        width: 1024,
        height: 1536,
        quality: 'medium',
        outputFormat: 'jpeg',
        outputCompression: 90,
      });
      const rawImage = img.images[0];
      if (!rawImage) throw new Error(`renderSlideVideo: scene ${i} image empty`);

      // 2. テロップ焼き込み
      const withTelop = await composeTelop(rawImage, scene.caption);
      const imagePath = join(dir, `scene-${i}.jpg`);
      await writeFile(imagePath, withTelop);

      // 3. ナレーション音声
      const speech = await tts({ input: scene.narration });
      const audioPath = join(dir, `scene-${i}.mp3`);
      await writeFile(audioPath, speech.audio);
      await logTts(speech.charCount, speech.model);

      // 4. シーンクリップ
      const clipPath = join(dir, `clip-${i}.mp4`);
      await runFfmpeg(sceneClipArgs(imagePath, audioPath, clipPath));
      clipPaths.push(clipPath);
    }

    // 5. concat（同一エンコードなので -c copy）
    const listPath = join(dir, 'concat.txt');
    await writeFile(listPath, clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const outPath = join(dir, 'final.mp4');
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);

    const video = await readFile(outPath);
    log.info({ sceneCount: scenes.length, bytes: video.byteLength }, 'slide video rendered');
    return { video, sceneCount: scenes.length };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
