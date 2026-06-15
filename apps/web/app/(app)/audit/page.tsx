/**
 * S-029 監査ログ (T-09-03, F-029/F-030/F-046).
 *
 * RSC page: 直近 1,000 件の監査ログを取得し、フィルタ・テーブル・JSON diff を表示。
 * searchParams で actor / action / targetKind / period / q をフィルタ。
 * 読み取り専用 — CTA なし。
 *
 * 仕様根拠: docs/04 S-029 / docs/05 §3 AuditLog / SP-09 T-09-03
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { serializeAuditLog, type AuditLogRawRow } from '@/lib/audit-view';
import { AuditPageShell } from '@/components/audit/audit-page-shell';

export const metadata: Metadata = {
  title: `${messages.audit.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.audit;
const MAX_ROWS = 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function sp(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

function periodToDate(period: string): Date {
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

export default async function AuditLogPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const currentActor = sp(params, 'actor') ?? 'all';
  const currentAction = sp(params, 'action') ?? 'all';
  const currentTargetKind = sp(params, 'targetKind') ?? 'all';
  const currentPeriod = sp(params, 'period') ?? '1y';
  const currentSearch = sp(params, 'q') ?? '';

  const since = periodToDate(currentPeriod);

  // Build filter where clause — all actor filtering done in DB, before take/limit.
  // operator = actor_id IS NOT NULL (stored as User.id cuid)
  // system   = actor_id IS NULL     (cron / background tasks)
  const where: Record<string, unknown> = {
    created_at: { gte: since },
  };

  if (currentAction !== 'all') {
    where.action = currentAction;
  }
  if (currentTargetKind !== 'all') {
    where.target_kind = currentTargetKind;
  }
  if (currentActor === 'system') {
    where.actor_id = null;
  } else if (currentActor === 'operator') {
    where.actor_id = { not: null };
  }
  if (currentSearch) {
    where.OR = [
      { action: { contains: currentSearch, mode: 'insensitive' } },
      { target_id: { contains: currentSearch, mode: 'insensitive' } },
      { target_kind: { contains: currentSearch, mode: 'insensitive' } },
    ];
  }

  const [rawLogs, totalCount] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      select: {
        id: true,
        actor_id: true,
        actor: { select: { id: true, username: true } },
        action: true,
        target_kind: true,
        target_id: true,
        before_json: true,
        after_json: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: MAX_ROWS,
    }),
    // count uses the SAME where as findMany so totalCount reflects all active filters
    prisma.auditLog.count({ where }),
  ]);

  const rows = rawLogs.map((r) => serializeAuditLog(r as unknown as AuditLogRawRow));

  // Gather distinct actions and target_kinds for filter dropdowns (from fetched rows)
  const distinctActions = [...new Set(rows.map((r) => r.action))].sort();
  const distinctTargetKinds = [...new Set(rows.map((r) => r.target_kind))].sort();

  return (
    <div className="flex flex-col gap-space-loose" data-testid="audit-page">
      {/* Page header */}
      <header className="flex items-start justify-between gap-space-snug">
        <div className="flex flex-col gap-space-snug">
          <nav aria-label="breadcrumb" className="text-button-sm text-muted">
            <Link href="/dashboard" className="no-underline hover:underline">
              {m.breadcrumbHome}
            </Link>
            <span aria-hidden="true"> &gt; </span>
            <span>{m.breadcrumbOps}</span>
            <span aria-hidden="true"> &gt; </span>
            <span>{m.breadcrumbAudit}</span>
          </nav>
          <div>
            <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
            <p className="text-body text-muted">{m.pageSubtitle}</p>
          </div>
        </div>

        {/* CSV export button */}
        <a
          href="/api/audit/export.csv"
          className="inline-flex items-center gap-1.5 rounded-card border border-border-warm bg-white px-space-normal py-space-snug text-button-sm text-foreground hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="audit-csv-export"
          download
        >
          {m.csvExport}
        </a>
      </header>

      <AuditPageShell
        rows={rows}
        totalCount={totalCount}
        distinctActions={distinctActions}
        distinctTargetKinds={distinctTargetKinds}
        currentActor={currentActor}
        currentAction={currentAction}
        currentTargetKind={currentTargetKind}
        currentPeriod={currentPeriod}
        currentSearch={currentSearch}
      />
    </div>
  );
}
