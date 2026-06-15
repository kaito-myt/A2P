/**
 * GET /api/artifacts/[id]/download -- R2 署名付き URL リダイレクト (T-05-11 / docs/05 §4.2).
 *
 * - 認証必須
 * - Artifact ID から r2_key を取得
 * - getSignedDownloadUrl で 15 分有効の署名付き URL を生成
 * - 302 リダイレクト
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

  const artifact = await prisma.artifact.findUnique({
    where: { id },
    select: { r2_key: true, kind: true },
  });

  if (!artifact) {
    return new NextResponse('Not Found', { status: 404 });
  }

  const signedUrl = await getSignedDownloadUrl(artifact.r2_key);

  return NextResponse.redirect(signedUrl, 302);
}
