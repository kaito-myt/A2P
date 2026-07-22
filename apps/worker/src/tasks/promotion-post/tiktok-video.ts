/**
 * F-060/F-063 — TikTok 投稿用の動画を「必要になった時点で」レンダリングして R2 に保存し、
 * post に media_key を付ける（投稿時オンデマンド生成）。
 *
 * promotion.video.generate と同じパイプライン（多エージェント台本 → 画像+テロップ+TTS+ffmpeg）を
 * 使うが、こちらは「既存の予定 TikTok 投稿に動画が無い場合」に publish 直前で 1 本作るための
 * 再利用関数。重い処理なので失敗時は呼び出し側が画像にフォールバックする。
 */
import { createTikTokVideoScript as defaultCreateScript } from '@a2p/agents';
import { AccountStrategyProfileSchema, type TikTokVideoInput, type VideoScript } from '@a2p/contracts/agents';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { promotionPostVideo } from '@a2p/storage/keys';

import { renderSlideVideo, type RenderVideoDeps } from './video-render.js';

interface TikTokVideoPrisma {
  promotionChannelSetting: {
    findUnique: (args: { where: { channel: string }; select: { strategy_json: true } }) => Promise<{ strategy_json: unknown } | null>;
  };
  book: {
    findMany: (args: { select: { title: true }; take?: number }) => Promise<Array<{ title: string }>>;
    findUnique: (args: {
      where: { id: string };
      select: { title: true; asin: true; theme: { select: { hook: true } } };
    }) => Promise<{ title: string; asin: string | null; theme: { hook: string | null } | null } | null>;
  };
  promotionPost: {
    update: (args: { where: { id: string }; data: { media_key: string } }) => Promise<unknown>;
  };
}

export interface EnsureTikTokVideoDeps {
  prisma?: TikTokVideoPrisma;
  logger?: Logger;
  createScript?: (input: TikTokVideoInput) => Promise<VideoScript>;
  renderVideo?: (script: VideoScript) => Promise<Buffer>;
  renderDeps?: RenderVideoDeps;
  uploadBuffer?: (key: string, buffer: Buffer, contentType: string) => Promise<{ key: string }>;
}

async function defaultPrisma(): Promise<TikTokVideoPrisma> {
  const mod = await import('@a2p/db');
  return mod.prisma as unknown as TikTokVideoPrisma;
}
async function defaultUploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<{ key: string }> {
  const mod = await import('@a2p/storage/operations');
  return mod.uploadBuffer(key, buffer, contentType);
}

/**
 * 予定 TikTok 投稿に動画が無ければ 1 本レンダリングして media_key を保存し、そのキーを返す。
 * 生成不可（戦略無し等）や失敗時は null（呼び出し側は画像にフォールバック）。
 */
export async function ensureTikTokVideoForPost(
  postId: string,
  bookId: string | null,
  deps: EnsureTikTokVideoDeps = {},
): Promise<string | null> {
  const log = deps.logger ?? createLogger('worker.promotion.tiktok-video');
  const prisma = deps.prisma ?? (await defaultPrisma());
  const createScript = deps.createScript ?? ((input: TikTokVideoInput) => defaultCreateScript(input));
  const renderVideo =
    deps.renderVideo ?? (async (script: VideoScript) => (await renderSlideVideo(script.scenes, deps.renderDeps)).video);
  const uploadBuffer = deps.uploadBuffer ?? defaultUploadBuffer;

  const setting = await prisma.promotionChannelSetting.findUnique({
    where: { channel: 'tiktok' },
    select: { strategy_json: true },
  });
  const profile = setting?.strategy_json ? AccountStrategyProfileSchema.safeParse(setting.strategy_json) : null;
  const concept = profile?.success ? profile.data.concept : '';
  const tone = profile?.success ? profile.data.tone_of_voice : '';
  const coreTags = profile?.success ? profile.data.hashtag_strategy.core : [];
  const pillarTopic =
    profile?.success && profile.data.content_pillars[0] ? profile.data.content_pillars[0].name : '今日の一言';

  const books = await prisma.book.findMany({ select: { title: true }, take: 15 });
  const sampleTitles = books.map((b) => b.title);

  let bookInput: TikTokVideoInput['book'] | undefined;
  if (bookId) {
    const b = await prisma.book.findUnique({
      where: { id: bookId },
      select: { title: true, asin: true, theme: { select: { hook: true } } },
    });
    if (b) bookInput = { title: b.title, ...(b.theme?.hook ? { hook: b.theme.hook } : {}), asin: b.asin };
  }

  try {
    const script = await createScript({
      channel: 'tiktok',
      concept,
      tone_of_voice: tone,
      topic: pillarTopic,
      sample_titles: sampleTitles,
      ...(bookInput ? { book: bookInput } : {}),
      core_hashtags: coreTags,
      target_seconds: 30,
    });
    const video = await renderVideo(script);
    const mediaKey = promotionPostVideo(postId);
    await uploadBuffer(mediaKey, video, 'video/mp4');
    await prisma.promotionPost.update({ where: { id: postId }, data: { media_key: mediaKey } });
    log.info({ postId, scenes: script.scenes.length }, 'on-demand tiktok video rendered');
    return mediaKey;
  } catch (err) {
    log.warn({ postId, err }, 'on-demand tiktok video render failed — caller falls back to image');
    return null;
  }
}
