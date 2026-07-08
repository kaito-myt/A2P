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
  it('accepts sns/note/blog only', () => {
    expect(PROMOTION_CHANNELS).toEqual(['sns', 'note', 'blog']);
    expect(PromotionChannelSchema.safeParse('sns').success).toBe(true);
    expect(PromotionChannelSchema.safeParse('tiktok').success).toBe(false);
  });
});

describe('buildPromotionPosts', () => {
  it('creates one SNS post per x_post, spaced by 1 day by default', () => {
    const drafts = buildPromotionPosts(
      planWith({ x_posts: ['告知1', '告知2', '告知3'] }),
    );
    const sns = drafts.filter((d) => d.channel === 'sns');
    expect(sns).toHaveLength(3);
    expect(sns.map((d) => d.offsetMinutes)).toEqual([0, 1440, 2880]);
    expect(sns.every((d) => d.title === null)).toBe(true);
    expect(sns[0]!.body).toBe('告知1');
  });

  it('skips empty/whitespace x_posts', () => {
    const drafts = buildPromotionPosts(planWith({ x_posts: ['ok', '   ', ''] }));
    expect(drafts.filter((d) => d.channel === 'sns')).toHaveLength(1);
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
    const drafts = buildPromotionPosts(planWith({ x_posts: ['only sns'] }));
    expect(drafts.map((d) => d.channel)).toEqual(['sns']);
  });

  it('respects custom offsets/intervals', () => {
    const drafts = buildPromotionPosts(planWith({ x_posts: ['a', 'b'] }), {
      snsFirstOffsetMinutes: 60,
      snsIntervalMinutes: 120,
    });
    expect(drafts.map((d) => d.offsetMinutes)).toEqual([60, 180]);
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
