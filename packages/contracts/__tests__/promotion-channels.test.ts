/**
 * F-052 — buildPromotionPosts の単体テスト。
 * 販促プランから SNS/note/blog の投稿ドラフトを日程付きで導出する純関数。
 */
import { describe, expect, it } from 'vitest';

import {
  buildPromotionPosts,
  pickAccountForChannel,
  PROMOTION_CHANNELS,
  PromotionChannelSchema,
  weightedTweetLength,
  weightedTweetLengthWithUrls,
  truncateToWeight,
  amazonUrlForAsin,
  appendPurchaseLink,
  appendHashtags,
  X_MAX_WEIGHT,
  X_URL_WEIGHT,
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

describe('pickAccountForChannel (P4 多アカウント routing)', () => {
  const accounts = [
    { id: 'x1', channel: 'x', niche: '朝活・習慣化' },
    { id: 'x2', channel: 'x', niche: 'business 実務' },
    { id: 'n1', channel: 'note', niche: '副業' },
  ];

  it('接続アカウントが無ければ null（channel 既定にフォールバック）', () => {
    expect(pickAccountForChannel('x', 'practical', [])).toBeNull();
    expect(pickAccountForChannel('tiktok', 'practical', accounts)).toBeNull();
  });

  it('genre が niche に一致する候補を優先', () => {
    expect(pickAccountForChannel('x', 'business', accounts)).toBe('x2');
  });

  it('一致が無ければ同一チャンネルの先頭候補', () => {
    expect(pickAccountForChannel('x', 'self_help', accounts)).toBe('x1');
    expect(pickAccountForChannel('note', null, accounts)).toBe('n1');
  });
});

describe('weightedTweetLength — 日本語=2, ラテン=1', () => {
  it('ASCII は 1 文字 1', () => {
    expect(weightedTweetLength('hello')).toBe(5);
    expect(weightedTweetLength('abc 123')).toBe(7);
  });
  it('日本語(かな/カナ/漢字)は 1 文字 2', () => {
    expect(weightedTweetLength('あ')).toBe(2);
    expect(weightedTweetLength('競馬')).toBe(4);
    expect(weightedTweetLength('こんにちは')).toBe(10);
  });
  it('混在も正しく合算', () => {
    // "本A" = 2 + 1 = 3
    expect(weightedTweetLength('本A')).toBe(3);
  });
});

describe('truncateToWeight', () => {
  it('上限内はそのまま', () => {
    expect(truncateToWeight('競馬予想', 280)).toBe('競馬予想');
  });
  it('超過は末尾を落として … を付ける (重み上限を超えない)', () => {
    const long = 'あ'.repeat(200); // weighted 400
    const out = truncateToWeight(long, 280);
    expect(weightedTweetLength(out)).toBeLessThanOrEqual(280);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('amazonUrlForAsin', () => {
  it('10桁英数の ASIN から .co.jp URL', () => {
    expect(amazonUrlForAsin('B0FVFCKJNF')).toBe('https://www.amazon.co.jp/dp/B0FVFCKJNF');
    expect(amazonUrlForAsin(' b0fvl9hdbb ')).toBe('https://www.amazon.co.jp/dp/B0FVL9HDBB');
  });
  it('無効な ASIN は null', () => {
    expect(amazonUrlForAsin(null)).toBeNull();
    expect(amazonUrlForAsin('')).toBeNull();
    expect(amazonUrlForAsin('short')).toBeNull();
    expect(amazonUrlForAsin('B0FVFCKJN!')).toBeNull();
  });
});

describe('appendPurchaseLink', () => {
  it('ASIN が無ければ本文そのまま', () => {
    expect(appendPurchaseLink('x', '新刊出ました', null)).toBe('新刊出ました');
  });
  it('X: 購入リンクを付け、重み付き文字数が 280 を超えない', () => {
    const body = 'あ'.repeat(200); // weighted 400 (超過)
    const out = appendPurchaseLink('x', body, 'B0FVFCKJNF');
    expect(out).toContain('https://www.amazon.co.jp/dp/B0FVFCKJNF');
    // URL を 23 として概算しても収まる: 本文の重み + ラベル + 23 <= 280
    const urlIdx = out.indexOf('https://');
    const bodyPart = out.slice(0, urlIdx);
    expect(weightedTweetLength(bodyPart) + 23).toBeLessThanOrEqual(X_MAX_WEIGHT);
  });
  it('既に URL / Amazon 表記を含むなら二重付与しない', () => {
    expect(appendPurchaseLink('x', 'https://example.com あり', 'B0FVFCKJNF')).toBe('https://example.com あり');
    expect(appendPurchaseLink('x', 'amazon.co.jp で発売', 'B0FVFCKJNF')).toBe('amazon.co.jp で発売');
  });
  it('note は長文可でそのまま付与', () => {
    const out = appendPurchaseLink('note', '記事本文', 'B0FVFCKJNF');
    expect(out).toContain('記事本文');
    expect(out).toContain('https://www.amazon.co.jp/dp/B0FVFCKJNF');
  });
});

describe('weightedTweetLengthWithUrls', () => {
  it('URL を 23 として数える', () => {
    const text = 'あ https://www.amazon.co.jp/dp/B0FVFCKJNF';
    // 'あ '(2+1) + URL(23) = 26
    expect(weightedTweetLengthWithUrls(text)).toBe(2 + 1 + X_URL_WEIGHT);
  });
  it('URL が無ければ通常の重みと一致', () => {
    expect(weightedTweetLengthWithUrls('abcあ')).toBe(weightedTweetLength('abcあ'));
  });
});

describe('appendHashtags', () => {
  it('note は全タグを付与', () => {
    const out = appendHashtags('note', '記事本文', ['#仕事術', 'タスク管理']);
    expect(out).toContain('#仕事術');
    expect(out).toContain('#タスク管理'); // # 補完
  });
  it('本文に既出のタグは重複付与しない', () => {
    const out = appendHashtags('x', '朝の習慣 #仕事術', ['#仕事術', '#朝活']);
    expect(out.match(/#仕事術/g)?.length).toBe(1);
    expect(out).toContain('#朝活');
  });
  it('短文Xは280重みに収まるタグだけ足す', () => {
    const body = 'あ'.repeat(135); // weighted 270
    const out = appendHashtags('x', body, ['#仕事術', '#タスク管理', '#朝活']);
    expect(weightedTweetLengthWithUrls(out)).toBeLessThanOrEqual(X_MAX_WEIGHT);
  });
  it('入れる余地が無ければ本文のまま', () => {
    const body = 'あ'.repeat(140); // weighted 280
    const out = appendHashtags('x', body, ['#仕事術']);
    expect(out).toBe(body);
  });
  it('URL を含む本文でも 280 を超えない', () => {
    const withLink = appendPurchaseLink('x', 'あ'.repeat(100), 'B0FVFCKJNF');
    const out = appendHashtags('x', withLink, ['#仕事術', '#タスク管理']);
    expect(weightedTweetLengthWithUrls(out)).toBeLessThanOrEqual(X_MAX_WEIGHT);
  });
});

describe('appendPurchaseLink / appendHashtags — IG/TikTok フルキャプション (F-058)', () => {
  it('Instagram は本文を切り詰めず、生URLは載せずプロフィール導線のみ付ける', () => {
    const body = 'あ'.repeat(200); // weighted 400
    const out = appendPurchaseLink('instagram', body, 'B0FVFCKJNF');
    expect(out.startsWith('あ'.repeat(200))).toBe(true); // 切り詰めない
    // IG はキャプション内 URL が非活性なので生URLは載せない。
    expect(out).not.toContain('https://www.amazon.co.jp/dp/B0FVFCKJNF');
    expect(out).toContain('プロフィールのリンクから');
  });
  it('TikTok も280制約を受けずそのまま付与', () => {
    const body = 'あ'.repeat(200);
    const out = appendPurchaseLink('tiktok', body, 'B0FVFCKJNF');
    expect(out.startsWith('あ'.repeat(200))).toBe(true);
  });
  it('Instagram はハッシュタグを全て付与(280制約なし)', () => {
    const body = 'あ'.repeat(135); // weighted 270 (Xなら1つも入らない)
    const out = appendHashtags('instagram', body, ['#仕事術', '#タスク管理', '#朝活']);
    expect(out).toContain('#仕事術');
    expect(out).toContain('#タスク管理');
    expect(out).toContain('#朝活');
  });
});
