/**
 * F-052 — 販促チャンネル自動運用のコアロジック (DI 可能・SA から薄く呼ぶ)。
 *
 * - 自動運用トグル (auto_enabled) の更新
 * - 接続設定 (handle / webhook_url / access token) の保存 (token は暗号化)
 * - 手動「今すぐ投稿」/「取消」
 *
 * 実 IO (prisma / crypto / enqueue) はすべて deps 経由。副作用の無い純ロジックとして
 * 検証しやすくする。
 */
import { z } from 'zod';

import { fail, ok, type ActionResult } from '@a2p/contracts';
import { PromotionChannelSchema } from '@a2p/contracts/promotion/channels';

import { messages } from '@/lib/messages';

const m = messages.promotionChannels.actionMsg;

const PROMOTION_POST_PUBLISH_TASK = 'promotion.post.publish';

export interface ChannelSettingRow {
  channel: string;
  auto_enabled: boolean;
  handle: string | null;
  token_enc: string | null;
  token_mask: string | null;
  config_json: unknown;
}

export interface PromotionChannelsDeps {
  channelSettingRepo: {
    findUnique: (args: {
      where: { channel: string };
    }) => Promise<ChannelSettingRow | null>;
    upsert: (args: {
      where: { channel: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  postRepo: {
    findUnique: (args: {
      where: { id: string };
      select: { id: true; status: true; channel: true };
    }) => Promise<{ id: string; status: string; channel: string } | null>;
    updateMany: (args: {
      where: { id: string; status: { in: string[] } };
      data: { status: string; error?: string | null };
    }) => Promise<{ count: number }>;
  };
  auditLogRepo: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
  session: { user: { id: string } };
  enqueue: (task: string, payload: unknown) => Promise<void>;
  encrypt: (plain: string) => string;
  mask: (plain: string) => string;
  /** 接続テスト用: token_enc の復号 (action で注入)。 */
  decrypt?: (enc: string) => string;
  /** 接続テスト用: 非破壊の外部認証プローブ (action で注入)。 */
  probe?: (input: {
    channel: string;
    token: string | null;
    webhookUrl: string | null;
  }) => Promise<ChannelProbeResult>;
}

/** 接続テスト結果 (probe が返す判別結果を薄く再エクスポート)。 */
export interface ChannelProbeResult {
  ok: boolean;
  method: 'x_api' | 'webhook' | 'owned' | 'none';
  message: string;
  http_status?: number;
  latency_ms?: number;
  identity?: string | null;
}

// ---------------------------------------------------------------------------
// 自動運用トグル
// ---------------------------------------------------------------------------

const SetAutoSchema = z.object({
  channel: PromotionChannelSchema,
  auto_enabled: z.boolean(),
});

export async function setChannelAutoCore(
  input: unknown,
  deps: PromotionChannelsDeps,
): Promise<ActionResult<{ channel: string; auto_enabled: boolean }>> {
  const parsed = SetAutoSchema.safeParse(input);
  if (!parsed.success) return fail('validation', m.error);
  const { channel, auto_enabled } = parsed.data;

  await deps.channelSettingRepo.upsert({
    where: { channel },
    create: { channel, auto_enabled },
    update: { auto_enabled },
  });
  await deps.auditLogRepo.create({
    data: {
      actor_id: deps.session.user.id,
      action: 'promotion.channel.auto.update',
      target_kind: 'promotion_channel',
      target_id: channel,
      after_json: { auto_enabled },
    },
  });
  return ok({ channel, auto_enabled });
}

// ---------------------------------------------------------------------------
// 接続設定
// ---------------------------------------------------------------------------

const SetConnectionSchema = z.object({
  channel: PromotionChannelSchema,
  handle: z.string().max(200).optional(),
  webhook_url: z.string().url().max(500).optional().or(z.literal('')),
  /** 空文字は「変更なし」。新規トークンのときだけ暗号化して保存する。 */
  token: z.string().max(4000).optional(),
});

export async function setChannelConnectionCore(
  input: unknown,
  deps: PromotionChannelsDeps,
): Promise<ActionResult<{ channel: string; connected: boolean }>> {
  const parsed = SetConnectionSchema.safeParse(input);
  if (!parsed.success) return fail('validation', m.error);
  const { channel, handle, webhook_url, token } = parsed.data;

  const existing = await deps.channelSettingRepo.findUnique({ where: { channel } });

  const config = {
    ...((existing?.config_json as Record<string, unknown> | null) ?? {}),
    ...(webhook_url !== undefined ? { webhook_url: webhook_url || null } : {}),
  };

  const update: Record<string, unknown> = {
    handle: handle && handle.trim().length > 0 ? handle.trim() : null,
    config_json: config,
  };
  // 新規トークンが入力された場合のみ暗号化して更新する。
  if (token && token.trim().length > 0) {
    update.token_enc = deps.encrypt(token.trim());
    update.token_mask = deps.mask(token.trim());
  }

  await deps.channelSettingRepo.upsert({
    where: { channel },
    create: { channel, auto_enabled: false, ...update },
    update,
  });
  await deps.auditLogRepo.create({
    data: {
      actor_id: deps.session.user.id,
      action: 'promotion.channel.connection.update',
      target_kind: 'promotion_channel',
      target_id: channel,
      // token は監査ログに残さない。
      after_json: { handle: update.handle, webhook_url: config.webhook_url ?? null, token_updated: Boolean(update.token_enc) },
    },
  });

  const hasToken = Boolean(update.token_enc) || Boolean(existing?.token_enc);
  const hasWebhook = Boolean(config.webhook_url);
  return ok({ channel, connected: hasToken || hasWebhook });
}

// ---------------------------------------------------------------------------
// 接続テスト (非破壊) — 外部サービスの認証が通るかだけを確認する
// ---------------------------------------------------------------------------

const TestConnectionSchema = z.object({ channel: PromotionChannelSchema });

function readWebhookUrl(configJson: unknown): string | null {
  if (configJson && typeof configJson === 'object') {
    const v = (configJson as Record<string, unknown>).webhook_url;
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

export async function testChannelConnectionCore(
  input: unknown,
  deps: PromotionChannelsDeps,
): Promise<ActionResult<ChannelProbeResult>> {
  const parsed = TestConnectionSchema.safeParse(input);
  if (!parsed.success) return fail('validation', m.error);
  if (!deps.probe) return fail('unknown', m.error);
  const { channel } = parsed.data;

  const existing = await deps.channelSettingRepo.findUnique({ where: { channel } });

  let token: string | null = null;
  if (existing?.token_enc && deps.decrypt) {
    try {
      token = deps.decrypt(existing.token_enc);
    } catch {
      token = null;
    }
  }
  const webhookUrl = readWebhookUrl(existing?.config_json);

  const result = await deps.probe({ channel, token, webhookUrl });

  await deps.auditLogRepo.create({
    data: {
      actor_id: deps.session.user.id,
      action: 'promotion.channel.connection.test',
      target_kind: 'promotion_channel',
      target_id: channel,
      // token/handle は残さない。認証可否と手段のみ記録。
      after_json: { ok: result.ok, method: result.method, http_status: result.http_status ?? null },
    },
  });

  return ok(result);
}

// ---------------------------------------------------------------------------
// 今すぐ投稿 / 取消
// ---------------------------------------------------------------------------

const PostIdSchema = z.object({ post_id: z.string().min(1) });

export async function publishPostNowCore(
  input: unknown,
  deps: PromotionChannelsDeps,
): Promise<ActionResult<{ post_id: string }>> {
  const parsed = PostIdSchema.safeParse(input);
  if (!parsed.success) return fail('validation', m.error);
  const { post_id } = parsed.data;

  const post = await deps.postRepo.findUnique({
    where: { id: post_id },
    select: { id: true, status: true, channel: true },
  });
  if (!post) return fail('not_found', m.error);

  // failed/scheduled/draft を scheduled に戻してから force publish を投げる。
  const reset = await deps.postRepo.updateMany({
    where: { id: post_id, status: { in: ['scheduled', 'draft', 'failed'] } },
    data: { status: 'scheduled', error: null },
  });
  if (reset.count === 0) return fail('conflict', m.error);

  await deps.enqueue(PROMOTION_POST_PUBLISH_TASK, { post_id, force: true });
  return ok({ post_id });
}

export async function cancelPostCore(
  input: unknown,
  deps: PromotionChannelsDeps,
): Promise<ActionResult<{ post_id: string }>> {
  const parsed = PostIdSchema.safeParse(input);
  if (!parsed.success) return fail('validation', m.error);
  const { post_id } = parsed.data;

  const res = await deps.postRepo.updateMany({
    where: { id: post_id, status: { in: ['scheduled', 'draft', 'failed'] } },
    data: { status: 'canceled' },
  });
  if (res.count === 0) return fail('conflict', m.error);
  return ok({ post_id });
}
