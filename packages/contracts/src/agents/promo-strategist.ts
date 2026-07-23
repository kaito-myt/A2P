/**
 * F-064 — 研究駆動の販促プレイブック担当 (promo_strategist) の I/O 契約。
 *
 * web_search で「そのジャンル/プラットフォームで今バズっている本紹介・販促投稿」の傾向を
 * 実地リサーチし、投稿生成に注入できる構造化プレイブックを出力する。
 * 出力は generateText + extractLlmJson で受けるため z.preprocess で形状ドリフトに強くする
 * (marketer/sns_strategist と同方針)。
 */
import { z } from 'zod';

import { GenreValueSchema } from '../genres.js';

export const PromoStrategistInputSchema = z.object({
  channel: z.string().min(1),
  genre: GenreValueSchema.nullable().optional(),
  /** アカウントのコンセプト（戦略より）。 */
  concept: z.string().default(''),
  /** 直近投稿サンプル（現状把握用・任意）。 */
  recent_posts: z.array(z.string()).default([]),
});
export type PromoStrategistInput = z.infer<typeof PromoStrategistInputSchema>;

/** フック型（TikTok/リールの冒頭1秒設計）。 */
export const HookFormulaSchema = z.object({
  name: z.string().min(1),
  template: z.string().min(1),
  example: z.string().default(''),
});

/** 販促プレイブック（投稿生成へ注入する戦略の束）。 */
export const PromoPlaybookSchema = z.object({
  /** このプレイブックが対象とするプラットフォーム。 */
  channel: z.string().default(''),
  /** リサーチ要約（何が伸びているか）。 */
  summary: z.string().default(''),
  /** 有効なフック型。 */
  hook_formulas: z.array(HookFormulaSchema).default([]),
  /** 見出し/キャプションの型（例: 数字リスト, 好奇心ギャップ, 警告）。 */
  headline_styles: z.array(z.string()).default([]),
  /** 有効なコンテンツ角度/切り口。 */
  content_angles: z.array(z.string()).default([]),
  /** ハッシュタグ戦略（ビッグ/ミッド/ニッチの推奨タグ）。 */
  hashtag_tiers: z
    .object({
      big: z.array(z.string()).default([]),
      mid: z.array(z.string()).default([]),
      niche: z.array(z.string()).default([]),
    })
    .default({ big: [], mid: [], niche: [] }),
  /** CTA の型（例: プロフのリンクから / 保存して後で / コメントで）。 */
  cta_patterns: z.array(z.string()).default([]),
  /** 推奨投稿時間（JST・自然文可）。 */
  posting_times: z.array(z.string()).default([]),
  /** 画像/動画デザインの要点。 */
  creative_notes: z.array(z.string()).default([]),
  /** そのまま生成プロンプトへ注入する短い指針（3〜6行）。 */
  do_this: z.array(z.string()).default([]),
});
export type PromoPlaybook = z.infer<typeof PromoPlaybookSchema>;

/** LLM 出力ゆらぎ吸収: playbook を直接 or {playbook:{...}} で受ける。 */
export const PromoStrategistOutputSchema = z.preprocess((raw) => {
  if (raw && typeof raw === 'object' && 'playbook' in (raw as Record<string, unknown>)) {
    return (raw as { playbook: unknown }).playbook;
  }
  return raw;
}, PromoPlaybookSchema);
export type PromoStrategistOutput = z.infer<typeof PromoStrategistOutputSchema>;

/** 生成プロンプトへ注入する短い文字列にプレイブックを畳む。 */
export function playbookToGuidance(pb: PromoPlaybook | null | undefined): string {
  if (!pb) return '';
  const lines: string[] = [];
  if (pb.do_this.length > 0) lines.push('【今のトレンドで効く指針】\n' + pb.do_this.map((d) => ` - ${d}`).join('\n'));
  if (pb.hook_formulas.length > 0) {
    lines.push('【効くフック型】\n' + pb.hook_formulas.slice(0, 4).map((h) => ` - ${h.name}: ${h.template}`).join('\n'));
  }
  if (pb.headline_styles.length > 0) lines.push('【見出しの型】' + pb.headline_styles.slice(0, 5).join(' / '));
  if (pb.cta_patterns.length > 0) lines.push('【CTA】' + pb.cta_patterns.slice(0, 4).join(' / '));
  return lines.join('\n');
}
