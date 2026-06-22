'use client';

/**
 * BookInfoHeader — 選択中書籍のサムネ + タイトル + サブタイトル + 著者名 (T-08-03).
 */
import Image from 'next/image';
import type { ChecklistBookView } from '@/lib/kdp-checklist-view';
import { messages } from '@/lib/messages';

interface BookInfoHeaderProps {
  book: ChecklistBookView;
}

const m = messages.kdpChecklist;

export function BookInfoHeader({ book }: BookInfoHeaderProps) {
  return (
    <div
      className="flex items-start gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-snug"
      data-testid="book-info-header"
    >
      {/* Thumbnail */}
      <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded-card border border-border-warm bg-charcoal-04">
        {book.coverImageUrl ? (
          <Image
            src={book.coverImageUrl}
            alt={book.title}
            fill
            sizes="56px"
            unoptimized
            className="object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-caption text-muted">
            {m.noValue}
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="truncate text-card-title text-foreground">{book.title}</p>
        {book.subtitle && (
          <p className="truncate text-body text-muted">{book.subtitle}</p>
        )}
        {book.author && (
          <p className="truncate text-caption text-muted">{book.author}</p>
        )}
      </div>
    </div>
  );
}
