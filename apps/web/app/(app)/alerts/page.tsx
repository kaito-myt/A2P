/**
 * S-028 アラート一覧 (T-07-08, F-024/F-034/F-036).
 *
 * RSC page: fetches Alert records (newest 100),
 * serializes for client, and renders AlertsPageShell.
 *
 * Scope:
 *  - All alerts including resolved (latest 100)
 *  - Ordered by created_at DESC
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { AlertsPageShell } from '@/components/alerts/alerts-page-shell';
import { messages } from '@/lib/messages';
import { serializeAlertRow } from '@/lib/alerts-view';

export const metadata: Metadata = {
  title: `${messages.alerts.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.alerts;

export default async function AlertsListPage() {
  const rawRows = await prisma.alert.findMany({
    orderBy: { created_at: 'desc' },
    take: 100,
  });

  const rows = rawRows.map(serializeAlertRow);

  return (
    <div className="flex flex-col gap-space-loose" data-testid="alerts-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbOps}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbAlerts}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      {rows.length === 0 ? (
        <div
          data-testid="alerts-empty-state"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        >
          <p className="text-body font-medium text-charcoal">{m.empty.title}</p>
          <p className="mt-2 text-body text-muted">{m.empty.body}</p>
          <div className="mt-space-snug flex justify-center">
            <Link
              href="/dashboard"
              className="text-button-sm text-foreground underline hover:no-underline"
              data-testid="alerts-empty-cta"
            >
              {m.empty.cta}
            </Link>
          </div>
        </div>
      ) : (
        <AlertsPageShell rows={rows} />
      )}
    </div>
  );
}
