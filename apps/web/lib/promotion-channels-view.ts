/**
 * F-052 — 販促チャンネル画面の表示用ヘルパ (RSC/クライアント共有の型と定数)。
 */
import { PROMOTION_CHANNELS, type PromotionChannel } from '@a2p/contracts/promotion/channels';
import {
  AccountStrategyProfileSchema,
  type AccountStrategyProfile,
} from '@a2p/contracts/agents/sns-strategist';

export { PROMOTION_CHANNELS };
export type { PromotionChannel, AccountStrategyProfile };

export function isPromotionChannel(v: string): v is PromotionChannel {
  return (PROMOTION_CHANNELS as readonly string[]).includes(v);
}

/** 画面に渡す 1 投稿の serialized 形。 */
export interface ChannelPostRow {
  id: string;
  bookId: string | null;
  bookTitle: string;
  /** F-059: promo=宣伝 | value=育成(価値提供)。 */
  kind: string;
  title: string | null;
  body: string;
  status: string;
  scheduledFor: string | null;
  postedAt: string | null;
  externalUrl: string | null;
  error: string | null;
}

/** 画面に渡すチャンネル設定の serialized 形。 */
export interface ChannelSettingView {
  channel: PromotionChannel;
  autoEnabled: boolean;
  handle: string | null;
  webhookUrl: string | null;
  tokenMask: string | null;
  connected: boolean;
  /** F-058: IG/TikTok は Ayrshare 経由で投稿する（API キーが設定済みか）。 */
  ayrshareManaged?: boolean;
}

/** F-057 — SNS アカウント運用戦略の serialized 形。 */
export interface ChannelStrategyView {
  displayName: string | null;
  updatedAt: string | null;
  hasAvatar: boolean;
  hasBanner: boolean;
  /** 生成済みプロファイル。未生成なら null。 */
  profile: AccountStrategyProfile | null;
}

/**
 * DB の strategy_json (unknown) を安全に AccountStrategyProfile へ。壊れていれば null。
 */
export function parseStrategyProfile(raw: unknown): AccountStrategyProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const res = AccountStrategyProfileSchema.safeParse(raw);
  return res.success ? res.data : null;
}
