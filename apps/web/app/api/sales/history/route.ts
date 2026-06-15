/**
 * GET /api/sales/history — 書籍の過去 6 ヶ月売上履歴 (T-08-06, F-037).
 *
 * ?book_id=xxx
 *
 * 選択書籍の直近 6 ヶ月レコードを返す。SalesHistoryTable のデータソース。
 */
import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await getSessionOrThrow();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const book_id = request.nextUrl.searchParams.get('book_id') ?? '';
  if (!book_id) {
    return NextResponse.json({ data: { book_title: '', rows: [] } });
  }

  const book = await prisma.book.findUnique({
    where: { id: book_id },
    select: { title: true },
  });

  if (!book) {
    return NextResponse.json({ data: { book_title: '', rows: [] } });
  }

  const records = await prisma.salesRecord.findMany({
    where: { book_id },
    orderBy: { year_month: 'desc' },
    take: 6,
    select: {
      year_month: true,
      royalty_jpy: true,
      review_count: true,
      avg_stars: true,
    },
  });

  return NextResponse.json({
    data: {
      book_title: book.title,
      rows: records.map((r) => ({
        year_month: r.year_month,
        royalty_jpy: r.royalty_jpy,
        review_count: r.review_count,
        avg_stars: r.avg_stars != null ? Number(r.avg_stars) : null,
      })),
    },
  });
}
