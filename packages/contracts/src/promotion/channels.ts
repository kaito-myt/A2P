/**
 * F-052 — 販促チャンネル自動運用の共有契約。
 *
 * 販促プラン (PromotionPlanOutput) から SNS / note / ブログの投稿ドラフトを
 * 日程付きで機械的に導出し、worker のディスパッチャが期限到来分を各チャンネルへ
 * 自動投稿する。ここには「チャンネル種別」「投稿ステータス」「投稿ドラフト型」と
 * 純粋な導出関数 `buildPromotionPosts` を置く (LLM 呼び出しなし・決定的)。
 */
import { z } from 'zod';

import type { PromotionPlanOutput } from '../agents/promoter.js';

/** 販促チャンネル種別。 */
export const PROMOTION_CHANNELS = ['sns', 'note', 'blog'] as const;
export const PromotionChannelSchema = z.enum(PROMOTION_CHANNELS);
export type PromotionChannel = z.infer<typeof PromotionChannelSchema>;

/** 投稿ステータス。 */
export const PROMOTION_POST_STATUSES = [
  'draft', // 生成直後だが日程未確定
  'scheduled', // 予定済 (期限到来で投稿対象)
  'posting', // 投稿処理中
  'posted', // 投稿成功
  'failed', // 投稿失敗
  'skipped', // 条件により送信せずスキップ
  'canceled', // 運営者が取消
] as const;
export const PromotionPostStatusSchema = z.enum(PROMOTION_POST_STATUSES);
export type PromotionPostStatus = z.infer<typeof PromotionPostStatusSchema>;

/** buildPromotionPosts が返す投稿ドラフト 1 件 (DB 挿入前の素材)。 */
export interface PromotionPostDraft {
  channel: PromotionChannel;
  /** note/blog の見出し。SNS は null。 */
  title: string | null;
  /** 投稿本文。 */
  body: string;
  /** baseTime からの相対オフセット (分)。呼び出し側が baseTime に加算して scheduled_for を決める。 */
  offsetMinutes: number;
}

/** buildPromotionPosts のオプション。 */
export interface BuildPromotionPostsOptions {
  /** SNS 投稿を初回から何分間隔で並べるか (既定 1日=1440分)。 */
  snsIntervalMinutes?: number;
  /** SNS 初回投稿の baseTime からのオフセット (既定 0)。 */
  snsFirstOffsetMinutes?: number;
  /** note 記事の baseTime からのオフセット (既定 1日後)。 */
  noteOffsetMinutes?: number;
  /** ブログ記事の baseTime からのオフセット (既定 2日後)。 */
  blogOffsetMinutes?: number;
}

const DAY = 1440;

/**
 * 販促プランから SNS / note / ブログの投稿ドラフトを日程付きで導出する。
 *
 * - SNS: `promo_copy.x_posts[]` を snsInterval 間隔で並べる (launch 週に日次投稿する想定)。
 * - note: `promo_copy.note_article` を 1 本 (見出しは summary 冒頭から生成)。
 * - blog: `promo_copy.blog_outline` を 1 本。
 *
 * 決定的な純関数 (Date に依存しない)。scheduled_for の確定は呼び出し側で
 * `baseTime + offsetMinutes` を計算して行う。
 */
export function buildPromotionPosts(
  plan: Pick<PromotionPlanOutput, 'promo_copy'> & Partial<Pick<PromotionPlanOutput, 'summary'>>,
  options: BuildPromotionPostsOptions = {},
): PromotionPostDraft[] {
  const snsInterval = options.snsIntervalMinutes ?? DAY;
  const snsFirst = options.snsFirstOffsetMinutes ?? 0;
  const noteOffset = options.noteOffsetMinutes ?? DAY;
  const blogOffset = options.blogOffsetMinutes ?? 2 * DAY;

  const drafts: PromotionPostDraft[] = [];
  const copy = plan.promo_copy;

  // SNS: 各 x_post を 1 投稿に
  const xPosts = Array.isArray(copy?.x_posts) ? copy.x_posts : [];
  xPosts.forEach((body, i) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text.length === 0) return;
    drafts.push({
      channel: 'sns',
      title: null,
      body: text,
      offsetMinutes: snsFirst + i * snsInterval,
    });
  });

  // note: 記事 1 本
  const note = typeof copy?.note_article === 'string' ? copy.note_article.trim() : '';
  if (note.length > 0) {
    drafts.push({
      channel: 'note',
      title: deriveTitle(plan.summary, note),
      body: note,
      offsetMinutes: noteOffset,
    });
  }

  // blog: 骨子 1 本
  const blog = typeof copy?.blog_outline === 'string' ? copy.blog_outline.trim() : '';
  if (blog.length > 0) {
    drafts.push({
      channel: 'blog',
      title: deriveTitle(plan.summary, blog),
      body: blog,
      offsetMinutes: blogOffset,
    });
  }

  return drafts;
}

/** 記事見出しを summary / 本文の先頭行から決める (最大 60 字)。 */
function deriveTitle(summary: string | undefined, body: string): string {
  const firstLine = (s: string): string => {
    for (const raw of s.split('\n')) {
      const line = raw.replace(/^#+\s*/, '').trim();
      if (line.length > 0) return line;
    }
    return '';
  };
  const candidate = firstLine(body) || firstLine(summary ?? '') || '新刊のお知らせ';
  return candidate.slice(0, 60);
}
