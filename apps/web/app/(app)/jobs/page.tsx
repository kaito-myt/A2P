/**
 * S-025 ジョブログ一覧 (T-09-01, F-045/F-046).
 *
 * RSC page: 直近 1,000 件のジョブを取得し、フィルタ・統計・テーブルを表示。
 * searchParams で kind / status / period / bookId をフィルタ。
 * 直近 24h の統計は別クエリで集計。
 *
 * 仕様根拠: docs/04 S-025 / docs/05 §4.3.14 / SP-09 T-09-01
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { serializeJobRow, computeJobStats, type JobRawRow } from '@/lib/jobs-view';
import { JobsPageShell } from '@/components/jobs/jobs-page-shell';

export const metadata: Metadata = {
  title: `${messages.jobs.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.jobs;
const MAX_ROWS = 1000;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function sp(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

function periodToDate(period: string): Date | null {
  const now = new Date();
  switch (period) {
    case '1d':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

export default async function JobsListPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const currentKind = sp(params, 'kind') ?? 'all';
  const currentStatus = sp(params, 'status') ?? 'all';
  const currentPeriod = sp(params, 'period') ?? 'all';
  const currentBookId = sp(params, 'bookId') ?? 'all';

  const since = periodToDate(currentPeriod);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [rawJobs, stats24hRaw, books] = await Promise.all([
    // Main query: up to 1,000 filtered rows
    prisma.job.findMany({
      where: {
        ...(currentKind !== 'all' ? { kind: currentKind } : {}),
        ...(currentStatus !== 'all' ? { status: currentStatus } : {}),
        ...(currentBookId !== 'all' ? { book_id: currentBookId } : {}),
        ...(since ? { created_at: { gte: since } } : {}),
      },
      select: {
        id: true,
        kind: true,
        book_id: true,
        book: { select: { id: true, title: true } },
        status: true,
        started_at: true,
        finished_at: true,
        retries: true,
        error: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: MAX_ROWS,
    }),

    // Stats: last 24h (no filter — always all jobs for accurate stats)
    prisma.job.findMany({
      where: { created_at: { gte: since24h } },
      select: {
        id: true,
        kind: true,
        book_id: true,
        status: true,
        started_at: true,
        finished_at: true,
        retries: true,
        error: true,
        created_at: true,
      },
    }),

    // Books for filter dropdown (distinct books with jobs)
    prisma.book.findMany({
      where: {
        jobs: { some: {} },
      },
      select: { id: true, title: true },
      orderBy: { created_at: 'desc' },
      take: 200,
    }),
  ]);

  const rows = rawJobs.map((r) => serializeJobRow(r as unknown as JobRawRow));
  const stats = computeJobStats(stats24hRaw as unknown as JobRawRow[]);

  // Total count (unfiltered) for display
  const totalCount = await prisma.job.count();

  return (
    <div className="flex flex-col gap-space-loose" data-testid="jobs-page">
      {/* Page header */}
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbOps}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbJobs}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      <JobsPageShell
        rows={rows}
        stats={stats}
        books={books}
        totalCount={totalCount}
        currentKind={currentKind}
        currentStatus={currentStatus}
        currentPeriod={currentPeriod}
        currentBookId={currentBookId}
      />
    </div>
  );
}
