'use server';

/**
 * F-052 — 販促チャンネル自動運用の Server Actions (薄いラッパ)。
 * 検証/暗号化/監査は `lib/promotion-channels-core.ts`。
 */
import { revalidatePath } from 'next/cache';

import { isA2PError, fail, type ActionResult } from '@a2p/contracts';
import { decryptApiKey, encryptApiKey, maskApiKey } from '@a2p/crypto';
import { prisma } from '@a2p/db';

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
