/**
 * F-058 — promotion.post.publish の IG/TikTok(Ayrshare + メディア) 配線テスト。
 * buildMediaUrls で用意した mediaUrls が port.publish に渡ることを検証する。
 */
import { describe, expect, it, vi } from 'vitest';

import { runPromotionPostPublish } from '../src/tasks/promotion-post-publish.js';
import type { PublishInput, PublishResult, PublisherPort } from '../src/tasks/promotion-post/publisher-port.js';

function makePrisma(channel: string) {
  const update = vi.fn(async () => ({}));
  const prisma = {
    promotionPost: {
      findUnique: vi.fn(async () => ({
        id: 'p1',
        book_id: 'b1',
        channel,
        account_id: null,
        title: null,
        body: 'キャプション本文',
        status: 'scheduled',
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update,
    },
    promotionChannelSetting: {
      findUnique: vi.fn(async () => ({ auto_enabled: true, handle: '@me', token_enc: null, config_json: {} })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { prisma, update };
}

describe('runPromotionPostPublish — Instagram via Ayrshare', () => {
  it('buildMediaUrls の結果を port.publish に mediaUrls として渡し posted にする', async () => {
    const { prisma, update } = makePrisma('instagram');
    let received: PublishInput | null = null;
    const port: PublisherPort = {
      async publish(inp: PublishInput): Promise<PublishResult> {
        received = inp;
        return { ok: true, externalUrl: 'https://instagram.com/p/abc' };
      },
    };
    const res = await runPromotionPostPublish(
      { post_id: 'p1' },
      {
        prisma,
        resolvePort: () => port,
        buildMediaUrls: async (ch, bookId) => {
          expect(ch).toBe('instagram');
          expect(bookId).toBe('b1');
          return ['https://r2/signed/promo.png'];
        },
        decryptToken: () => 'x',
      },
    );
    expect(res).toMatchObject({ status: 'posted', externalUrl: 'https://instagram.com/p/abc' });
    expect(received!.mediaUrls).toEqual(['https://r2/signed/promo.png']);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1' }, data: expect.objectContaining({ status: 'posted' }) }),
    );
  });

  it('メディア生成に失敗しても投稿処理は継続する(mediaUrls無しで publish)', async () => {
    const { prisma } = makePrisma('instagram');
    let received: PublishInput | null = null;
    const port: PublisherPort = {
      async publish(inp: PublishInput): Promise<PublishResult> {
        received = inp;
        return { ok: false, reason: 'invalid', message: 'instagram requires media' };
      },
    };
    const res = await runPromotionPostPublish(
      { post_id: 'p1' },
      {
        prisma,
        resolvePort: () => port,
        buildMediaUrls: async () => {
          throw new Error('image gen failed');
        },
        decryptToken: () => 'x',
      },
    );
    expect(res.status).toBe('failed');
    expect(received!.mediaUrls).toBeUndefined();
  });
});
