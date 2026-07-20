/**
 * F-059 — 育成投稿担当 (content_creator) の I/O 契約。
 *
 * アカウント戦略(sns_strategist)の「発信の柱(content_pillars)」から、宣伝ではない
 * **価値提供型の投稿**を生成する。フォロワーを増やす(=アカウントを育てる)ための投稿で、
 * 本の売り込みはしない(たまに世界観を匂わせる程度)。宣伝(promo)投稿と 8:2 で混ぜて運用する。
 */
import { z } from 'zod';

import { PromotionChannelSchema } from '../promotion/channels.js';

/** 生成の材料となる発信の柱 1 本 (sns_strategist の content_pillars 由来)。 */
export const ContentPillarSeedSchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(300).default(''),
  example_post: z.string().max(400).default(''),
});
export type ContentPillarSeed = z.infer<typeof ContentPillarSeedSchema>;

export const ContentCreatorInputSchema = z.object({
  channel: PromotionChannelSchema,
  /** アカウントのポジショニング宣言。 */
  concept: z.string().max(600).default(''),
  /** トーン&マナー(語り口)。 */
  tone_of_voice: z.string().max(300).default(''),
  /** 発信の柱 (これを軸に価値投稿を作る)。 */
  pillars: z.array(ContentPillarSeedSchema).min(1).max(6),
  /** 想定読者サンプル。 */
  target_readers: z.array(z.string().max(300)).max(12).default([]),
  /** 世界観を匂わせる素材としての書名サンプル(売り込みには使わない)。 */
  sample_titles: z.array(z.string().max(200)).max(15).default([]),
  /** 生成する投稿数。 */
  count: z.number().int().min(1).max(30).default(8),
});
export type ContentCreatorInput = z.infer<typeof ContentCreatorInputSchema>;

/** 生成された育成投稿 1 件。上限は LLM 出力を弾かないよう緩めに。 */
export const ValuePostSchema = z.object({
  /** どの柱の投稿か (name)。 */
  pillar: z.string().min(1).max(120),
  /** 投稿本文 (そのまま投稿できる完成文)。 */
  body: z.string().min(1).max(4000),
});
export type ValuePost = z.infer<typeof ValuePostSchema>;

/** LLM が posts をトップ配列で返す/pillar 欠落 等のゆらぎを吸収する。 */
function normalizeContent(raw: unknown): unknown {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { posts?: unknown }).posts)
      ? (raw as { posts: unknown[] }).posts
      : null;
  if (!arr) return raw;
  const posts = arr
    .map((p) => {
      if (typeof p === 'string') return { pillar: '一般', body: p };
      if (p && typeof p === 'object') {
        const o = p as Record<string, unknown>;
        return { pillar: typeof o.pillar === 'string' && o.pillar ? o.pillar : '一般', body: o.body ?? o.text ?? o.post ?? '' };
      }
      return p;
    })
    .filter((p) => p && typeof (p as { body?: unknown }).body === 'string' && (p as { body: string }).body.length > 0);
  return { posts };
}

export const AccountContentOutputSchema = z.preprocess(
  normalizeContent,
  z.object({
    posts: z.array(ValuePostSchema).min(1).max(30),
  }),
);
export type AccountContentOutput = z.infer<typeof AccountContentOutputSchema>;
