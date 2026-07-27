/**
 * POST /api/line/webhook — LINE 双方向認証リレーの受信口 (KDP ログイン/OTP 中継)
 *
 * scripts/kdp-publish.mjs がログイン/OTP 待ちで `kdp_auth_requests` に pending 行を作り
 * LINE push で運営者に通知する。運営者が LINE アプリに 6 桁コードを返信すると、この
 * route が受信して pending 行に書き戻す (fulfilled)。ローカルツールはポーリングして拾う。
 *
 * - 認証は NextAuth セッションではなく LINE 署名 (`x-line-signature`) で行う
 *   (middleware.ts の matcher で `/api/line` を除外)。
 * - LINE は 200 以外を返すとリトライを繰り返すため、処理中の例外は握りつぶし常に 200 を返す。
 *
 * 純粋ロジックは lib/line-webhook-core.ts、署名検証/返信は lib/line-client.ts、
 * 本ファイルは route binding + DB 配線のみ。
 */
import { NextResponse } from 'next/server';
import { prisma } from '@a2p/db';

import { verifyLineSignature, replyLine } from '@/lib/line-client';
import { processLineEvents, type LineEvent } from '@/lib/line-webhook-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const allowedUserId = process.env.LINE_ALLOWED_USER_ID;

  if (!channelSecret || !accessToken || !allowedUserId) {
    return NextResponse.json({ error: 'line relay not configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-line-signature');
  if (!verifyLineSignature(channelSecret, rawBody, signature)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  try {
    const parsed = JSON.parse(rawBody) as { events?: LineEvent[] };
    await processLineEvents(parsed.events ?? [], {
      allowedUserId,
      now: new Date(),
      findPending: async () => {
        const row = await prisma.kdpAuthRequest.findFirst({
          where: { status: 'pending', expires_at: { gt: new Date() } },
          orderBy: { created_at: 'desc' },
          select: { id: true },
        });
        return row;
      },
      fulfill: async (id, code) => {
        await prisma.kdpAuthRequest.update({
          where: { id },
          data: { code, status: 'fulfilled', fulfilled_at: new Date() },
        });
      },
      reply: async (replyToken, message) => {
        await replyLine(accessToken, replyToken, message);
      },
    });
  } catch (err) {
    // LINE の再送ストームを避けるため、ここでは 200 を返し続ける。
    console.error('[api/line/webhook] processing failed', err);
  }

  return NextResponse.json({ ok: true });
}
