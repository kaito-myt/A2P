import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  buildPromotionPosts,
  pickAccountForChannel,
  appendPurchaseLink,
  appendHashtags,
  amazonUrlForAsin,
  truncateToWeight,
  resolveHashtags,
  X_MAX_WEIGHT,
} from '@a2p/contracts/promotion/channels';
import type { PromotionPlanOutput } from '@a2p/contracts/agents/promoter';
import { ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `promotion.posts.generate` タスク (F-052)
 *
 * 本の PromotionPlan から SNS/note/ブログの投稿ドラフトを日程付きで生成し、
 * `promotion_posts` に登録する。入稿(publish)→販促プラン生成の後段で自動起動され、
 * その後は dispatcher が期限到来分を自動投稿する。
 *
 * 冪等性: 既存の未投稿(scheduled/draft)分を削除してから作り直す (再生成に対応)。
 * 既に投稿済(posted/posting/failed)のものは残す。
 */

export const PROMOTION_POSTS_GENERATE_TASK_NAME = 'promotion.posts.generate';

export const PromotionPostsGeneratePayloadSchema = z.object({
  book_id: z.string().min(1),
  /** 日程の基準時刻 (ISO)。未指定なら現在時刻。通常は publish 時刻。 */
  base_time: z.string().optional(),
});

export interface PromotionPostsGeneratePrisma {
  promotionPlan: {
    findUnique: (args: {
      where: { book_id: string };
      select: { plan_json: true };
    }) => Promise<{ plan_json: unknown } | null>;
  };
  book: {
    findUnique: (args: {
      where: { id: string };
      select: { asin: true; theme: { select: { genre: true } } };
    }) => Promise<{ asin: string | null; theme: { genre: string } | null } | null>;
  };
  promotionAccount: {
    findMany: (args: {
      where: { status: string };
      select: { id: true; channel: true; niche: true };
    }) => Promise<Array<{ id: string; channel: string; niche: string }>>;
  };
  promotionChannelSetting?: {
    findMany: (args: {
      select: { channel: true; strategy_json: true };
    }) => Promise<Array<{ channel: string; strategy_json: unknown }>>;
  };
  promotionPost: {
    deleteMany: (args: {
      where: { book_id: string; status: { in: string[] } };
    }) => Promise<{ count: number }>;
    createMany: (args: {
      data: Array<{
        book_id: string;
        channel: string;
        account_id: string | null;
        title: string | null;
        body: string;
        scheduled_for: Date;
        status: string;
      }>;
    }) => Promise<{ count: number }>;
  };
}

export interface PromotionPostsGenerateDeps {
  prisma?: PromotionPostsGeneratePrisma;
  logger?: Logger;
  now?: () => Date;
}

export interface PromotionPostsGenerateResult {
  created: number;
  removed: number;
}

export async function runPromotionPostsGenerate(
  payload: unknown,
  deps: PromotionPostsGenerateDeps = {},
): Promise<PromotionPostsGenerateResult> {
  const parsed = PromotionPostsGeneratePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('promotion.posts.generate payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PROMOTION_POSTS_GENERATE_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PromotionPostsGeneratePrisma);
  const now = deps.now ?? (() => new Date());

  const baseTime = parsed.data.base_time ? new Date(parsed.data.base_time) : now();
  const baseMs = Number.isNaN(baseTime.getTime()) ? now().getTime() : baseTime.getTime();

  const planRow = await prisma.promotionPlan.findUnique({
    where: { book_id: bookId },
    select: { plan_json: true },
  });
  if (!planRow) {
    log.info({ task: PROMOTION_POSTS_GENERATE_TASK_NAME, bookId }, 'no promotion plan — nothing to generate');
    return { created: 0, removed: 0 };
  }

  const plan = planRow.plan_json as PromotionPlanOutput;
  const drafts = buildPromotionPosts(plan);

  // 未投稿の既存分を作り直す (再生成対応)。投稿済/処理中/失敗は温存。
  const removed = await prisma.promotionPost.deleteMany({
    where: { book_id: bookId, status: { in: ['scheduled', 'draft'] } },
  });

  if (drafts.length === 0) {
    log.info({ task: PROMOTION_POSTS_GENERATE_TASK_NAME, bookId }, 'plan has no channel content — no posts');
    return { created: 0, removed: removed.count };
  }

  // P4 増分2: 接続済み台帳アカウントへ投稿をルーティング（無ければ channel 既定設定を使う）。
  const bookRow = await prisma.book.findUnique({
    where: { id: bookId },
    select: { asin: true, theme: { select: { genre: true } } },
  });
  const genre = bookRow?.theme?.genre ?? null;
  const asin = bookRow?.asin ?? null;
  const connectedAccounts = await prisma.promotionAccount.findMany({
    where: { status: 'connected' },
    select: { id: true, channel: true, niche: true },
  });

  // F-057: チャンネル別のアカウント戦略（定番ハッシュタグ）を投稿に反映する。
  const channelSettings = prisma.promotionChannelSetting
    ? await prisma.promotionChannelSetting.findMany({
        select: { channel: true, strategy_json: true },
      })
    : [];
  const coreHashtagsByChannel = new Map<string, string[]>();
  for (const cs of channelSettings) {
    const tags = extractCoreHashtags(cs.strategy_json);
    if (tags.length > 0) coreHashtagsByChannel.set(cs.channel, tags);
  }

  // 売上導線: ASIN があれば購入リンクを付与。**X のみ** 重み(280,日本語=2,URL=23)に収める。
  // IG/TikTok/note/blog は長文キャプション可なのでそのまま(フルキャプション)。
  // 最後にチャンネル戦略の定番ハッシュタグを付与する。
  const finalizeBody = (channel: string, body: string): string => {
    const withLink = amazonUrlForAsin(asin)
      ? appendPurchaseLink(channel, body, asin)
      : channel === 'x'
        ? truncateToWeight(body.trim(), X_MAX_WEIGHT)
        : body;
    // 戦略タグが無いチャンネルでもデフォルトの本紹介タグにフォールバックして必ず付与する
    // (blog は本文が長文/記事なのでタグ付与しない)。
    if (channel === 'blog') return withLink;
    const tags = resolveHashtags(coreHashtagsByChannel.get(channel));
    return appendHashtags(channel, withLink, tags);
  };

  const created = await prisma.promotionPost.createMany({
    data: drafts.map((d) => ({
      book_id: bookId,
      channel: d.channel,
      account_id: pickAccountForChannel(d.channel, genre, connectedAccounts),
      title: d.title,
      body: finalizeBody(d.channel, d.body),
      scheduled_for: new Date(baseMs + d.offsetMinutes * 60_000),
      status: 'scheduled',
    })),
  });

  log.info(
    { task: PROMOTION_POSTS_GENERATE_TASK_NAME, bookId, created: created.count, removed: removed.count },
    'promotion posts generated',
  );
  return { created: created.count, removed: removed.count };
}

/** strategy_json (AccountStrategyProfile) から定番ハッシュタグ core[] を安全に取り出す。 */
function extractCoreHashtags(strategyJson: unknown): string[] {
  if (!strategyJson || typeof strategyJson !== 'object') return [];
  const hs = (strategyJson as { hashtag_strategy?: unknown }).hashtag_strategy;
  if (!hs || typeof hs !== 'object') return [];
  const core = (hs as { core?: unknown }).core;
  if (!Array.isArray(core)) return [];
  return core.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
}

export const promotionPostsGenerateTask: Task = async (payload: unknown, _helpers: JobHelpers) => {
  await runPromotionPostsGenerate(payload);
};
