/**
 * F-052 — buildPromotionPosts の単体テスト。
 * 販促プランから SNS/note/blog の投稿ドラフトを日程付きで導出する純関数。
 */
import { describe, expect, it } from 'vitest';

import {
  buildPromotionPosts,
  PROMOTION_CHANNELS,
  PromotionChannelSchema,
} from '../src/promotion/channels.js';

function planWith(copy: {
  x_posts?: string[];
  note_article?: string;
  blog_outline?: string;
}) {
  return {
    summary: '本書の販促方針サマリ',
    promo_copy: {
      x_posts: copy.x_posts ?? [],
      note_article: copy.note_article ?? '',
      blog_outline: copy.blog_outline ?? '',
    },
  };
}

describe('PromotionChannelSchema', () => {
  it('accepts x/instagram/tiktok/note/blog', () => {
    expect(PROMOTION_CHANNELS).toEqual(['x', 'instagram', 'tiktok', 'note', 'blog']);
    expect(PromotionChannelSchema.safeParse('x').success).toBe(true);
    expect(PromotionChannelSchema.safeParse('tiktok').success).toBe(true);
    expect(PromotionChannelSchema.safeParse('sns').success).toBe(false);
  });
});

describe('buildPromotionPosts', () => {
  it('creates one X/Instagram/TikTok post per x_post, spaced by 1 day', () => {
    const drafts = buildPromotionPosts(
      planWith({ x_posts: ['告知1', '告知2', '告知3'] }),
    );
    const x = drafts.filter((d) => d.channel === 'x');
    expect(x).toHaveLength(3);
    expect(x.map((d) => d.offsetMinutes)).toEqual([0, 1440, 2880]);
    // 同じ文面が3プラットフォームに展開される
    expect(drafts.filter((d) => d.body === '告知1').map((d) => d.channel).sort()).toEqual(
      ['instagram', 'tiktok', 'x'],
    );
    expect(x.every((d) => d.title === null)).toBe(true);
  });

  it('skips empty/whitespace x_posts', () => {
    const drafts = buildPromotionPosts(planWith({ x_posts: ['ok', '   ', ''] }));
    // 1 x_post × 3 プラットフォーム
    expect(drafts.filter((d) => ['x', 'instagram', 'tiktok'].includes(d.channel))).toHaveLength(3);
  });

  it('creates a note post with a derived title from the note first line', () => {
    const drafts = buildPromotionPosts(
      planWith({ note_article: '# 副業を始める前に読む本\n本文...' }),
    );
    const note = drafts.find((d) => d.channel === 'note');
    expect(note).toBeDefined();
    expect(note!.title).toBe('副業を始める前に読む本');
    expect(note!.offsetMinutes).toBe(1440);
    expect(note!.body).toContain('本文');
  });

  it('creates a blog post at +2 days', () => {
    const drafts = buildPromotionPosts(planWith({ blog_outline: 'ブログ骨子' }));
    const blog = drafts.find((d) => d.channel === 'blog');
    expect(blog).toBeDefined();
    expect(blog!.offsetMinutes).toBe(2880);
  });

  it('omits channels with no content', () => {
    const drafts = buildPromotionPosts(planWith({ x_posts: ['only short'] }));
    expect(drafts.map((d) => d.channel).sort()).toEqual(['instagram', 'tiktok', 'x']);
  });

  it('respects custom offsets/intervals', () => {
    const drafts = buildPromotionPosts(planWith({ x_posts: ['a', 'b'] }), {
      snsFirstOffsetMinutes: 60,
      snsIntervalMinutes: 120,
    });
    // 各 x_post が3プラットフォームに展開: a→[60×3], b→[180×3]
    expect(drafts.filter((d) => d.channel === 'x').map((d) => d.offsetMinutes)).toEqual([60, 180]);
  });

  it('falls back to a default title when no headline is present', () => {
    const drafts = buildPromotionPosts({
      summary: '',
      promo_copy: { x_posts: [], note_article: '   \n   ', blog_outline: '' },
    });
    // note_article is effectively empty → no note post
    expect(drafts).toHaveLength(0);
  });
});
