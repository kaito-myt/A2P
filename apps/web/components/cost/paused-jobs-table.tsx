'use client';

/**
 * S-024 PausedJobsTable (T-07-05).
 *
 * Paused-cost books with continue/cancel buttons.
 * SA calls are to `resumePausedBook` (docs/05 §4.3.14).
 */
import { useCallback, useState, useTransition } from 'react';

import { messages } from '@/lib/messages';
import { formatCostJpy, type PausedBookSerialized } from '@/lib/cost-dashboard-view';
import { resumePausedBook } from '@/app/actions/jobs';

interface PausedJobsTableProps {
  books: PausedBookSerialized[];
}

const m = messages.costDashboard.pausedJobs;

export function PausedJobsTable({ books }: PausedJobsTableProps) {
  if (books.length === 0) {
    return (
      <div
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        data-testid="paused-jobs-empty"
      >
        <p className="text-body text-muted">{m.empty}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-card border border-border-warm" data-testid="paused-jobs-table">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b border-border-warm bg-cream-light text-left">
            <th className="px-space-relaxed py-space-snug font-medium text-charcoal">{m.colTitle}</th>
            <th className="px-space-relaxed py-space-snug font-medium text-charcoal">{m.colAccount}</th>
            <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colCostJpy}</th>
            <th className="px-space-relaxed py-space-snug font-medium text-charcoal">{m.colStatus}</th>
            <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">{m.colActions}</th>
          </tr>
        </thead>
        <tbody>
          {books.map((book) => (
            <PausedBookRow key={book.id} book={book} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PausedBookRow({ book }: { book: PausedBookSerialized }) {
  const [isPending, startTransition] = useTransition();
  const [decided, setDecided] = useState<'continue' | 'cancel' | null>(null);

  const handleAction = useCallback(
    (decision: 'continue' | 'cancel') => {
      startTransition(async () => {
        const result = await resumePausedBook({
          book_id: book.id,
          decision,
        });
        if (result.ok) {
          setDecided(decision);
        }
      });
    },
    [book.id],
  );

  return (
    <tr className="border-b border-border-warm last:border-0">
      <td className="px-space-relaxed py-space-snug text-charcoal">{book.title}</td>
      <td className="px-space-relaxed py-space-snug text-muted">{book.account_pen_name}</td>
      <td className="px-space-relaxed py-space-snug text-right text-charcoal">
        {formatCostJpy(book.cost_jpy_total)}
      </td>
      <td className="px-space-relaxed py-space-snug text-muted">{book.cost_status}</td>
      <td className="px-space-relaxed py-space-snug text-right">
        {decided ? (
          <span className="text-caption text-muted">
            {decided === 'continue' ? m.continueSuccess : m.cancelSuccess}
          </span>
        ) : (
          <div className="flex justify-end gap-2">
            <button
              className="rounded-button border border-border-warm bg-cream-light px-3 py-1 text-button-sm font-medium text-charcoal hover:bg-charcoal-04 disabled:opacity-50"
              disabled={isPending}
              onClick={() => handleAction('continue')}
              data-testid={`paused-continue-${book.id}`}
            >
              {isPending ? m.continuing : m.continueButton}
            </button>
            <button
              className="rounded-button border border-destructive bg-cream-light px-3 py-1 text-button-sm font-medium text-destructive hover:bg-destructive-bg disabled:opacity-50"
              disabled={isPending}
              onClick={() => handleAction('cancel')}
              data-testid={`paused-cancel-${book.id}`}
            >
              {isPending ? m.cancelling : m.cancelButton}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
