/**
 * S-013 修正コメント一覧（横断） (T-06-06, F-049/F-050).
 *
 * RSC page: fetches all RevisionComments with Book join,
 * serializes for client, and renders CommentsPageShell.
 *
 * Scope:
 *  - All non-superseded comments (pending / applied / not_applicable)
 *  - Ordered by created_at DESC
 *  - Upper limit 500 rows
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { CommentsPageShell } from '@/components/comments/comments-page-shell';
import { messages } from '@/lib/messages';
import {
  serializeCommentRow,
  extractBookOptions,
} from '@/lib/comments-view';

export const metadata: Metadata = {
  title: `${messages.commentsPage.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.commentsPage;

export default async function CommentsListPage() {
  const rawRows = await prisma.revisionComment.findMany({
    where: {
      status: { not: 'superseded' },
    },
    orderBy: { created_at: 'desc' },
    take: 500,
    include: {
      book: {
        select: { id: true, title: true },
      },
    },
  });

  const rows = rawRows.map(serializeCommentRow);
  const bookOptions = extractBookOptions(rows);

  return (
    <div className="flex flex-col gap-space-loose" data-testid="comments-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbBooks}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbComments}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      {rows.length === 0 ? (
        <div
          data-testid="comments-empty-state"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        >
          <p className="text-body font-medium text-charcoal">{m.empty.title}</p>
          <p className="mt-2 text-body text-muted">{m.empty.body}</p>
          <div className="mt-space-snug flex justify-center">
            <Link
              href="/books"
              className="text-button-sm text-foreground underline hover:no-underline"
              data-testid="comments-empty-cta"
            >
              {m.empty.cta}
            </Link>
          </div>
        </div>
      ) : (
        <CommentsPageShell rows={rows} bookOptions={bookOptions} />
      )}
    </div>
  );
}
