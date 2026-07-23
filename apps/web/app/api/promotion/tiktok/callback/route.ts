/**
 * GET /api/promotion/tiktok/callback — TikTok OAuth のリダイレクト受け口。
 *
 * `code`/`state` を受け取り、state Cookie と照合 (CSRF)。一致すれば authorization_code を
 * access/refresh token に交換し、フル資格情報を暗号化保存 → チャンネルページへ戻す。
 * redirect_uri は start と同一オリジンから導出して完全一致させる。
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { prisma } from '@a2p/db';
import { AuthError } from '@a2p/contracts';
import { encryptApiKey, decryptApiKey, maskApiKey } from '@a2p/crypto';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { getRequestOrigin, TIKTOK_CALLBACK_PATH } from '@/lib/request-origin';
import { exchangeTikTokCode, type TikTokOAuthDeps } from '@/lib/tiktok-oauth-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps: TikTokOAuthDeps = {
  channelSettingRepo: {
    findUnique: (a) => prisma.promotionChannelSetting.findUnique(a as never),
    upsert: (a) => prisma.promotionChannelSetting.upsert(a as never),
  },
  encrypt: encryptApiKey,
  decrypt: decryptApiKey,
  mask: maskApiKey,
};

export async function GET(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = (await getSessionOrThrow()).user.id;
  } catch (err) {
    if (err instanceof AuthError) return new NextResponse('Unauthorized', { status: 401 });
    throw err;
  }

  const origin = getRequestOrigin(request);
  const channelUrl = (q: string): URL => new URL(`/promotion/channel/tiktok?${q}`, origin);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthErr = url.searchParams.get('error');

  const jar = await cookies();
  const expectedState = jar.get('tiktok_oauth_state')?.value ?? null;
  jar.delete('tiktok_oauth_state');

  if (oauthErr) {
    return NextResponse.redirect(channelUrl(`tiktok=error&reason=${encodeURIComponent(oauthErr)}`), 302);
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(channelUrl('tiktok=error&reason=state_mismatch'), 302);
  }

  const redirectUri = `${origin}${TIKTOK_CALLBACK_PATH}`;
  const result = await exchangeTikTokCode({ code, redirectUri }, deps);

  await prisma.auditLog.create({
    data: {
      actor_id: userId,
      action: 'promotion.channel.tiktok.oauth',
      target_kind: 'promotion_channel',
      target_id: 'tiktok',
      after_json: { ok: result.ok },
    },
  });

  if (!result.ok) {
    return NextResponse.redirect(channelUrl(`tiktok=error&reason=${encodeURIComponent(result.error.slice(0, 120))}`), 302);
  }
  return NextResponse.redirect(channelUrl('tiktok=connected'), 302);
}
