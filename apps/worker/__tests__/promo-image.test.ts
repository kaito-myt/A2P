/**
 * F-058 — ensureBookPromoImage の単体テスト (画像生成/アップロードを DI)。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ensureBookPromoImage,
  buildPromoImagePrompt,
  buildValueImagePrompt,
  generateValuePostImage,
} from '../src/tasks/promotion-post/promo-image.js';

describe('buildPromoImagePrompt', () => {
  it('文字なしガードを含む', () => {
    expect(buildPromoImagePrompt('朝の習慣術', 'business')).toContain('文字');
  });
});

describe('buildValueImagePrompt', () => {
  it('文字なしガード + 本文の趣旨を含み、URL/ハッシュタグを除く', () => {
    const p = buildValueImagePrompt('メールは1日3回に #仕事術 https://x.co/a');
    expect(p).toContain('文字');
    expect(p).toContain('メールは1日3回に');
    expect(p).not.toContain('#仕事術');
    expect(p).not.toContain('https://');
  });
});

describe('generateValuePostImage', () => {
  it('投稿ごとにユニークキーへ JPEG を生成する', async () => {
    const generateImage = vi.fn(async () => ({ images: [Buffer.from('v')], costJpy: 0, usage: { imageCount: 1 } }));
    const uploadBuffer = vi.fn(async (key: string) => ({ key }));
    const key = await generateValuePostImage('post_9', '習慣は既存習慣の直後に置く', {
      generateImage: generateImage as never,
      uploadBuffer,
      withImageLoggingDeps: { prisma: { tokenUsage: { create: vi.fn() }, book: { update: vi.fn() } } as never },
    });
    expect(key).toBe('promotion/posts/post_9.jpg');
    expect(uploadBuffer).toHaveBeenCalledWith('promotion/posts/post_9.jpg', expect.any(Buffer), 'image/jpeg');
  });
});

describe('ensureBookPromoImage', () => {
  it('既にキーがあれば再生成しない', async () => {
    const generateImage = vi.fn();
    const uploadBuffer = vi.fn();
    const prisma = {
      book: {
        findUnique: vi.fn(async () => ({ promo_image_key: 'books/b1/promo/social.jpg', title: 't', theme: { genre: 'business' } })),
        update: vi.fn(),
      },
    };
    const key = await ensureBookPromoImage('b1', { prisma, generateImage: generateImage as never, uploadBuffer });
    expect(key).toBe('books/b1/promo/social.jpg');
    expect(generateImage).not.toHaveBeenCalled();
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('未生成なら生成→アップロード→キー保存', async () => {
    const generateImage = vi.fn(async () => ({ images: [Buffer.from('img')], costJpy: 0, usage: { imageCount: 1 } }));
    const uploadBuffer = vi.fn(async (key: string) => ({ key }));
    const update = vi.fn(async () => ({}));
    const prisma = {
      book: {
        findUnique: vi.fn(async () => ({ promo_image_key: null, title: '朝の習慣術', theme: { genre: 'practical' } })),
        update,
      },
    };
    const key = await ensureBookPromoImage('b1', {
      prisma,
      generateImage: generateImage as never,
      uploadBuffer,
      withImageLoggingDeps: { prisma: { tokenUsage: { create: vi.fn() }, book: { update: vi.fn() } } as never },
    });
    expect(key).toBe('books/b1/promo/social.jpg');
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(uploadBuffer).toHaveBeenCalledWith('books/b1/promo/social.jpg', expect.any(Buffer), 'image/jpeg');
    expect(update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { promo_image_key: 'books/b1/promo/social.jpg' } });
  });

  it('本が無ければ null', async () => {
    const prisma = { book: { findUnique: vi.fn(async () => null), update: vi.fn() } };
    const key = await ensureBookPromoImage('missing', { prisma, generateImage: vi.fn() as never, uploadBuffer: vi.fn() });
    expect(key).toBeNull();
  });
});
