/**
 * F-060 — renderSlideVideo の単体テスト。
 * 画像生成/テロップ/TTS/ffmpeg を全て DI し、シーンごとにクリップを作って concat することを検証する。
 */
import { describe, expect, it, vi } from 'vitest';

import { renderSlideVideo } from '../src/tasks/promotion-post/video-render.js';
import type { VideoScene } from '@a2p/contracts/agents/tiktok-video';

function scenes(n: number): VideoScene[] {
  return Array.from({ length: n }, (_, i) => ({
    narration: `シーン${i}のナレーション`,
    caption: `テロップ${i}`,
    image_prompt: `背景${i}`,
    seconds: 3,
  }));
}

describe('renderSlideVideo', () => {
  it('各シーンで 画像→テロップ→TTS→ffmpeg を行い、最後に concat して mp4 を返す', async () => {
    const generateImage = vi.fn(async () => ({ images: [Buffer.from('img')], costJpy: 0, usage: { imageCount: 1 } }));
    const synthesizeSpeech = vi.fn(async (a: { input: string }) => ({ audio: Buffer.from('mp3'), charCount: a.input.length, model: 'gpt-4o-mini-tts' }));
    const composeTelop = vi.fn(async (img: Buffer) => img);
    const ffmpegCalls: string[][] = [];
    const runFfmpeg = vi.fn(async (args: string[]) => {
      ffmpegCalls.push(args);
      // concat の最後で final.mp4 を読むので、レンダラが readFile する前提。ここでは何もしない。
    });
    const logTtsCost = vi.fn(async () => {});

    // final.mp4 の読み取りをモックするため、fs を差し替えられない。代わりに runFfmpeg が
    // 実ファイルを作らないので readFile は失敗する。→ このテストでは concat 直前までを検証するには
    // renderSlideVideo が readFile するため、実 fs を使う簡易化: 各 ffmpeg 呼び出しで out にダミーを書く。
    // ここでは runFfmpeg 内で out パス(最後の引数)にダミー mp4 を書き込む。
    const { writeFile } = await import('node:fs/promises');
    const runFfmpegReal = vi.fn(async (args: string[]) => {
      ffmpegCalls.push(args);
      const out = args[args.length - 1]!;
      await writeFile(out, Buffer.from('MP4DATA'));
    });

    const result = await renderSlideVideo(scenes(2), {
      generateImage: generateImage as never,
      synthesizeSpeech: synthesizeSpeech as never,
      composeTelop,
      runFfmpeg: runFfmpegReal,
      logTtsCost,
      withImageLoggingDeps: { prisma: { tokenUsage: { create: vi.fn() }, book: { update: vi.fn() } } as never },
    });

    void runFfmpeg;
    expect(result.sceneCount).toBe(2);
    expect(result.video.toString()).toBe('MP4DATA');
    // 画像2枚 + TTS2回 + テロップ2回
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(synthesizeSpeech).toHaveBeenCalledTimes(2);
    expect(composeTelop).toHaveBeenCalledTimes(2);
    expect(logTtsCost).toHaveBeenCalledTimes(2);
    // ffmpeg: シーン2クリップ + concat1 = 3回
    expect(runFfmpegReal).toHaveBeenCalledTimes(3);
    // 最後の呼び出しは concat
    expect(ffmpegCalls[ffmpegCalls.length - 1]).toContain('concat');
  });

  it('シーンが空なら例外', async () => {
    await expect(renderSlideVideo([], {})).rejects.toThrow();
  });
});
