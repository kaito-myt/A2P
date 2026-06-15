/**
 * GET /api/comments/counts -- pending + must comment counts (T-06-12).
 *
 * Header CommentBadge polls this endpoint every 30s.
 * Returns { pending: number, must: number }.
 */
import { NextResponse } from 'next/server';

import { prisma } from '@a2p/db';
import { AuthError } from '@a2p/contracts';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { getCommentCounts } from '@/lib/comment-counts-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (err instanceof AuthError) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
    throw err;
  }

  const counts = await getCommentCounts(prisma);

  return NextResponse.json(counts);
}
