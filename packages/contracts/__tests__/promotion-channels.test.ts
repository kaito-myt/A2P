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
  sanitizePromoBody,
  priceFactLine,
  finalizePromoBody,
  KU_FREE_NOTE,
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

describe('sanitizePromoBody — 捏造事実の除去 (品質改善 2026-07-29)', () => {
  it('生URL(捏造ASINリンク含む)を除去する', () => {
    const out = sanitizePromoBody('良書です。 https://www.amazon.co.jp/dp/B0FAKE00000 どうぞ');
    expect(out).not.toContain('http');
    expect(out).not.toContain('B0FAKE00000');
    expect(out).toContain('良書です');
  });
  it('Amazon短縮URLも除去する', () => {
    const out = sanitizePromoBody('チェック → amzn.to/abc123 です');
    expect(out).not.toContain('amzn.to');
  });
  it('行っていないセール/割引の文を除去する', () => {
    const out = sanitizePromoBody('今だけ7日間限定99円！通常480円→99円。良い本です。');
    expect(out).not.toMatch(/99円|セール|限定|通常/);
    expect(out).toContain('良い本です');
  });
  it('根拠のないランキング/実績主張を除去する', () => {
    const out = sanitizePromoBody('Amazon自己啓発カテゴリで1位を獲得！内容は本物です。');
    expect(out).not.toMatch(/1位|ランキング|カテゴリ.*位/);
    expect(out).toContain('内容は本物');
  });
  it('価格への言及を除去する(検証済み価格を後段で注入するため)', () => {
    const out = sanitizePromoBody('Kindleで480円 / Kindle Unlimited会員は0円で読めます。おすすめです。');
    expect(out).not.toMatch(/480円|0円/);
    expect(out).toContain('おすすめ');
  });
  it('書名中の金額(例「月12万円で…」)は壊さない', () => {
    const out = sanitizePromoBody('『月12万円で心ゆたかに暮らす』という本を書きました。');
    expect(out).toContain('月12万円で心ゆたかに暮らす');
  });
  it('URL無しの購入導線プレースホルダ行を除去する', () => {
    const out = sanitizePromoBody('良書です。\n\n▼Amazonの商品ページはこちら\n(リンク)\n\nぜひ。');
    expect(out).not.toMatch(/リンク|商品ページ/);
    expect(out).toContain('良書です');
    expect(out).toContain('ぜひ');
  });
  it('「ご購入はこちら」「詳細はこちら」等の導線行も除去する', () => {
    const out = sanitizePromoBody('内容紹介。\nご購入はこちら\n詳細はこちらから\n本文つづき');
    expect(out).not.toMatch(/購入はこちら|詳細はこちら/);
    expect(out).toContain('内容紹介');
    expect(out).toContain('本文つづき');
  });
});

describe('priceFactLine', () => {
  it('価格ありは Kindle◯円 + KU無料訴求', () => {
    expect(priceFactLine(480)).toBe(`📘 Kindle 480円（${KU_FREE_NOTE}）`);
  });
  it('価格なし/0は KU無料訴求のみ', () => {
    expect(priceFactLine(null)).toBe(`📘 ${KU_FREE_NOTE}`);
    expect(priceFactLine(0)).toBe(`📘 ${KU_FREE_NOTE}`);
  });
});

describe('finalizePromoBody — 事実サニタイズ + 検証済み事実注入', () => {
  it('X: 捏造URLを消し、実ASINの正規URL・実価格・ハッシュタグを注入し 280 内に収める', () => {
    const out = finalizePromoBody({
      channel: 'x',
      body: '努力の常識を疑う本です。 https://www.amazon.co.jp/dp/B0FAKE00000 通常480円→99円セール中！',
      asin: 'B0FVFCKJNF',
      priceJpy: 480,
      hashtags: ['#読書', '#自己啓発'],
    });
    expect(out).toContain('https://www.amazon.co.jp/dp/B0FVFCKJNF'); // 正規URL
    expect(out).not.toContain('B0FAKE00000'); // 捏造URL除去
    expect(out).not.toMatch(/99円|セール/); // 捏造セール除去
    expect(out).toContain('Kindle 480円'); // 検証済み価格
    expect(out).toMatch(/#(読書|自己啓発)/); // ハッシュタグ必須
    expect(weightedTweetLengthWithUrls(out)).toBeLessThanOrEqual(X_MAX_WEIGHT);
  });
  it('X: 実ASINが無ければ偽URLを一切出さない', () => {
    const out = finalizePromoBody({
      channel: 'x',
      body: '良書。 https://www.amazon.co.jp/dp/B0FAKE00000',
      asin: null,
      priceJpy: 550,
      hashtags: ['#本'],
    });
    expect(out).not.toContain('http');
    expect(out).toContain('Kindle 550円');
    expect(out).toContain('#本');
  });
  it('X: 短い本文でもハッシュタグが必ず付く(枠を予約)', () => {
    const out = finalizePromoBody({
      channel: 'x',
      body: 'あ'.repeat(120), // weighted 240
      asin: 'B0FVFCKJNF',
      priceJpy: 480,
      hashtags: ['#読書', '#おすすめ本'],
    });
    expect(out).toMatch(/#読書|#おすすめ本/);
    expect(weightedTweetLengthWithUrls(out)).toBeLessThanOrEqual(X_MAX_WEIGHT);
  });
  it('instagram: 長文可・URL明記・プロフィール導線・全ハッシュタグ', () => {
    const out = finalizePromoBody({
      channel: 'instagram',
      body: 'あ'.repeat(200),
      asin: 'B0FVFCKJNF',
      priceJpy: 680,
      hashtags: ['#本紹介', '#読書記録', '#ブックスタグラム'],
    });
    expect(out).toContain('あ'.repeat(200));
    expect(out).toContain('https://www.amazon.co.jp/dp/B0FVFCKJNF');
    expect(out).toContain('プロフィール');
    expect(out).toContain('Kindle 680円');
    expect(out).toContain('#ブックスタグラム');
  });
  it('tiktok: ASINなしでも価格・導線・ハッシュタグを付与', () => {
    const out = finalizePromoBody({
      channel: 'tiktok',
      body: 'この本おすすめです',
      asin: null,
      priceJpy: 500,
      hashtags: null, // → デフォルト本紹介タグ
    });
    expect(out).toContain('Kindle 500円');
    expect(out).toContain('プロフィール');
    expect(out).toMatch(/#本紹介|#読書/);
  });
  it('blog: 本文重視・ハッシュタグ無し・価格/URLのみ', () => {
    const out = finalizePromoBody({
      channel: 'blog',
      body: 'ブログ記事の骨子',
      asin: 'B0FVFCKJNF',
      priceJpy: 750,
      hashtags: ['#本'],
    });
    expect(out).toContain('ブログ記事の骨子');
    expect(out).toContain('Kindle 750円');
    expect(out).toContain('https://www.amazon.co.jp/dp/B0FVFCKJNF');
    expect(out).not.toContain('#本');
  });
});

describe('appendPurchaseLink / appendHashtags — IG/TikTok フルキャプション (F-058)', () => {
  it('Instagram は本文を切り詰めず、Amazon URL＋プロフィール導線を付ける', () => {
    const body = 'あ'.repeat(200); // weighted 400
    const out = appendPurchaseLink('instagram', body, 'B0FVFCKJNF');
    expect(out.startsWith('あ'.repeat(200))).toBe(true); // 切り詰めない
    expect(out).toContain('https://www.amazon.co.jp/dp/B0FVFCKJNF'); // URL は明記する
    expect(out).toContain('プロフィールのリンク');
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
