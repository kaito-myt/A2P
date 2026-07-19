/**
 * GET /api/promotion/[channel]/[kind] — SNS アカウントのアイコン/カバー画像 (F-057)。
 *
 * kind = 'avatar' | 'banner'。promotion_channel_settings の avatar_key / banner_key を
 * R2 署名付き URL (15分) にして 302 リダイレクトする。UI は `<img src>` で参照。
 * 認証必須 (ブラウザの <img> は Cookie を伴い middleware を通過する)。
 */
import { NextResponse } from 'next/server';

import { prisma } from '@a2p/db';
import { AuthError } from '@a2p/contracts';
import { getSignedDownloadUrl } from '@a2p/storage';

import { getSessionOrThrow } from '@/lib/auth-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ channel: string; kind: string }> },
): Promise<Response> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (err instanceof AuthError) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
    throw err;
  }

  const { channel, kind } = await params;
  if (kind !== 'avatar' && kind !== 'banner') {
    return new NextResponse('Not Found', { status: 404 });
  }

  const setting = await prisma.promotionChannelSetting.findUnique({
    where: { channel },
    select: { avatar_key: true, banner_key: true },
  });
  const key = kind === 'avatar' ? setting?.avatar_key : setting?.banner_key;
  if (!key) {
    return new NextResponse('Not Found', { status: 404 });
  }

  const signedUrl = await getSignedDownloadUrl(key, 900);
  return NextResponse.redirect(signedUrl, 302);
}
