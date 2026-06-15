/**
 * GET /api/model-catalog/export.csv — モデル単価カタログ CSV エクスポート (T-02-10 / F-025).
 *
 * - `is_current=true` の全行を provider→model 順で取得し RFC 4180 CSV を返す
 * - 認証必須 (middleware.ts の matcher で除外していないので auth() を呼ぶ)
 * - ファイル名: `model-catalog-YYYY-MM-DD.csv` (UTC)
 * - UTF-8 BOM 付き (Excel 互換)
 *
 * CSV 生成本体は `lib/model-catalog-csv.ts` の純粋関数。
 */
import { NextResponse } from 'next/server';

import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import {
  buildCsvFilename,
  buildModelCatalogCsv,
  type ModelCatalogCsvRow,
} from '@/lib/model-catalog-csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  try {
    await getSessionOrThrow();
  } catch {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const rows = await prisma.modelCatalog.findMany({
    where: { is_current: true },
    orderBy: [{ provider: 'asc' }, { model: 'asc' }],
  });

  const csvRows: ModelCatalogCsvRow[] = rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    input_price_per_mtok_usd: r.input_price_per_mtok_usd.toString(),
    output_price_per_mtok_usd: r.output_price_per_mtok_usd.toString(),
    image_price_per_image_usd:
      r.image_price_per_image_usd != null ? r.image_price_per_image_usd.toString() : null,
    fx_rate_usd_jpy: r.fx_rate_usd_jpy.toString(),
    fetched_at: r.fetched_at,
    source: r.source,
  }));

  const body = buildModelCatalogCsv(csvRows);
  const filename = buildCsvFilename();

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
