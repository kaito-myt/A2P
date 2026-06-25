/**
 * GET /api/covers/[id]/image — カバー画像の R2 署名付き URL リダイレクト。
 *
 * カバー画像は R2 (非公開バケット) に `books/{book_id}/covers/raw/{cover_id}.jpg`
 * (JPEG) として保存される。UI (チェックリストのサムネ / サムネ承認グリッド・比較ビュー) は
 * `<img src="/api/covers/{id}/image">` でこのルートを参照する。
 *
 * - 認証必須 (ブラウザの <img> リクエストは Cookie を伴うため middleware を通過する)
 * - Cover ID から r2_key を取得
 * - getSignedDownloadUrl で 15 分有効の署名付き URL を生成 (インライン表示なので
 *   attachment filename は付けない)
 * - 302 リダイレクト
 *
 * 注意: next/image の最適化経由 (/_next/image) はサーバー側 fetch で Cookie を
 * 持たず middleware に弾かれるため、本ルートを参照する <Image> は `unoptimized`
 * もしくは素の <img> を用いること。
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
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (err instanceof AuthError) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
    throw err;
  }

  const { id } = await params;

  const cover = await prisma.cover.findUnique({
    where: { id },
    select: { r2_key: true },
  });

  if (!cover) {
    return new NextResponse('Not Found', { status: 404 });
  }

  const signedUrl = await getSignedDownloadUrl(cover.r2_key, 900);

  return NextResponse.redirect(signedUrl, 302);
}
