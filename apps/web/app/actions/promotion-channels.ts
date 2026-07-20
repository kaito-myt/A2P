'use server';

/**
 * F-052 — 販促チャンネル自動運用の Server Actions (薄いラッパ)。
 * 検証/暗号化/監査は `lib/promotion-channels-core.ts`。
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { decryptApiKey, encryptApiKey, maskApiKey } from '@a2p/crypto';
import { prisma } from '@a2p/db';

import { isPromotionChannel } from '@/lib/promotion-channels-view';
import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';
import { probeChannelAuth } from '@/lib/promotion-channel-probe';
import {
  cancelPostCore,
  publishPostNowCore,
  setChannelAutoCore,
  setChannelConnectionCore,
  testChannelConnectionCore,
  type PromotionChannelsDeps,
} from '@/lib/promotion-channels-core';

async function buildDeps(): Promise<PromotionChannelsDeps> {
  const session = await getSessionOrThrow();
  return {
    channelSettingRepo: prisma.promotionChannelSetting as unknown as PromotionChannelsDeps['channelSettingRepo'],
    postRepo: prisma.promotionPost as unknown as PromotionChannelsDeps['postRepo'],
    auditLogRepo: prisma.auditLog as unknown as PromotionChannelsDeps['auditLogRepo'],
    session,
    enqueue: async (task, payload) => {
      await enqueueJob(task, payload);
    },
    encrypt: (plain) => encryptApiKey(plain),
    mask: (plain) => maskApiKey(plain),
    decrypt: (enc) => decryptApiKey(enc),
    probe: (probeInput) => probeChannelAuth(probeInput),
  };
}

function authFail(err: unknown): ActionResult<never> {
  if (isA2PError(err)) return err.toActionResult();
  return fail('unknown', messages.promotionChannels.actionMsg.error);
}

function revalidateChannels() {
  for (const ch of ['x', 'instagram', 'tiktok', 'note', 'blog']) {
    revalidatePath(`/promotion/channel/${ch}`);
  }
}

export async function setChannelAuto(input: unknown) {
  let deps: PromotionChannelsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const res = await setChannelAutoCore(input, deps);
  if (res.ok) revalidateChannels();
  return res;
}

export async function setChannelConnection(input: unknown) {
  let deps: PromotionChannelsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const res = await setChannelConnectionCore(input, deps);
  if (res.ok) revalidateChannels();
  return res;
}

export async function testChannelConnection(input: unknown) {
  let deps: PromotionChannelsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  // 接続テストは副作用が無い (audit 記録のみ)。revalidate は不要。
  return testChannelConnectionCore(input, deps);
}

const PROMOTION_STRATEGY_GENERATE_TASK = 'promotion.strategy.generate';

/**
 * F-057 — SNS アカウント運用戦略の生成をキュー投入する。
 * worker(sns_strategist)が数分でプロファイル + アイコン/カバー画像を作り DB に保存する。
 */
export async function generateChannelStrategy(
  input: unknown,
): Promise<ActionResult<{ queued: true }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    return authFail(err);
  }
  const parsed = input as { channel?: unknown; instruction?: unknown };
  const channel = typeof parsed?.channel === 'string' ? parsed.channel : '';
  if (!isPromotionChannel(channel)) {
    return fail('validation', messages.promotionChannels.actionMsg.error);
  }
  const instruction =
    typeof parsed?.instruction === 'string' && parsed.instruction.trim().length > 0
      ? parsed.instruction.trim().slice(0, 2000)
      : undefined;
  try {
    await enqueueJob(PROMOTION_STRATEGY_GENERATE_TASK, {
      channel,
      ...(instruction ? { instruction } : {}),
    });
  } catch (err) {
    return authFail(err);
  }
  revalidatePath(`/promotion/channel/${channel}`);
  return { ok: true, data: { queued: true } };
}

const PROMOTION_CONTENT_GENERATE_TASK = 'promotion.content.generate';

/**
 * F-059 — 育成投稿(価値提供型)の生成をキュー投入する。
 * content_creator がアカウント戦略の発信の柱から価値投稿を作り、宣伝と混ぜて予約する。
 */
export async function generateChannelContent(
  input: unknown,
): Promise<ActionResult<{ queued: true }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    return authFail(err);
  }
  const parsed = input as { channel?: unknown };
  const channel = typeof parsed?.channel === 'string' ? parsed.channel : '';
  if (!isPromotionChannel(channel)) {
    return fail('validation', messages.promotionChannels.actionMsg.error);
  }
  try {
    await enqueueJob(PROMOTION_CONTENT_GENERATE_TASK, { channel });
  } catch (err) {
    return authFail(err);
  }
  revalidatePath(`/promotion/channel/${channel}`);
  return { ok: true, data: { queued: true } };
}

export async function publishPostNow(input: unknown) {
  let deps: PromotionChannelsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const res = await publishPostNowCore(input, deps);
  if (res.ok) revalidateChannels();
  return res;
}

export async function cancelPromotionPost(input: unknown) {
  let deps: PromotionChannelsDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    return authFail(err);
  }
  const res = await cancelPostCore(input, deps);
  if (res.ok) revalidateChannels();
  return res;
}
