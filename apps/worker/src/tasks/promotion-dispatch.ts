import type { JobHelpers, Task } from 'graphile-worker';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import { PROMOTION_POST_PUBLISH_TASK_NAME } from './promotion-post-publish.js';

/**
 * `promotion.dispatch` タスク (F-052)
 *
 * cron で定期起動し、期限到来した投稿を `promotion.post.publish` に流す。
 *
 * 対象条件:
 *   - promotion_posts.status = 'scheduled'
 *   - scheduled_for <= now
 *   - チャンネル (sns/note/blog) の auto_enabled = true
 *   - 本の publish_status = 'published'   (未出版の本は投稿しない)
 *
 * 各投稿ごとに個別 try/catch で enqueue し、1 件の失敗が他を止めない。
 */

export const PROMOTION_DISPATCH_TASK_NAME = 'promotion.dispatch';

export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PromotionDispatchPrisma {
  promotionChannelSetting: {
    findMany: (args: {
      where: { auto_enabled: true };
      select: { channel: true };
    }) => Promise<Array<{ channel: string }>>;
  };
  promotionPost: {
    findMany: (args: {
      where: {
        status: string;
        scheduled_for: { lte: Date };
        channel: { in: string[] };
        OR: Array<{ book: { publish_status: string } } | { book_id: null }>;
      };
      select: { id: true; channel: true };
      take: number;
      orderBy: { scheduled_for: 'asc' };
    }) => Promise<Array<{ id: string; channel: string }>>;
  };
}

export interface PromotionDispatchDeps {
  prisma?: PromotionDispatchPrisma;
  addJob?: AddJobLike;
  logger?: Logger;
  now?: () => Date;
  /** 1 tick で処理する最大件数 (既定 100)。 */
  batchLimit?: number;
}

export interface PromotionDispatchResult {
  enabledChannels: number;
  dueposts: number;
  enqueued: number;
  failed: number;
}

export async function runPromotionDispatch(
  deps: PromotionDispatchDeps = {},
): Promise<PromotionDispatchResult> {
  const log = deps.logger ?? createLogger(`worker.${PROMOTION_DISPATCH_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PromotionDispatchPrisma);
  const addJob = deps.addJob;
  if (!addJob) {
    throw new Error(`${PROMOTION_DISPATCH_TASK_NAME}: addJob must be provided (got undefined)`);
  }
  const now = deps.now?.() ?? new Date();
  const limit = deps.batchLimit ?? 100;

  // 1. auto_enabled チャンネルを取得
  const channels = await prisma.promotionChannelSetting.findMany({
    where: { auto_enabled: true },
    select: { channel: true },
  });
  if (channels.length === 0) {
    log.info({ task: PROMOTION_DISPATCH_TASK_NAME }, 'no auto-enabled channels — tick done');
    return { enabledChannels: 0, dueposts: 0, enqueued: 0, failed: 0 };
  }
  const channelKeys = channels.map((c) => c.channel);

  // 2. 期限到来分を取得。宣伝(promo)は出版済みの本のみ。育成(value, book_id=null)は本に依存しない。
  const due = await prisma.promotionPost.findMany({
    where: {
      status: 'scheduled',
      scheduled_for: { lte: now },
      channel: { in: channelKeys },
      OR: [{ book: { publish_status: 'published' } }, { book_id: null }],
    },
    select: { id: true, channel: true },
    take: limit,
    orderBy: { scheduled_for: 'asc' },
  });

  if (due.length === 0) {
    log.info(
      { task: PROMOTION_DISPATCH_TASK_NAME, enabledChannels: channels.length },
      'no due posts — tick done',
    );
    return { enabledChannels: channels.length, dueposts: 0, enqueued: 0, failed: 0 };
  }

  // 3. 各投稿を publish に流す
  let enqueued = 0;
  let failed = 0;
  for (const post of due) {
    try {
      await addJob(PROMOTION_POST_PUBLISH_TASK_NAME, { post_id: post.id });
      enqueued++;
    } catch (err) {
      log.warn(
        { task: PROMOTION_DISPATCH_TASK_NAME, postId: post.id, err },
        'failed to enqueue promotion.post.publish — continuing',
      );
      failed++;
    }
  }

  log.info(
    { task: PROMOTION_DISPATCH_TASK_NAME, enabledChannels: channels.length, dueposts: due.length, enqueued, failed },
    'promotion.dispatch tick done',
  );
  return { enabledChannels: channels.length, dueposts: due.length, enqueued, failed };
}

export const promotionDispatchTask: Task = async (_payload: unknown, helpers: JobHelpers) => {
  await runPromotionDispatch({ addJob: helpers.addJob as unknown as AddJobLike });
};
