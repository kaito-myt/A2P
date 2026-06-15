/**
 * GET /api/sales/record — 既存売上レコード取得 (T-08-06, F-037).
 *
 * ?book_id=xxx&year_month=YYYY-MM
 *
 * 書籍+年月で既存レコードを 1 件取得。存在しない場合 { data: null }。
 * SalesInputForm のプリフィルに使用。
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

  const sp = request.nextUrl.searchParams;
  const book_id = sp.get('book_id') ?? '';
  const year_month = sp.get('year_month') ?? '';

  if (!book_id || !year_month || !/^\d{4}-\d{2}$/.test(year_month)) {
    return NextResponse.json({ data: null }, { status: 200 });
  }

  const record = await prisma.salesRecord.findUnique({
    where: {
      book_id_year_month: { book_id, year_month },
    },
    select: {
      royalty_jpy: true,
      review_count: true,
      avg_stars: true,
      bsr: true,
    },
  });

  if (!record) {
    return NextResponse.json({ data: null });
  }

  return NextResponse.json({
    data: {
      royalty_jpy: record.royalty_jpy,
      review_count: record.review_count,
      avg_stars: record.avg_stars != null ? Number(record.avg_stars) : null,
      bsr: record.bsr ?? null,
    },
  });
}
