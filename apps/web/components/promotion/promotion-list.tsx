'use client';

/**
 * PromotionList — 販促施策の書籍一覧。各書籍で販促プランを生成 / 閲覧する。
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { generateBookPromotion } from '@/app/actions/promotion';
import { messages } from '@/lib/messages';
import type { PromotionBookRow } from '@/lib/promotion-view';

const m = messages.promotion;

export function PromotionList({ books }: { books: PromotionBookRow[] }) {
  return (
    <ul className="flex flex-col gap-space-snug" data-testid="promotion-list">
      {books.map((b) => (
        <PromotionRow key={b.id} book={b} />
      ))}
    </ul>
  );
}

function PromotionRow({ book }: { book: PromotionBookRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [info, setInfo] = useState<string | null>(null);

  function generate() {
    setInfo(null);
    start(async () => {
      const res = await generateBookPromotion({ book_id: book.id });
      if (!res.ok) {
        setInfo(res.error?.message ?? m.errors.generate);
        return;
      }
      setInfo(m.started);
      router.refresh();
    });
  }

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
      data-testid={`promotion-item-${book.id}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-card-title font-medium text-charcoal">{book.title}</span>
        <div className="flex flex-wrap items-center gap-x-space-snug text-button-sm text-muted">
          <span>{book.author}</span>
          <span
            className={`rounded-pill px-2 py-0.5 text-caption ${
              book.hasPlan ? 'bg-success-bg text-success' : 'bg-charcoal-04 text-charcoal-82'
            }`}
          >
            {book.hasPlan ? m.hasPlan : m.noPlan}
          </span>
          {info && <span className="text-accent">{info}</span>}
        </div>
      </div>
      <div className="flex items-center gap-space-snug">
        {book.hasPlan && (
          <Link
            href={`/promotion/${book.id}`}
            className="inline-flex items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04"
          >
            {m.view}
          </Link>
        )}
        <button
          type="button"
          onClick={generate}
          disabled={pending}
          className="inline-flex items-center rounded-card bg-charcoal px-3 py-1.5 text-button-sm text-cream-light shadow-l2-inset hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {pending ? m.generating : book.hasPlan ? m.regenerate : m.generate}
        </button>
      </div>
    </li>
  );
}
