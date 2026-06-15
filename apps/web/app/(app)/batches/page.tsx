/**
 * バッチ計画一覧 (T-03-09 推奨パート).
 *
 * BatchPlan の status 別カウント + 直近 7 件の簡易リスト。
 * 詳細画面は SP-04 以降 (BatchPlan 詳細 UI が必要になったら別タスク)。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';

export const metadata: Metadata = {
  title: `${messages.batches.listPageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.batches;

const STATUS_KEYS = [
  'scheduled',
  'running',
  'done',
  'failed',
  'cancelled',
] as const;
type StatusKey = (typeof STATUS_KEYS)[number];

function statusLabel(s: string): string {
  if (s === 'scheduled' || s === 'running' || s === 'done' || s === 'failed' || s === 'cancelled') {
    return m.statusCounts[s];
  }
  return s;
}

export default async function BatchesListPage() {
  const [counts, recent] = await Promise.all([
    prisma.batchPlan.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    prisma.batchPlan.findMany({
      orderBy: { created_at: 'desc' },
      take: 7,
      include: { items: { select: { id: true } } },
    }),
  ]);

  const countByStatus: Record<StatusKey, number> = {
    scheduled: 0,
    running: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const c of counts) {
    if ((STATUS_KEYS as readonly string[]).includes(c.status)) {
      countByStatus[c.status as StatusKey] = c._count._all;
    }
  }

  return (
    <div className="flex flex-col gap-space-loose">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <Link href="/themes" className="no-underline hover:underline">
            {m.breadcrumbPipeline}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbBatches}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.listPageTitle}</h1>
          <p className="text-body text-muted">{m.listPageSubtitle}</p>
        </div>
      </header>

      <section
        data-testid="batches-status-summary"
        className="grid grid-cols-2 gap-space-snug md:grid-cols-5"
      >
        {STATUS_KEYS.map((s) => (
          <div
            key={s}
            data-testid={`batches-status-${s}`}
            className="rounded-card border border-border-warm bg-cream px-space-relaxed py-space-snug"
          >
            <div className="text-button-sm text-muted">{m.statusCounts[s]}</div>
            <div className="text-sub-heading text-foreground">
              {countByStatus[s]}
              <span className="ml-1 text-button-sm text-muted">{m.list.countSuffix}</span>
            </div>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-space-snug text-card-title text-foreground">
          {m.list.recentHeading}
        </h2>
        {recent.length === 0 ? (
          <div
            data-testid="batches-empty-state"
            className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
          >
            <p className="text-body text-charcoal">{m.list.empty}</p>
            <div className="mt-space-snug flex justify-center">
              <Link
                href="/themes"
                className="text-button-sm text-foreground underline hover:no-underline"
              >
                {m.list.goToThemes}
              </Link>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-card border border-border-warm bg-cream">
            <table
              data-testid="batches-table"
              className="w-full border-collapse text-button-sm"
            >
              <thead>
                <tr className="border-b border-border-warm text-left text-muted">
                  <th className="px-space-relaxed py-2 font-medium">{m.list.colId}</th>
                  <th className="px-space-relaxed py-2 font-medium">{m.list.colPlannedAt}</th>
                  <th className="px-space-relaxed py-2 font-medium">{m.list.colConcurrency}</th>
                  <th className="px-space-relaxed py-2 font-medium">{m.list.colItems}</th>
                  <th className="px-space-relaxed py-2 font-medium">{m.list.colPredictedCost}</th>
                  <th className="px-space-relaxed py-2 font-medium">{m.list.colStatus}</th>
                  <th className="px-space-relaxed py-2 font-medium">{m.list.colCreatedAt}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((b) => (
                  <tr
                    key={b.id}
                    data-testid={`batch-plan-row-${b.id}`}
                    className="border-b border-border-warm/60 last:border-b-0"
                  >
                    <td className="px-space-relaxed py-2 font-mono text-charcoal-82">
                      {b.id.slice(0, 12)}…
                    </td>
                    <td className="px-space-relaxed py-2 text-charcoal-82">
                      {b.planned_at.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="px-space-relaxed py-2 text-charcoal-82">
                      {b.concurrency}
                    </td>
                    <td className="px-space-relaxed py-2 text-charcoal-82">
                      {b.items.length}
                    </td>
                    <td className="px-space-relaxed py-2 text-charcoal-82">
                      {m.list.jpyPrefix}
                      {b.predicted_cost_jpy.toLocaleString('ja-JP')}
                    </td>
                    <td className="px-space-relaxed py-2 text-foreground">
                      {statusLabel(b.status)}
                    </td>
                    <td className="px-space-relaxed py-2 text-charcoal-82">
                      {b.created_at.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
