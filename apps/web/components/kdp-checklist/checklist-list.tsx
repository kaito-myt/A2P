/**
 * ChecklistList — KDP 入稿チェックリストのトップ一覧 (S-015 一覧).
 *
 * 入稿対象書籍をカードで一覧表示し、クリックで詳細
 * (/kdp/checklist/[bookId]) に遷移する。タブ切替の旧 UX を置き換える。
 */
import Link from 'next/link';

import { messages } from '@/lib/messages';
import type { ChecklistBookView } from '@/lib/kdp-checklist-view';
import { Badge } from '@/components/ui/badge';

const m = messages.kdpChecklist;

const publishLabel: Record<ChecklistBookView['publishStatus'], string> = {
  unlisted: messages.books.publish.unlisted,
  submitted: messages.books.publish.submitted,
  published: messages.books.publish.published,
};

const publishVariant: Record<ChecklistBookView['publishStatus'], 'neutral' | 'may' | 'success'> = {
  unlisted: 'neutral',
  submitted: 'may',
  published: 'success',
};

export function ChecklistList({ books }: { books: ChecklistBookView[] }) {
  return (
    <ul className="flex flex-col gap-space-snug" data-testid="checklist-list">
      {books.map((book) => {
        const ready = !book.hasBlockingComments && !book.metadataMissing;
        return (
          <li key={book.id}>
            <Link
              href={`/kdp/checklist/${book.id}`}
              className="flex items-center justify-between gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed no-underline transition-colors hover:bg-charcoal-04 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              data-testid={`checklist-list-item-${book.id}`}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-card-title font-medium text-charcoal">
                  {book.title}
                </span>
                <div className="flex flex-wrap items-center gap-x-space-snug gap-y-1 text-button-sm text-muted">
                  <span>{book.author}</span>
                  <span>
                    {m.completionRate(book.checkedCount, book.totalFieldCount)}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={publishVariant[book.publishStatus]}>
                  {publishLabel[book.publishStatus]}
                </Badge>
                {book.metadataMissing ? (
                  <Badge variant="should">{m.listMetadataMissing}</Badge>
                ) : book.hasBlockingComments ? (
                  <Badge variant="must">{m.tabBlockedBadge(book.mustCommentCount)}</Badge>
                ) : (
                  <Badge variant="success">{m.tabReadyBadge}</Badge>
                )}
                <span aria-hidden="true" className="text-muted">
                  ›
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
