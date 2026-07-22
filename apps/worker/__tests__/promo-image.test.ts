/**
 * F-058 — ensureBookPromoImage の単体テスト (画像生成/アップロードを DI)。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ensureBookPromoImage,
  buildPromoImagePrompt,
  buildPromoBackgroundPrompt,
  buildValueImagePrompt,
  generateValuePostImage,
} from '../src/tasks/promotion-post/promo-image.js';

describe('buildPromoImagePrompt', () => {
  it('文字なしガードを含む', () => {
    expect(buildPromoImagePrompt('朝の習慣術', 'business')).toContain('文字');
  });
});

describe('buildPromoBackgroundPrompt', () => {
  it('文字なし・文字が入る物体禁止を含む', () => {
    const p = buildPromoBackgroundPrompt('gambling');
    expect(p).toContain('文字');
    expect(p).toContain('表紙');
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
  const wilDeps = { prisma: { tokenUsage: { create: vi.fn() }, book: { update: vi.fn() } } as never };

  it('既にキーがあれば再生成しない', async () => {
    const generateImage = vi.fn();
    const uploadBuffer = vi.fn();
    const prisma = {
      book: {
        findUnique: vi.fn(async () => ({ promo_image_key: 'books/b1/promo/social.jpg', title: 't', theme: { genre: 'business', hook: 'h', target_reader: null } })),
        update: vi.fn(),
      },
      cover: { findFirst: vi.fn(async () => null) },
      coverTextProposal: { findFirst: vi.fn(async () => null) },
    };
    const key = await ensureBookPromoImage('b1', { prisma, generateImage: generateImage as never, uploadBuffer });
    expect(key).toBe('books/b1/promo/social.jpg');
    expect(generateImage).not.toHaveBeenCalled();
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('採用表紙あり → 背景生成→表紙と合成→アップロード→キー保存', async () => {
    const generateImage = vi.fn(async () => ({ images: [Buffer.from('bg')], costJpy: 0, usage: { imageCount: 1 } }));
    const uploadBuffer = vi.fn(async (key: string) => ({ key }));
    const downloadBuffer = vi.fn(async () => Buffer.from('coverbytes'));
    const compose = vi.fn(async () => Buffer.from('COMPOSED'));
    const update = vi.fn(async () => ({}));
    const prisma = {
      book: {
        findUnique: vi.fn(async () => ({ promo_image_key: null, title: '新潟競馬 完全攻略', theme: { genre: 'gambling', hook: '夏競馬で勝ち切れない中級者へ', target_reader: '競馬中級者' } })),
        update,
      },
      cover: { findFirst: vi.fn(async () => ({ r2_key: 'books/b1/covers/raw/c1.jpg' })) },
      coverTextProposal: { findFirst: vi.fn(async () => null) },
    };
    const key = await ensureBookPromoImage('b1', {
      prisma,
      generateImage: generateImage as never,
      uploadBuffer,
      downloadBuffer,
      compose: compose as never,
      withImageLoggingDeps: wilDeps,
    });
    expect(key).toBe('books/b1/promo/social.jpg');
    expect(downloadBuffer).toHaveBeenCalledWith('books/b1/covers/raw/c1.jpg');
    expect(compose).toHaveBeenCalledTimes(1);
    // 合成結果がアップロードされる
    expect(uploadBuffer).toHaveBeenCalledWith('books/b1/promo/social.jpg', Buffer.from('COMPOSED'), 'image/jpeg');
    // 見出しは想定読者ベースの簡潔なベネフィット（長いフック全文は使わない）
    const content = (compose.mock.calls[0] as unknown[])[2] as { headline: string; badge: string };
    expect(content.headline).toBe('競馬中級者へ');
    expect(content.headline.length).toBeLessThanOrEqual(28);
    expect(content.badge).toBe('新刊');
  });

  it('採用表紙なし → 従来のムード画像にフォールバック（合成しない）', async () => {
    const generateImage = vi.fn(async () => ({ images: [Buffer.from('mood')], costJpy: 0, usage: { imageCount: 1 } }));
    const uploadBuffer = vi.fn(async (key: string) => ({ key }));
    const compose = vi.fn();
    const prisma = {
      book: {
        findUnique: vi.fn(async () => ({ promo_image_key: null, title: '朝の習慣術', theme: { genre: 'practical', hook: 'h', target_reader: null } })),
        update: vi.fn(async () => ({})),
      },
      cover: { findFirst: vi.fn(async () => null) },
      coverTextProposal: { findFirst: vi.fn(async () => null) },
    };
    const key = await ensureBookPromoImage('b1', {
      prisma,
      generateImage: generateImage as never,
      uploadBuffer,
      downloadBuffer: vi.fn(async () => null),
      compose: compose as never,
      withImageLoggingDeps: wilDeps,
    });
    expect(key).toBe('books/b1/promo/social.jpg');
    expect(compose).not.toHaveBeenCalled();
    expect(uploadBuffer).toHaveBeenCalledWith('books/b1/promo/social.jpg', Buffer.from('mood'), 'image/jpeg');
  });

  it('本が無ければ null', async () => {
    const prisma = { book: { findUnique: vi.fn(async () => null), update: vi.fn() }, cover: { findFirst: vi.fn() }, coverTextProposal: { findFirst: vi.fn() } };
    const key = await ensureBookPromoImage('missing', { prisma, generateImage: vi.fn() as never, uploadBuffer: vi.fn() });
    expect(key).toBeNull();
  });
});
