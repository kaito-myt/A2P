import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { decryptApiKey } from '@a2p/crypto';
import type { PromotionChannel } from '@a2p/contracts/promotion/channels';
import { ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import {
  createHttpPublisherPort,
  type HttpPublisherDeps,
} from './promotion-post/http-publisher-port.js';
import {
  createStubPublisherPort,
  type PublishChannelConfig,
  type PublisherPort,
} from './promotion-post/publisher-port.js';
import { createBlogPublisherPort } from './promotion-post/blog-publisher-port.js';
import { createAyrsharePublisherPort } from './promotion-post/ayrshare-publisher-port.js';
import { ensureBookPromoImage } from './promotion-post/promo-image.js';

/**
 * `promotion.post.publish` タスク (F-052)
 *
 * `promotion_posts` の 1 行を該当チャンネルへ実投稿する。dispatcher から
 * 期限到来分に対して起動される。
 *
 * ガード:
 *   - post が scheduled でなければスキップ (二重投稿防止)。
 *   - チャンネルの auto_enabled が false ならスキップ (実投稿しない)。
 * 状態遷移: scheduled → posting → posted / failed。
 */

export const PROMOTION_POST_PUBLISH_TASK_NAME = 'promotion.post.publish';

export const PromotionPostPublishPayloadSchema = z.object({
  post_id: z.string().min(1),
  /** 運営者の手動「今すぐ投稿」。true なら auto_enabled ガードを無視する (接続は必要)。 */
  force: z.boolean().optional(),
});

export interface PromotionPostPublishPrisma {
  promotionPost: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        book_id: true;
        channel: true;
        account_id: true;
        title: true;
        body: true;
        status: true;
      };
    }) => Promise<{
      id: string;
      book_id: string | null;
      channel: string;
      account_id: string | null;
      title: string | null;
      body: string;
      status: string;
    } | null>;
    updateMany: (args: {
      where: { id: string; status: string };
      data: { status: string };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: {
        status?: string;
        external_url?: string | null;
        error?: string | null;
        posted_at?: Date | null;
      };
    }) => Promise<unknown>;
  };
  promotionChannelSetting: {
    findUnique: (args: {
      where: { channel: string };
      select: { auto_enabled: true; handle: true; token_enc: true; config_json: true };
    }) => Promise<{
      auto_enabled: boolean;
      handle: string | null;
      token_enc: string | null;
      config_json: unknown;
    } | null>;
  };
  // P4 増分2: 投稿が特定の台帳アカウントに紐づく場合、その資格情報で投稿する。
  promotionAccount?: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true; handle: true; token_enc: true; config_json: true };
    }) => Promise<{ status: string; handle: string | null; token_enc: string | null; config_json: unknown } | null>;
  };
}

export interface PromotionPostPublishDeps {
  prisma?: PromotionPostPublishPrisma;
  logger?: Logger;
  /** チャンネル→ポート解決 (テスト差し替え)。既定は env で stub/http/ayrshare を選ぶ。 */
  resolvePort?: (channel: string) => PublisherPort;
  /** token_enc 復号関数 (テスト差し替え)。 */
  decryptToken?: (enc: string) => string;
  /** F-058: IG/TikTok の添付メディア(公開URL)を用意する。既定は販促画像を生成し署名URLを返す。 */
  buildMediaUrls?: (channel: string, bookId: string | null) => Promise<string[]>;
  now?: () => Date;
}

export type PromotionPostPublishResult =
  | { status: 'posted'; externalUrl: string | null }
  | { status: 'failed'; reason: string; message: string }
  | { status: 'skipped'; reason: string };

function defaultResolvePort(channel: string): PublisherPort {
  if (process.env.PROMOTION_PUBLISHER === 'stub') {
    return createStubPublisherPort();
  }
  // 所有ブログは第三者接続不要 — ツール自身の blog_posts に公開する。
  if (channel === 'blog') {
    return createBlogPublisherPort();
  }
  // F-058: IG/TikTok は Ayrshare 経由 (API キーがある場合)。無ければ http(webhook)にフォールバック。
  if ((channel === 'instagram' || channel === 'tiktok') && process.env.AYRSHARE_API_KEY) {
    return createAyrsharePublisherPort();
  }
  const httpDeps: HttpPublisherDeps = {};
  return createHttpPublisherPort(httpDeps);
}

/**
 * IG/TikTok の添付メディア既定実装。
 *  - 宣伝(本あり): その本の販促画像を生成し署名 URL を返す。
 *  - 育成(book_id=null): アカウントのカバー画像(banner)を流用する。
 */
async function defaultBuildMediaUrls(channel: string, bookId: string | null): Promise<string[]> {
  if (channel !== 'instagram' && channel !== 'tiktok') return [];
  const storage = await import('@a2p/storage');
  if (bookId) {
    const key = await ensureBookPromoImage(bookId);
    if (!key) return [];
    return [await storage.getSignedDownloadUrl(key, 3600)];
  }
  // 育成投稿: チャンネルのカバー画像(strategy の banner)を使う。
  const { prisma } = await import('@a2p/db');
  const setting = await prisma.promotionChannelSetting.findUnique({
    where: { channel },
    select: { banner_key: true },
  });
  if (!setting?.banner_key) return [];
  return [await storage.getSignedDownloadUrl(setting.banner_key, 3600)];
}

export async function runPromotionPostPublish(
  payload: unknown,
  deps: PromotionPostPublishDeps = {},
): Promise<PromotionPostPublishResult> {
  const parsed = PromotionPostPublishPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('promotion.post.publish payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { post_id: postId, force } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PROMOTION_POST_PUBLISH_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PromotionPostPublishPrisma);
  const resolvePort = deps.resolvePort ?? defaultResolvePort;
  const decrypt = deps.decryptToken ?? ((enc: string) => decryptApiKey(enc));
  const buildMediaUrls = deps.buildMediaUrls ?? defaultBuildMediaUrls;
  const now = deps.now ?? (() => new Date());

  const post = await prisma.promotionPost.findUnique({
    where: { id: postId },
    select: { id: true, book_id: true, channel: true, account_id: true, title: true, body: true, status: true },
  });
  if (!post) {
    log.warn({ task: PROMOTION_POST_PUBLISH_TASK_NAME, postId }, 'post not found — skip');
    return { status: 'skipped', reason: 'not_found' };
  }
  if (post.status !== 'scheduled') {
    log.info({ task: PROMOTION_POST_PUBLISH_TASK_NAME, postId, status: post.status }, 'not scheduled — skip');
    return { status: 'skipped', reason: `status_${post.status}` };
  }

  const setting = await prisma.promotionChannelSetting.findUnique({
    where: { channel: post.channel },
    select: { auto_enabled: true, handle: true, token_enc: true, config_json: true },
  });
  if (!setting) {
    log.info({ task: PROMOTION_POST_PUBLISH_TASK_NAME, postId, channel: post.channel }, 'channel not configured — skip');
    return { status: 'skipped', reason: 'not_configured' };
  }
  // 自動ディスパッチ経路は auto_enabled 必須。手動 force はガードを無視 (接続は下で必要)。
  if (!setting.auto_enabled && !force) {
    log.info({ task: PROMOTION_POST_PUBLISH_TASK_NAME, postId, channel: post.channel }, 'channel auto disabled — skip');
    return { status: 'skipped', reason: 'auto_disabled' };
  }

  // scheduled → posting (二重投稿防止の CAS)
  const cas = await prisma.promotionPost.updateMany({
    where: { id: postId, status: 'scheduled' },
    data: { status: 'posting' },
  });
  if (cas.count === 0) {
    return { status: 'skipped', reason: 'already_taken' };
  }

  // P4 増分2: 投稿が台帳アカウントに紐づく場合、そのアカウントの資格情報で投稿する
  // （多アカウント routing）。接続済みでなければ投稿しない。null なら channel 既定設定を使う。
  let credSource: { handle: string | null; token_enc: string | null; config_json: unknown } = setting;
  if (post.account_id && prisma.promotionAccount) {
    const account = await prisma.promotionAccount.findUnique({
      where: { id: post.account_id },
      select: { status: true, handle: true, token_enc: true, config_json: true },
    });
    if (!account || account.status !== 'connected') {
      await prisma.promotionPost.update({
        where: { id: postId },
        data: { status: 'failed', error: 'routed account not connected'.slice(0, 500) },
      });
      log.info(
        { task: PROMOTION_POST_PUBLISH_TASK_NAME, postId, accountId: post.account_id },
        'routed account not connected — fail',
      );
      return { status: 'failed', reason: 'account_not_connected', message: 'routed account not connected' };
    }
    credSource = account;
  }

  let token: string | null = null;
  if (credSource.token_enc) {
    try {
      token = decrypt(credSource.token_enc);
    } catch (err) {
      log.warn({ task: PROMOTION_POST_PUBLISH_TASK_NAME, postId, err }, 'token decrypt failed');
      token = null;
    }
  }

  const config: PublishChannelConfig = {
    token,
    handle: credSource.handle,
    extra: (credSource.config_json as Record<string, unknown> | null) ?? {},
  };

  try {
    // F-058: IG/TikTok は画像/動画が必須。販促画像の署名 URL を用意する。
    let mediaUrls: string[] = [];
    try {
      mediaUrls = await buildMediaUrls(post.channel, post.book_id);
    } catch (err) {
      log.warn({ task: PROMOTION_POST_PUBLISH_TASK_NAME, postId, err }, 'media build failed — publishing without media');
    }

    const port = resolvePort(post.channel);
    const result = await port.publish({
      channel: post.channel as PromotionChannel,
      title: post.title,
      body: post.body,
      config,
      ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
    });

    if (result.ok) {
      await prisma.promotionPost.update({
        where: { id: postId },
        data: { status: 'posted', external_url: result.externalUrl, error: null, posted_at: now() },
      });
      log.info({ task: PROMOTION_POST_PUBLISH_TASK_NAME, postId, channel: post.channel }, 'post published');
      return { status: 'posted', externalUrl: result.externalUrl };
    }

    await prisma.promotionPost.update({
      where: { id: postId },
      data: { status: 'failed', error: `${result.reason}: ${result.message}`.slice(0, 500) },
    });
    log.warn(
      { task: PROMOTION_POST_PUBLISH_TASK_NAME, postId, channel: post.channel, reason: result.reason },
      'post publish failed',
    );
    return { status: 'failed', reason: result.reason, message: result.message };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await prisma.promotionPost.update({
      where: { id: postId },
      data: { status: 'failed', error: message.slice(0, 500) },
    });
    log.error({ task: PROMOTION_POST_PUBLISH_TASK_NAME, postId, err }, 'post publish threw');
    return { status: 'failed', reason: 'unknown', message };
  }
}

export const promotionPostPublishTask: Task = async (payload: unknown, _helpers: JobHelpers) => {
  await runPromotionPostPublish(payload);
};
