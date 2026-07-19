import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  planSnsStrategy as defaultPlanSnsStrategy,
  generateStrategyImages as defaultGenerateStrategyImages,
  generateImage as defaultGenerateImage,
  withImageLogging,
  type GenerateImageFn,
  type StrategyImages,
} from '@a2p/agents';
import {
  PromotionChannelSchema,
  type PromotionChannel,
} from '@a2p/contracts/promotion/channels';
import type {
  AccountStrategyProfile,
  SnsStrategistInput,
} from '@a2p/contracts/agents/sns-strategist';
import { ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';
import { channelAvatar, channelBanner } from '@a2p/storage/keys';

/**
 * `promotion.strategy.generate` タスク (F-057)
 *
 * 接続済みチャンネル 1 つに対して SNS アカウント運用プロファイル（表示名/bio/発信軸/
 * トーン/投稿頻度/ハッシュタグ/グロース戦術/アイコン・カバー画像プロンプト）を
 * sns_strategist エージェントで設計し、アイコン/カバー画像を gpt-image-1 で生成、
 * R2 に保存して `promotion_channel_settings` に永続化する。
 *
 * 実投稿はしない（アカウントの土台を作るだけ）。運営者は UI で確認し、表示名/bio/画像を
 * 各 SNS のプロフィールに適用する。生成したハッシュタグ方針は以降の投稿生成に反映される。
 */

export const PROMOTION_STRATEGY_GENERATE_TASK_NAME = 'promotion.strategy.generate';

export const PromotionStrategyGeneratePayloadSchema = z.object({
  channel: PromotionChannelSchema,
  /** 運営者からの追加指示（任意）。 */
  instruction: z.string().max(2000).optional(),
});
export type PromotionStrategyGeneratePayload = z.infer<
  typeof PromotionStrategyGeneratePayloadSchema
>;

interface StrategyGeneratePrisma {
  promotionChannelSetting: {
    findUnique: (args: {
      where: { channel: string };
      select: { handle: true };
    }) => Promise<{ handle: string | null } | null>;
    upsert: (args: {
      where: { channel: string };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  book: {
    findMany: (args: {
      select: { title: true; theme: { select: { genre: true; target_reader: true } } };
    }) => Promise<Array<{ title: string; theme: { genre: string; target_reader: string | null } | null }>>;
  };
}

interface UploadBufferFn {
  (key: string, buffer: Buffer, contentType: string): Promise<{ key: string }>;
}

export interface PromotionStrategyGenerateDeps {
  prisma?: StrategyGeneratePrisma;
  logger?: Logger;
  now?: () => Date;
  planSnsStrategy?: (input: SnsStrategistInput) => Promise<AccountStrategyProfile>;
  generateStrategyImages?: (
    profile: Pick<AccountStrategyProfile, 'avatar_prompt' | 'banner_prompt'>,
    deps: { generateImage?: GenerateImageFn },
  ) => Promise<StrategyImages>;
  /** 画像生成関数（既定は withImageLogging(generateImage)）。テスト差し替え用。 */
  generateImage?: GenerateImageFn;
  uploadBuffer?: UploadBufferFn;
}

export interface PromotionStrategyGenerateResult {
  channel: PromotionChannel;
  display_name: string;
  avatar_key: string;
  banner_key: string;
}

async function defaultUploadBuffer(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ key: string }> {
  const mod = await import('@a2p/storage/operations');
  return mod.uploadBuffer(key, buffer, contentType);
}

const MAX_SAMPLE_TITLES = 15;

export async function runPromotionStrategyGenerate(
  payload: unknown,
  deps: PromotionStrategyGenerateDeps = {},
): Promise<PromotionStrategyGenerateResult> {
  const parsed = PromotionStrategyGeneratePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('promotion.strategy.generate payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const channel = parsed.data.channel;

  const log = deps.logger ?? createLogger(`worker.${PROMOTION_STRATEGY_GENERATE_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as StrategyGeneratePrisma);
  const now = deps.now ?? (() => new Date());
  const plan = deps.planSnsStrategy ?? ((input: SnsStrategistInput) => defaultPlanSnsStrategy(input));
  const genImages = deps.generateStrategyImages ?? defaultGenerateStrategyImages;
  const uploadBuffer = deps.uploadBuffer ?? defaultUploadBuffer;

  // 画像生成はコスト記録（token_usage, role='sns_strategist'）付きで実行。
  const imageFn: GenerateImageFn =
    deps.generateImage ??
    withImageLogging(defaultGenerateImage, {
      themeSessionId: `strategy:${channel}`,
      role: 'sns_strategist',
    });

  // 1. 既存ハンドル + 在庫カタログを集約
  const settingRow = await prisma.promotionChannelSetting.findUnique({
    where: { channel },
    select: { handle: true },
  });
  const books = await prisma.book.findMany({
    select: { title: true, theme: { select: { genre: true, target_reader: true } } },
  });
  const inventory: Record<string, number> = {};
  const readerSet = new Set<string>();
  const titles: string[] = [];
  for (const b of books) {
    const g = b.theme?.genre ?? '未分類';
    inventory[g] = (inventory[g] ?? 0) + 1;
    if (b.theme?.target_reader) readerSet.add(b.theme.target_reader.slice(0, 120));
    if (titles.length < MAX_SAMPLE_TITLES && b.title) titles.push(b.title);
  }

  const input: SnsStrategistInput = {
    channel,
    current_handle: settingRow?.handle ?? null,
    catalog: {
      genre_inventory: inventory,
      sample_titles: titles,
      target_readers: [...readerSet],
    },
    ...(parsed.data.instruction ? { instruction: parsed.data.instruction } : {}),
  };

  // 2. 戦略プロファイル生成（LLM）
  const profile = await plan(input);

  // 3. アイコン/カバー画像生成 + R2 保存
  const images = await genImages(profile, { generateImage: imageFn });
  const avatarKey = channelAvatar(channel);
  const bannerKey = channelBanner(channel);
  await uploadBuffer(avatarKey, images.avatar, 'image/png');
  await uploadBuffer(bannerKey, images.banner, 'image/png');

  // 4. 永続化
  const strategyData = {
    display_name: profile.display_name,
    strategy_json: profile as unknown as Record<string, unknown>,
    avatar_key: avatarKey,
    banner_key: bannerKey,
    strategy_updated_at: now(),
  };
  await prisma.promotionChannelSetting.upsert({
    where: { channel },
    update: strategyData,
    create: { channel, ...strategyData },
  });

  log.info(
    { task: PROMOTION_STRATEGY_GENERATE_TASK_NAME, channel, display_name: profile.display_name },
    'sns strategy generated',
  );
  return {
    channel,
    display_name: profile.display_name,
    avatar_key: avatarKey,
    banner_key: bannerKey,
  };
}

export const promotionStrategyGenerateTask: Task = async (payload: unknown, _helpers: JobHelpers) => {
  await runPromotionStrategyGenerate(payload);
};
