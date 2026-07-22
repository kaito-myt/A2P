/**
 * F-063 — ensureTikTokVideoForPost（投稿時オンデマンド動画生成）の単体テスト。
 */
import { describe, expect, it, vi } from 'vitest';

import { ensureTikTokVideoForPost } from '../src/tasks/promotion-post/tiktok-video.js';

function buildDeps(overrides: { renderVideo?: () => Promise<Buffer> } = {}) {
  const update = vi.fn(async () => ({}));
  const prisma = {
    promotionChannelSetting: { findUnique: vi.fn(async () => ({ strategy_json: null })) },
    book: {
      findMany: vi.fn(async () => [{ title: '本A' }, { title: '本B' }]),
      findUnique: vi.fn(async () => ({ title: '新潟競馬 完全攻略', asin: 'B0X', theme: { hook: 'なぜ新潟だけ勝てないのか' } })),
    },
    promotionPost: { update },
  };
  const createScript = vi.fn(async () => ({
    scenes: [{ index: 0, telop: 'フック', narration: 'なぜ', seconds: 3 }],
    caption: 'キャプション',
    hashtags: ['#競馬'],
  }));
  const renderVideo = overrides.renderVideo ?? vi.fn(async () => Buffer.from('MP4DATA'));
  const uploadBuffer = vi.fn(async (key: string) => ({ key }));
  return { prisma, createScript, renderVideo, uploadBuffer, update };
}

describe('ensureTikTokVideoForPost', () => {
  it('動画をレンダリング→R2保存→media_key を投稿に付与しキーを返す', async () => {
    const { prisma, createScript, renderVideo, uploadBuffer, update } = buildDeps();
    const key = await ensureTikTokVideoForPost('post_1', 'book_1', {
      prisma: prisma as never,
      createScript: createScript as never,
      renderVideo: renderVideo as never,
      uploadBuffer,
    });
    expect(key).toBe('promotion/videos/post_1.mp4');
    expect(uploadBuffer).toHaveBeenCalledWith('promotion/videos/post_1.mp4', expect.any(Buffer), 'video/mp4');
    expect(update).toHaveBeenCalledWith({ where: { id: 'post_1' }, data: { media_key: 'promotion/videos/post_1.mp4' } });
    // promo は book 情報を台本に渡す
    const call0 = (createScript.mock.calls[0] as unknown as unknown[])[0] as { book?: { title: string } };
    expect(call0.book?.title).toBe('新潟競馬 完全攻略');
  });

  it('レンダリング失敗時は null（呼び出し側が画像フォールバック）', async () => {
    const { prisma, createScript, uploadBuffer, update } = buildDeps({
      renderVideo: vi.fn(async () => { throw new Error('ffmpeg failed'); }),
    });
    const key = await ensureTikTokVideoForPost('post_2', null, {
      prisma: prisma as never,
      createScript: createScript as never,
      renderVideo: (async () => { throw new Error('ffmpeg failed'); }) as never,
      uploadBuffer,
    });
    expect(key).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
