import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { optimizeScheduledPosts as defaultOptimize } from '@a2p/agents';
import { AccountStrategyProfileSchema } from '@a2p/contracts/agents';
import type {
  ContentOptimizerInput,
  ContentOptimizerOutput,
} from '@a2p/contracts/agents/content-optimizer';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `promotion.review.daily` タスク (F-061)
 *
 * 毎日1回、戦略を持つ各チャンネルの「予定投稿(scheduled)」本文を content_optimizer で
 * 推敲・改善する。破壊的変更はしない: status='scheduled' のみ対象、scheduled_for/kind は保持。
 * 販促(promo)投稿の購入導線 URL は必ず温存する(URL が消える改善は破棄)。
 *
 * v1 は戦略＋直近投稿ベース。将来 signals(実インプレッション/トレンド)を差し込める設計。
 */
export const PROMOTION_REVIEW_DAILY_TASK_NAME = 'promotion.review.daily';

export const PromotionReviewDailyPayloadSchema = z.object({
  /** 特定チャンネルのみ見直す場合に指定（省略時は戦略のある全チャンネル）。 */
  channel: z.string().optional(),
  /** 何日先までの予定投稿を対象にするか（既定 3 日）。 */
  lookahead_days: z.number().int().min(1).max(30).optional(),
  /** 1チャンネルあたりの最大見直し件数（既定 20）。 */
  max_posts: z.number().int().min(1).max(50).optional(),
});

interface ReviewPost {
  id: string;
  kind: string;
  body: string;
}

interface ReviewPrisma {
  promotionChannelSetting: {
    findMany: (args: {
      where: { strategy_json: { not: null }; channel?: string };
      select: { channel: true; strategy_json: true };
    }) => Promise<Array<{ channel: string; strategy_json: unknown }>>;
  };
  promotionPost: {
    findMany: (args: {
      where: {
        channel: string;
        status: string;
        scheduled_for?: { gte: Date; lte: Date };
      };
      select: { id: true; kind: true; body: true } | { body: true };
      orderBy?: Record<string, 'asc' | 'desc'>;
      take?: number;
    }) => Promise<Array<{ id: string; kind: string; body: string } | { body: string }>>;
    update: (args: {
      where: { id: string };
      data: { body: string; updated_at?: Date };
    }) => Promise<unknown>;
  };
}

export interface PromotionReviewDailyDeps {
  prisma?: ReviewPrisma;
  logger?: Logger;
  now?: () => Date;
  optimize?: (input: ContentOptimizerInput) => Promise<ContentOptimizerOutput>;
}

export interface PromotionReviewDailyResult {
  channels: number;
  reviewed: number;
  updated: number;
}

/** URL を抽出（販促投稿の導線温存チェック用）。 */
function extractUrls(s: string): string[] {
  return s.match(/https?:\/\/\S+/g) ?? [];
}

export async function runPromotionReviewDaily(
  payload: unknown,
  deps: PromotionReviewDailyDeps = {},
): Promise<PromotionReviewDailyResult> {
  const parsed = PromotionReviewDailyPayloadSchema.safeParse(payload ?? {});
  const args = parsed.success ? parsed.data : {};
  const lookaheadDays = args.lookahead_days ?? 3;
  const maxPosts = args.max_posts ?? 20;

  const log = deps.logger ?? createLogger(`worker.${PROMOTION_REVIEW_DAILY_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as ReviewPrisma);
  const now = deps.now ?? (() => new Date());
  const optimize = deps.optimize ?? ((input: ContentOptimizerInput) => defaultOptimize(input));

  const settings = await prisma.promotionChannelSetting.findMany({
    where: { strategy_json: { not: null }, ...(args.channel ? { channel: args.channel } : {}) },
    select: { channel: true, strategy_json: true },
  });

  let reviewed = 0;
  let updated = 0;
  const until = new Date(now().getTime() + lookaheadDays * 24 * 60 * 60 * 1000);

  for (const setting of settings) {
    const profile = setting.strategy_json
      ? AccountStrategyProfileSchema.safeParse(setting.strategy_json)
      : null;
    if (!profile || !profile.success) continue;
    const p = profile.data;

    // 対象: 直近 lookahead 日以内の scheduled
    const upcomingRaw = await prisma.promotionPost.findMany({
      where: { channel: setting.channel, status: 'scheduled', scheduled_for: { gte: now(), lte: until } },
      select: { id: true, kind: true, body: true },
      orderBy: { scheduled_for: 'asc' },
      take: maxPosts,
    });
    const upcoming = upcomingRaw as ReviewPost[];
    if (upcoming.length === 0) continue;

    // 直近の投稿済み本文（傾向把握用）
    const recentRaw = await prisma.promotionPost.findMany({
      where: { channel: setting.channel, status: 'posted' },
      select: { body: true },
      orderBy: { posted_at: 'desc' },
      take: 8,
    });
    const recent = (recentRaw as Array<{ body: string }>).map((r) => r.body);

    let out: ContentOptimizerOutput;
    try {
      out = await optimize({
        channel: setting.channel,
        concept: p.concept ?? '',
        tone_of_voice: p.tone_of_voice ?? '',
        hashtag_core: p.hashtag_strategy?.core ?? [],
        recent_posted: recent,
        drafts: upcoming.map((d) => ({ id: d.id, kind: d.kind, body: d.body })),
      });
    } catch (err) {
      log.warn({ task: PROMOTION_REVIEW_DAILY_TASK_NAME, channel: setting.channel, err }, 'optimize failed — skip channel');
      continue;
    }

    const byId = new Map(upcoming.map((d) => [d.id, d]));
    for (const rev of out.revisions) {
      const orig = byId.get(rev.id);
      if (!orig) continue;
      reviewed += 1;
      const newBody = rev.revised_body.trim();
      if (!rev.changed || newBody.length === 0 || newBody === orig.body.trim()) continue;

      // 販促投稿: 元の URL がすべて残っていなければ破棄（購入導線を守る）。
      if (orig.kind === 'promo') {
        const origUrls = extractUrls(orig.body);
        const keptAll = origUrls.every((u) => newBody.includes(u));
        if (!keptAll) {
          log.info({ task: PROMOTION_REVIEW_DAILY_TASK_NAME, postId: rev.id }, 'revision dropped URL — skip');
          continue;
        }
      }

      await prisma.promotionPost.update({ where: { id: rev.id }, data: { body: newBody, updated_at: now() } });
      updated += 1;
    }

    log.info(
      { task: PROMOTION_REVIEW_DAILY_TASK_NAME, channel: setting.channel, upcoming: upcoming.length },
      'channel reviewed',
    );
  }

  log.info({ task: PROMOTION_REVIEW_DAILY_TASK_NAME, channels: settings.length, reviewed, updated }, 'daily review done');
  return { channels: settings.length, reviewed, updated };
}

export const promotionReviewDailyTask: Task = async (payload: unknown, _helpers: JobHelpers) => {
  await runPromotionReviewDaily(payload);
};
