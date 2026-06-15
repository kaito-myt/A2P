/**
 * S-014 修正一括反映一覧 (T-06-09).
 *
 * 直近の RevisionRun 一覧を表示。各行クリックで `/revision-runs/[id]` へ遷移。
 * メイン導線は S-013 からの遷移だが、サイドバーからもアクセス可能にする。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import {
  normalizeRunStatus,
  formatRunStatus,
  runStatusVariant,
  formatDateTime,
} from '@/lib/revision-runs-view';

export const metadata: Metadata = {
  title: `${messages.revisionRuns.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.revisionRuns;

export default async function RevisionRunsListPage() {
  const runs = await prisma.revisionRun.findMany({
    orderBy: { triggered_at: 'desc' },
    take: 50,
  });

  return (
    <div className="flex flex-col gap-space-loose" data-testid="revision-runs-list-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbBooks}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.pageTitle}</span>
        </nav>
        <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
      </header>

      {runs.length === 0 ? (
        <div
          data-testid="revision-runs-empty-state"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        >
          <p className="text-body font-medium text-charcoal">{m.empty.title}</p>
          <p className="mt-2 text-body text-muted">{m.empty.body}</p>
          <div className="mt-space-snug flex justify-center">
            <Link
              href="/comments"
              className="text-button-sm text-foreground underline hover:no-underline"
              data-testid="revision-runs-empty-cta"
            >
              {m.empty.cta}
            </Link>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-button-sm" data-testid="revision-runs-table">
            <thead>
              <tr className="border-b border-border-warm text-left text-charcoal-82">
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">{m.header.statusLabel}</th>
                <th className="px-3 py-2">{m.header.triggeredAtLabel}</th>
                <th className="px-3 py-2">{m.header.booksLabel}</th>
                <th className="px-3 py-2">{m.header.commentsLabel}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const status = normalizeRunStatus(run.status);
                const bookIds = Array.isArray(run.book_ids_json) ? run.book_ids_json : [];
                const commentIds = Array.isArray(run.comment_ids_json) ? run.comment_ids_json : [];

                return (
                  <tr
                    key={run.id}
                    className="border-b border-border-warm last:border-0 hover:bg-charcoal-04"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/revision-runs/${run.id}`}
                        className="text-foreground underline hover:no-underline"
                      >
                        {run.id.slice(0, 12)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={runStatusVariant(status)}>
                        {formatRunStatus(status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      {formatDateTime(run.triggered_at.toISOString())}
                    </td>
                    <td className="px-3 py-2">
                      {bookIds.length} {m.header.booksSuffix}
                    </td>
                    <td className="px-3 py-2">
                      {commentIds.length} {m.header.commentsSuffix}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
