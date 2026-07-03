'use client';

/**
 * ContentReviewList — 本文承認待ち (status='content_review') の書籍一覧。
 *
 * 出版パイプラインの人手ゲート。アウトライン承認 / サムネ承認と並ぶ本文承認の
 * 横断リスト。各書籍で本文を確認 (詳細へ) し、承認するとサムネ生成へ進む
 * (approveBookContent SA)。
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { approveBookContent } from '@/app/actions/books';
import { messages } from '@/lib/messages';

const m = messages.contentReview;

export interface ContentReviewBook {
  id: string;
  title: string;
  author: string;
  chapterCount: number;
  updatedAt: string | null;
}

export function ContentReviewList({ books }: { books: ContentReviewBook[] }) {
  return (
    <ul className="flex flex-col gap-space-snug" data-testid="content-review-list">
      {books.map((book) => (
        <ContentReviewRow key={book.id} book={book} />
      ))}
    </ul>
  );
}

function ContentReviewRow({ book }: { book: ContentReviewBook }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function approve() {
    setError(null);
    startTransition(async () => {
      const res = await approveBookContent({ book_id: book.id });
      if (!res.ok) {
        setError(res.error?.message ?? m.approveError);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
      data-testid={`content-review-item-${book.id}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-card-title font-medium text-charcoal">{book.title}</span>
        <div className="flex flex-wrap items-center gap-x-space-snug text-button-sm text-muted">
          <span>{book.author}</span>
          <span>全 {book.chapterCount} 章</span>
        </div>
      </div>
      <div className="flex items-center gap-space-snug">
        {error && <span className="text-button-sm text-destructive">{error}</span>}
        <Link
          href={`/books/${book.id}`}
          className="inline-flex items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04"
          data-testid={`content-review-open-${book.id}`}
        >
          {m.openDetail}
        </Link>
        <button
          type="button"
          onClick={approve}
          disabled={pending}
          className="inline-flex items-center rounded-card bg-charcoal px-3 py-1.5 text-button-sm text-cream-light shadow-l2-inset hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          data-testid={`content-review-approve-${book.id}`}
        >
          {pending ? m.approving : m.approveButton}
        </button>
      </div>
    </li>
  );
}
