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

import { approveBookContent, requestContentRevision } from '@/app/actions/books';
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
  const [info, setInfo] = useState<string | null>(null);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [note, setNote] = useState('');

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

  function submitRevision() {
    setError(null);
    setInfo(null);
    if (note.trim().length === 0) return;
    startTransition(async () => {
      const res = await requestContentRevision({ book_id: book.id, note: note.trim() });
      if (!res.ok) {
        setError(res.error?.message ?? m.revisionError);
        return;
      }
      setInfo(m.revisionStarted);
      setReviseOpen(false);
      setNote('');
      router.refresh();
    });
  }

  return (
    <li
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
      data-testid={`content-review-item-${book.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-space-snug">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-card-title font-medium text-charcoal">{book.title}</span>
          <div className="flex flex-wrap items-center gap-x-space-snug text-button-sm text-muted">
            <span>{book.author}</span>
            <span>全 {book.chapterCount} 章</span>
            {info && <span className="text-success">{info}</span>}
            {error && <span className="text-destructive">{error}</span>}
          </div>
        </div>
        <div className="flex items-center gap-space-snug">
          <Link
            href={`/books/${book.id}`}
            className="inline-flex items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04"
            data-testid={`content-review-open-${book.id}`}
          >
            {m.openDetail}
          </Link>
          <button
            type="button"
            onClick={() => setReviseOpen((o) => !o)}
            disabled={pending}
            className="inline-flex items-center rounded-card border border-warning bg-warning-bg/40 px-3 py-1.5 text-button-sm text-warning hover:bg-warning-bg disabled:opacity-50"
            data-testid={`content-review-revise-${book.id}`}
          >
            {m.requestRevision}
          </button>
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
      </div>

      {reviseOpen && (
        <div className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream p-space-snug">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={m.revisionPlaceholder}
            rows={3}
            className="w-full rounded-default border border-border-warm bg-cream-light px-3 py-2 text-button-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`content-review-note-${book.id}`}
          />
          <div className="flex items-center gap-space-snug">
            <button
              type="button"
              onClick={submitRevision}
              disabled={pending || note.trim().length === 0}
              className="inline-flex items-center rounded-card bg-charcoal px-3 py-1.5 text-button-sm text-cream-light shadow-l2-inset hover:opacity-80 disabled:opacity-50"
            >
              {pending ? m.revisionSubmitting : m.revisionSubmit}
            </button>
            <button
              type="button"
              onClick={() => { setReviseOpen(false); setNote(''); }}
              disabled={pending}
              className="text-button-sm text-muted hover:text-charcoal"
            >
              {m.cancel}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
