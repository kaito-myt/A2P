import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { generatePromoPlaybook as defaultGenerate } from '@a2p/agents';
import { AccountStrategyProfileSchema } from '@a2p/contracts/agents';
import { PromoPlaybookSchema } from '@a2p/contracts/agents/promo-strategist';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `promotion.playbook.refresh` タスク (F-064)
 *
 * 戦略を持つ各チャンネルについて、promo_strategist(web_search)で「今伸びている型」を
 * リサーチし、PromoPlaybook を `promotion_channel_settings.playbook_json` に保存する。
 * 保存されたプレイブックは日次見直し(content_optimizer)等の投稿生成へ注入される。
 */
export const PROMOTION_PLAYBOOK_REFRESH_TASK_NAME = 'promotion.playbook.refresh';

export const PromotionPlaybookRefreshPayloadSchema = z.object({
  channel: z.string().optional(),
});

export interface PlaybookRefreshDeps {
  prisma?: typeof defaultPrisma;
  generate?: typeof defaultGenerate;
  logger?: Logger;
}

export async function runPromotionPlaybookRefresh(
  payload: unknown,
  deps: PlaybookRefreshDeps = {},
): Promise<{ refreshed: number }> {
  const prisma = deps.prisma ?? defaultPrisma;
  const generate = deps.generate ?? defaultGenerate;
  const log = deps.logger ?? createLogger(`worker.${PROMOTION_PLAYBOOK_REFRESH_TASK_NAME}`);

  const parsed = PromotionPlaybookRefreshPayloadSchema.safeParse(payload ?? {});
  const only = parsed.success ? parsed.data.channel : undefined;

  // プレイブックはアカウント運用(戦略)があるチャンネルにのみ意味がある。
  const allSettings = await prisma.promotionChannelSetting.findMany({
    where: only ? { channel: only } : {},
    select: { channel: true, strategy_json: true },
  });
  const settings = allSettings.filter((s) => s.strategy_json != null);

  // ジャンルは在庫の出版済み書籍(テーマ)から代表値を採る（無ければ null=汎用）。
  const book = await prisma.book.findFirst({
    where: { publish_status: 'published', theme_id: { not: null } },
    orderBy: { updated_at: 'desc' },
    select: { theme: { select: { genre: true } } },
  });
  const genre = book?.theme?.genre ?? null;

  let refreshed = 0;
  for (const s of settings) {
    const profile = AccountStrategyProfileSchema.safeParse(s.strategy_json);
    const concept = profile.success ? profile.data.concept : '';

    const recent = await prisma.promotionPost.findMany({
      where: { channel: s.channel, status: 'posted' },
      orderBy: { posted_at: 'desc' },
      take: 6,
      select: { body: true },
    });

    try {
      const playbook = await generate({
        channel: s.channel,
        genre,
        concept,
        recent_posts: recent.map((r) => r.body),
      });
      // 妥当性を確認してから保存。
      const validated = PromoPlaybookSchema.parse({ ...playbook, channel: s.channel });
      await prisma.promotionChannelSetting.update({
        where: { channel: s.channel },
        data: { playbook_json: validated as unknown as object, playbook_updated_at: new Date() },
      });
      refreshed += 1;
      log.info({ task: PROMOTION_PLAYBOOK_REFRESH_TASK_NAME, channel: s.channel }, 'promo playbook refreshed');
    } catch (err) {
      log.warn({ task: PROMOTION_PLAYBOOK_REFRESH_TASK_NAME, channel: s.channel, err }, 'playbook refresh failed — skip');
    }
  }

  return { refreshed };
}

export const promotionPlaybookRefreshTask: Task = async (payload, _helpers: JobHelpers) => {
  await runPromotionPlaybookRefresh(payload);
};
