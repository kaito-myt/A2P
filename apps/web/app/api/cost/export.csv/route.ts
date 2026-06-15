/**
 * GET /api/cost/export.csv — コスト詳細 CSV エクスポート (T-07-05 / S-024).
 *
 * - 当月の token_usage 全行を日付順で取得し RFC 4180 CSV を返す
 * - 認証必須
 * - ファイル名: `cost-detail-YYYY-MM.csv`
 * - UTF-8 BOM 付き (Excel 互換)
 */
import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import {
  buildCostCsv,
  buildCostCsvFilename,
  type CostCsvRow,
} from '@/lib/cost-dashboard-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await getSessionOrThrow();
  } catch {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const now = new Date();
  const year = parseInt(searchParams.get('year') ?? String(now.getFullYear()), 10);
  const month = parseInt(searchParams.get('month') ?? String(now.getMonth() + 1), 10);

  if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  const rows = await prisma.tokenUsage.findMany({
    where: {
      created_at: { gte: start, lt: end },
    },
    orderBy: { created_at: 'asc' },
    select: {
      provider: true,
      model: true,
      role: true,
      input_tokens: true,
      output_tokens: true,
      cached_input_tokens: true,
      image_count: true,
      cost_jpy: true,
      created_at: true,
    },
  });

  const csvRows: CostCsvRow[] = rows.map((r) => ({
    date: r.created_at.toISOString().slice(0, 10),
    provider: r.provider,
    model: r.model,
    role: r.role,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cached_input_tokens: r.cached_input_tokens,
    image_count: r.image_count,
    cost_jpy: Number(r.cost_jpy),
  }));

  const body = buildCostCsv(csvRows);
  const filename = buildCostCsvFilename(year, month);

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
