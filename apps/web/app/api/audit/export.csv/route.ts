/**
 * GET /api/audit/export.csv — 監査ログ CSV エクスポート (T-09-03 / S-029).
 *
 * - 直近 1 年の audit_log 全行を日付順で取得し RFC 4180 CSV を返す
 * - searchParams フィルタ: actor / action / targetKind / period / q
 * - 認証必須
 * - ファイル名: `audit-log-YYYY-MM-DD.csv`
 * - UTF-8 BOM 付き (Excel 互換)
 *
 * NOTE: before_json / after_json は表示するだけ（格納済みの値を返す）。
 * api_credential エントリはすでにマスク/サニタイズ済みであり、
 * このルートはシークレットの追加抽出を行わない (CLAUDE.md hard rule)。
 */
import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import {
  buildAuditCsv,
  buildAuditCsvFilename,
  buildBeforeAfterSummary,
  type AuditCsvRow,
} from '@/lib/audit-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 1000;

function periodToDate(period: string | null): Date {
  const now = new Date();
  switch (period) {
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case '90d':
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    case 'all':
      return new Date(0);
    default: // 1y
      return new Date(now.getTime() - ONE_YEAR_MS);
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await getSessionOrThrow();
  } catch {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const actor = sp.get('actor') ?? 'all';
  const action = sp.get('action') ?? 'all';
  const targetKind = sp.get('targetKind') ?? 'all';
  const period = sp.get('period') ?? '1y';
  const q = sp.get('q') ?? '';

  const since = periodToDate(period);

  const where: Record<string, unknown> = {
    created_at: { gte: since },
  };

  if (action !== 'all') {
    where.action = action;
  }
  if (targetKind !== 'all') {
    where.target_kind = targetKind;
  }
  if (actor === 'system') {
    where.actor_id = null;
  } else if (actor === 'operator') {
    where.actor_id = { not: null };
  }
  if (q) {
    where.OR = [
      { action: { contains: q, mode: 'insensitive' } },
      { target_id: { contains: q, mode: 'insensitive' } },
      { target_kind: { contains: q, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.auditLog.findMany({
    where,
    select: {
      id: true,
      actor_id: true,
      actor: { select: { username: true } },
      action: true,
      target_kind: true,
      target_id: true,
      before_json: true,
      after_json: true,
      created_at: true,
    },
    orderBy: { created_at: 'desc' },
    take: MAX_ROWS,
  });

  const csvRows: AuditCsvRow[] = rows.map((r) => ({
    created_at: r.created_at.toISOString(),
    actor: r.actor?.username ?? r.actor_id ?? 'system',
    action: r.action,
    target_kind: r.target_kind,
    target_id: r.target_id,
    summary: buildBeforeAfterSummary(r.before_json, r.after_json, r.action),
  }));

  const body = buildAuditCsv(csvRows);
  const filename = buildAuditCsvFilename();

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
