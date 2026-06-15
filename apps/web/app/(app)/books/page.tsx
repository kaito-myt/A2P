/**
 * S-009 書籍ライブラリ (T-05-11 / docs/04 S-009 / docs/05 §4.2).
 *
 * RSC page: fetches all books with account + theme + artifacts,
 * serializes for client, and renders BooksPageShell.
 *
 * Phase 1: status filter only. Full filters (account/genre/quality/cost/period)
 * are deferred to later sprints.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { BooksPageShell } from '@/components/books/books-page-shell';
import { messages } from '@/lib/messages';
import { serializeBookRow } from '@/lib/books-view';

export const metadata: Metadata = {
  title: `${messages.books.libraryPageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.books;

export default async function BooksPage() {
  const rawBooks = await prisma.book.findMany({
    orderBy: { created_at: 'desc' },
    include: {
      account: {
        select: { id: true, pen_name: true },
      },
      theme: {
        select: { genre: true },
      },
      artifacts: {
        select: { id: true, kind: true },
      },
    },
  });

  const rows = rawBooks.map(serializeBookRow);

  return (
    <div className="flex flex-col gap-space-loose" data-testid="books-library-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbBooks}</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-space-snug">
          <div className="flex flex-col">
            <h1 className="text-sub-heading text-foreground">{m.libraryPageTitle}</h1>
            <p className="text-body text-muted">{m.libraryPageSubtitle}</p>
          </div>
          <div className="flex items-center gap-space-snug">
            <Link
              href="/batches"
              className="inline-flex items-center rounded-button border border-border-warm bg-cream-light px-4 py-2 text-button font-medium text-charcoal hover:bg-charcoal-04"
              data-testid="new-project-cta"
            >
              {m.newProjectCta}
            </Link>
          </div>
        </div>
      </header>

      {rows.length === 0 ? (
        <div
          data-testid="books-empty-state"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        >
          <p className="text-body font-medium text-charcoal">{m.libraryEmpty.title}</p>
          <p className="mt-2 text-body text-muted">{m.libraryEmpty.body}</p>
          <div className="mt-space-snug flex justify-center">
            <Link
              href="/batches"
              className="inline-flex items-center rounded-button border border-border-warm bg-cream-light px-4 py-2 text-button font-medium text-charcoal hover:bg-charcoal-04"
            >
              {m.libraryEmpty.cta}
            </Link>
          </div>
        </div>
      ) : (
        <BooksPageShell rows={rows} />
      )}
    </div>
  );
}
