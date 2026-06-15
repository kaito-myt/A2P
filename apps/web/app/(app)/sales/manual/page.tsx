/**
 * S-018 売上手動入力 RSC ページ (T-08-06, F-037).
 *
 * 書籍一覧を取得してクライアントシェルに渡す。
 * 書籍+年月選択後のデータプリフィルは shell の Server Action 呼び出しで実現
 * (RSC は books 一覧のみ担う)。
 *
 * 仕様根拠: docs/04 S-018 / SP-08 T-08-06
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { serializeBookSelectorItems } from '@/lib/sales-view';
import { SalesManualShell } from '@/components/sales/sales-manual-shell';

export const metadata: Metadata = {
  title: `${messages.salesManual.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.salesManual;

export default async function SalesManualPage() {
  const booksRaw = await prisma.book.findMany({
    where: {
      status: { notIn: ['failed', 'cancelled'] },
    },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      title: true,
      asin: true,
    },
  });

  const books = serializeBookSelectorItems(booksRaw);

  return (
    <div className="flex flex-col gap-space-loose" data-testid="sales-manual-page">
      {/* Page header */}
      <header className="flex items-start justify-between gap-space-snug">
        <div className="flex flex-col gap-space-snug">
          <nav aria-label="breadcrumb" className="text-button-sm text-muted">
            <Link href="/dashboard" className="no-underline hover:underline">
              {m.breadcrumbHome}
            </Link>
            <span aria-hidden="true"> &gt; </span>
            <span>{m.breadcrumbAnalytics}</span>
            <span aria-hidden="true"> &gt; </span>
            <Link href="/sales" className="no-underline hover:underline">
              {m.breadcrumbSalesKpi}
            </Link>
            <span aria-hidden="true"> &gt; </span>
            <span>{m.breadcrumbManual}</span>
          </nav>
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
        </div>
        <Link
          href="/sales"
          className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04"
          data-testid="back-to-dashboard-link"
        >
          {m.backToDashboard}
        </Link>
      </header>

      <SalesManualShell books={books} />
    </div>
  );
}
