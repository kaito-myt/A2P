/**
 * S-024 TopCostBooksTable (T-07-05).
 *
 * Top 20 high-cost books with 500 yen badge.
 */
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import { formatCostJpy, formatTokenCount, type TopCostBookSerialized } from '@/lib/cost-dashboard-view';

interface TopCostBooksTableProps {
  books: TopCostBookSerialized[];
}

const m = messages.costDashboard.topBooks;

export function TopCostBooksTable({ books }: TopCostBooksTableProps) {
  if (books.length === 0) {
    return (
      <div
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        data-testid="top-cost-books-empty"
      >
        <p className="text-body text-muted">{m.empty}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-card border border-border-warm" data-testid="top-cost-books-table">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b border-border-warm bg-cream-light text-left">
            <th className="w-12 px-space-relaxed py-space-snug text-center font-medium text-charcoal">{m.colRank}</th>
            <th className="px-space-relaxed py-space-snug font-medium text-charcoal">{m.colTitle}</th>
            <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colCostJpy}</th>
            <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colInputTokens}</th>
            <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colOutputTokens}</th>
            <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colImages}</th>
          </tr>
        </thead>
        <tbody>
          {books.map((book, i) => (
            <tr key={book.book_id} className="border-b border-border-warm last:border-0">
              <td className="px-space-relaxed py-space-snug text-center text-muted">{i + 1}</td>
              <td className="px-space-relaxed py-space-snug text-charcoal">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/books/${book.book_id}`}
                    className="text-foreground underline hover:no-underline"
                  >
                    {book.title}
                  </Link>
                  {book.over_threshold && (
                    <Badge variant="must">{m.overBadge}</Badge>
                  )}
                </div>
              </td>
              <td className="px-space-relaxed py-space-snug text-right text-charcoal">
                {formatCostJpy(book.total_cost_jpy)}
              </td>
              <td className="px-space-relaxed py-space-snug text-right text-muted">
                {formatTokenCount(book.total_input_tokens)}
              </td>
              <td className="px-space-relaxed py-space-snug text-right text-muted">
                {formatTokenCount(book.total_output_tokens)}
              </td>
              <td className="px-space-relaxed py-space-snug text-right text-muted">
                {book.total_image_count}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
