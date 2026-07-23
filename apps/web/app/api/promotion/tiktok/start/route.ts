/**
 * GET /api/promotion/tiktok/start — TikTok OAuth 認可へリダイレクト (アプリ内接続フロー)。
 *
 * 保存済みの Client Key を使って authorize URL を組み立て、CSRF 用 state を httpOnly Cookie に
 * 保存して TikTok へ 302。戻りは /api/promotion/tiktok/callback。
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';

import { prisma } from '@a2p/db';
import { AuthError } from '@a2p/contracts';
import { encryptApiKey, decryptApiKey, maskApiKey } from '@a2p/crypto';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { getRequestOrigin, TIKTOK_CALLBACK_PATH } from '@/lib/request-origin';
import {
  TIKTOK_AUTHORIZE_URL,
  readTikTokCreds,
  tiktokScopes,
  type TikTokOAuthDeps,
} from '@/lib/tiktok-oauth-core';

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
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (err instanceof AuthError) return new NextResponse('Unauthorized', { status: 401 });
    throw err;
  }

  const channelUrl = '/promotion/channel/tiktok';
  const creds = await readTikTokCreds(deps);
  if (!creds?.clientKey) {
    return NextResponse.redirect(new URL(`${channelUrl}?tiktok=need_app_creds`, getRequestOrigin(request)), 302);
  }

  const origin = getRequestOrigin(request);
  const redirectUri = `${origin}${TIKTOK_CALLBACK_PATH}`;
  const state = randomUUID();

  const authorizeUrl = new URL(TIKTOK_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_key', creds.clientKey);
  authorizeUrl.searchParams.set('scope', tiktokScopes());
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);

  const jar = await cookies();
  jar.set('tiktok_oauth_state', state, {
    httpOnly: true,
    secure: origin.startsWith('https://'),
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });

  return NextResponse.redirect(authorizeUrl.toString(), 302);
}
