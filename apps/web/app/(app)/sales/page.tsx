/**
 * S-017 売上・KPI ダッシュボード (T-08-07, F-037/F-038/F-039, T-12-07).
 *
 * RSC page: 期間/アカウント/ジャンルフィルタを searchParams から読み取り、
 * getBooksKpiList + getSalesKpiSummary で集計し、Client Components に渡す。
 *
 * Filter approach: searchParams → RSC re-render (cost dashboard パターンに準拠)。
 *
 * Phase 1: 売上推移グラフ・ヒートマップは book-level aggregates (per-period)。
 *          per-month breakdown は T-08-08 クエリ拡張後に改善可能。
 * Phase 2 (T-12-07): 自動取得ステータスバナー追加。
 *
 * 仕様根拠: docs/04 S-017 / docs/05 §10 / SP-08 T-08-07 / SP-12 T-12-07
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';
import { getBooksKpiList, getSalesKpiSummary, getMonthlyGenreSales } from '@a2p/db/books-kpi';

import { messages } from '@/lib/messages';
import {
  serializeBookKpiRow,
  buildMonthRange,
  monthRangeBounds,
  parsePeriodParam,
  buildTrendChartFromAggregates,
  buildHeatmapFromAggregates,
  type BookKpiRowSerialized,
} from '@/lib/sales-kpi-view';
import {
  getLatestSalesFetchRun,
  serializeSalesFetchRun,
  type SalesFetchRunSerialized,
} from '@/lib/sales-fetch-status';

import { SalesKpiShell } from '@/components/sales/sales-kpi-shell';
import { SalesKpiStripe } from '@/components/sales/sales-kpi-stripe';
import { SalesTrendChart } from '@/components/sales/sales-trend-chart';
import { GenreMonthHeatmap } from '@/components/sales/genre-month-heatmap';
import { BooksKpiTable } from '@/components/sales/books-kpi-table';
import { SalesFetchStatusBanner } from '@/components/sales/sales-fetch-status-banner';

export const metadata: Metadata = {
  title: `${messages.salesKpi.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.salesKpi;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function sp(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

export default async function SalesKpiPage({ searchParams }: PageProps) {
  const params = await searchParams;

  // Parse filter params
  const periodRaw = sp(params, 'period') ?? '1';
  const accountId = sp(params, 'accountId');
  const genre = sp(params, 'genre');

  const periodMonths = parsePeriodParam(periodRaw);
  const months = buildMonthRange(periodMonths);
  const bounds = monthRangeBounds(months);

  const filter = {
    accountId: accountId && accountId !== 'all' ? accountId : undefined,
    genre: genre && genre !== 'all' ? genre : undefined,
    periodFrom: bounds?.from,
    periodTo: bounds?.to,
  };

  // Parallel DB queries
  const [kpiRows, summary, accounts, monthlyGenreSales] = await Promise.all([
    getBooksKpiList(prisma, filter),
    getSalesKpiSummary(prisma, filter),
    prisma.account.findMany({
      select: { id: true, pen_name: true },
      orderBy: { pen_name: 'asc' },
    }),
    getMonthlyGenreSales(prisma, filter),
  ]);

  // シングルユーザー運用: フィルタ指定アカウントまたは最初の active アカウントを対象にする
  const targetAccountId =
    accountId && accountId !== 'all'
      ? accountId
      : accounts[0]?.id ?? null;

  let latestRun: SalesFetchRunSerialized | null = null;
  if (targetAccountId) {
    const run = await getLatestSalesFetchRun(targetAccountId);
    latestRun = run ? serializeSalesFetchRun(run) : null;
  }

  const serializedBooks: BookKpiRowSerialized[] = kpiRows.map(serializeBookKpiRow);

  const trendData = buildTrendChartFromAggregates(monthlyGenreSales, months);
  const heatmapMatrix = buildHeatmapFromAggregates(monthlyGenreSales, months);

  const isEmpty = summary.total_books === 0 && summary.total_royalty_jpy === 0;

  return (
    <div className="flex flex-col gap-space-loose" data-testid="sales-kpi-page">
      {/* Page header */}
      <header className="flex flex-col gap-space-snug sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-space-snug">
          <nav aria-label="breadcrumb" className="text-button-sm text-muted">
            <Link href="/dashboard" className="no-underline hover:underline">
              {m.breadcrumbHome}
            </Link>
            <span aria-hidden="true"> &gt; </span>
            <span>{m.breadcrumbAnalytics}</span>
            <span aria-hidden="true"> &gt; </span>
            <span>{m.breadcrumbSalesKpi}</span>
          </nav>
          <div>
            <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
            <p className="text-body text-muted">{m.pageSubtitle}</p>
          </div>
        </div>

        {/* CTAs */}
        <div className="flex shrink-0 flex-wrap items-center gap-space-snug">
          <Link
            href="/sales/manual"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-card bg-charcoal px-3 py-2 text-button-sm text-white hover:bg-charcoal/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="manual-input-cta"
          >
            {m.manualInputButton}
          </Link>
        </div>
      </header>

      {/* 自動取得ステータスバナー (T-12-07, F-038) */}
      {targetAccountId && (
        <SalesFetchStatusBanner
          latestRun={latestRun}
          accountId={targetAccountId}
        />
      )}

      <SalesKpiShell
        accounts={accounts}
        currentPeriod={periodRaw}
        currentAccountId={accountId ?? 'all'}
        currentGenre={genre ?? 'all'}
      >
        {/* KPI stripe — always shown */}
        <section aria-labelledby="sales-kpi-heading">
          <h2 id="sales-kpi-heading" className="sr-only">KPI サマリ</h2>
          <SalesKpiStripe summary={summary} />
        </section>

        {isEmpty ? (
          /* Empty state */
          <div
            className="flex flex-col items-center gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
            data-testid="sales-kpi-empty"
          >
            <p className="text-body font-medium text-charcoal">{m.empty.title}</p>
            <p className="text-body text-muted">{m.empty.body}</p>
            <Link
              href="/sales/manual"
              className="mt-2 inline-flex cursor-pointer items-center rounded-card bg-charcoal px-4 py-2 text-button-sm text-white hover:bg-charcoal/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {m.empty.cta}
            </Link>
          </div>
        ) : (
          <>
            {/* Chart row */}
            <div className="grid grid-cols-1 gap-space-loose lg:grid-cols-5">
              <div className="lg:col-span-3">
                <SalesTrendChart data={trendData} />
              </div>
              <div className="lg:col-span-2">
                <GenreMonthHeatmap matrix={heatmapMatrix} />
              </div>
            </div>

            {/* Books KPI table */}
            <section aria-labelledby="books-kpi-heading">
              <h2
                id="books-kpi-heading"
                className="mb-space-snug text-card-title text-foreground"
              >
                {m.table.sectionTitle}
              </h2>
              <p className="mb-space-snug text-caption text-muted">
                {m.table.virtualizeNote}
              </p>
              <BooksKpiTable books={serializedBooks} />
            </section>
          </>
        )}
      </SalesKpiShell>
    </div>
  );
}
