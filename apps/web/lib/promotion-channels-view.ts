/**
 * F-052 — 販促チャンネル画面の表示用ヘルパ (RSC/クライアント共有の型と定数)。
 */
import { PROMOTION_CHANNELS, type PromotionChannel } from '@a2p/contracts/promotion/channels';

export { PROMOTION_CHANNELS };
export type { PromotionChannel };

export function isPromotionChannel(v: string): v is PromotionChannel {
  return (PROMOTION_CHANNELS as readonly string[]).includes(v);
}

/** 画面に渡す 1 投稿の serialized 形。 */
export interface ChannelPostRow {
  id: string;
  bookId: string;
  bookTitle: string;
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
}
