/**
 * F-052 — 販促投稿の外部 IO 境界 (PublisherPort)。
 *
 * sales-fetch の BrowserPort と同じ DI 方式: 契約とスタブは本ファイル (副作用なし)、
 * 実 HTTP 実装は `http-publisher-port.ts` に隔離する。worker タスクは PublisherPort に
 * しか依存しないため、実 API に触れずテストできる。
 */
import type { PromotionChannel } from '@a2p/contracts/promotion/channels';

/** 1 投稿分の入力。 */
export interface PublishInput {
  channel: PromotionChannel;
  /** note/blog の見出し (SNS は null)。 */
  title: string | null;
  /** 投稿本文。 */
  body: string;
  /** チャンネル設定 (認証トークン・webhook 等)。未接続なら token=null。 */
  config: PublishChannelConfig;
  /**
   * 添付メディアの公開 URL (F-058)。Instagram/TikTok は画像/動画が必須のため、
   * publish タスクが生成済み販促画像の署名付き URL を入れて渡す。
   */
  mediaUrls?: string[];
}

/** 復号済みチャンネル設定 (worker タスクが settings + token_enc を復号して渡す)。 */
export interface PublishChannelConfig {
  /** アクセストークン (復号済)。未接続なら null。 */
  token: string | null;
  /** 表示ハンドル/ユーザ名。 */
  handle: string | null;
  /** チャンネル固有設定 (例: { webhook_url, api_base })。 */
  extra: Record<string, unknown>;
}

/** 投稿結果 (判別可能ユニオン)。 */
export type PublishResult =
  | { ok: true; externalUrl: string | null }
  | { ok: false; reason: PublishFailureReason; message: string };

export type PublishFailureReason =
  | 'not_connected' // 認証情報未設定
  | 'auth' // 認証エラー
  | 'rate_limit'
  | 'invalid' // 本文が長すぎる等
  | 'unknown';

/** チャンネルへ 1 投稿する。 */
export interface PublisherPort {
  publish(input: PublishInput): Promise<PublishResult>;
}

/**
 * スタブ実装: 実投稿せず常に成功を返す (fixture URL)。
 * `PROMOTION_PUBLISHER=stub` および単体テストで使用。
 */
export function createStubPublisherPort(
  externalUrl: string | null = 'https://example.test/stub-post',
): PublisherPort {
  return {
    async publish(): Promise<PublishResult> {
      return { ok: true, externalUrl };
    },
  };
}

/**
 * 未接続チャンネル用の no-op ポート: 常に not_connected を返す。
 * 認証トークンが無いチャンネルにはこれを割り当てて誤爆を防ぐ。
 */
export function createNotConnectedPublisherPort(): PublisherPort {
  return {
    async publish(input: PublishInput): Promise<PublishResult> {
      return {
        ok: false,
        reason: 'not_connected',
        message: `channel ${input.channel} has no credentials configured`,
      };
    },
  };
}
