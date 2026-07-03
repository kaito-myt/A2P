/**
 * 本文承認 (content_review) — 出版パイプラインの人手ゲート。
 *
 * 本文の執筆・校閲が完了し status='content_review' で停止している書籍を横断表示し、
 * 承認するとサムネ生成 (thumbnail.text) へ進める。アウトライン承認 / サムネ承認と
 * 同列のゲートページ。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { ContentReviewList } from '@/components/content-review/content-review-list';

export const metadata: Metadata = {
  title: `${messages.contentReview.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.contentReview;

export default async function ContentReviewPage() {
  const booksRaw = await prisma.book.findMany({
    where: { status: 'content_review' },
    orderBy: { updated_at: 'desc' },
    select: {
      id: true,
      title: true,
      updated_at: true,
      account: { select: { pen_name: true } },
      _count: { select: { chapters: true } },
    },
  });

  const books = booksRaw.map((b) => ({
    id: b.id,
    title: b.title,
    author: b.account.pen_name,
    chapterCount: b._count.chapters,
    updatedAt: b.updated_at instanceof Date ? b.updated_at.toISOString() : null,
  }));

  return (
    <div className="flex flex-col gap-space-loose" data-testid="content-review-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbPipeline}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbContentReview}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
        {books.length > 0 && (
          <span className="text-button-sm text-charcoal-82" data-testid="content-review-summary">
            {m.summary(books.length)}
          </span>
        )}
      </header>

      {books.length === 0 ? (
        <div
          data-testid="content-review-empty"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        >
          <p className="text-body font-medium text-charcoal">{m.empty.title}</p>
          <p className="mt-2 text-body text-muted">{m.empty.body}</p>
        </div>
      ) : (
        <ContentReviewList books={books} />
      )}
    </div>
  );
}
