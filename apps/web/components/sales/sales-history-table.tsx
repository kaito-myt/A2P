'use client';

/**
 * SalesHistoryTable — 選択書籍の過去 6 ヶ月売上ミニテーブル (S-018, T-08-06).
 *
 * Progressive disclosure: 折りたたみ可。
 */
import { useState, useId } from 'react';

import { messages } from '@/lib/messages';
import type { SalesHistoryData } from '@/lib/sales-view';
import { cn } from '@/lib/cn';

const m = messages.salesManual.history;

interface SalesHistoryTableProps {
  history: SalesHistoryData | null;
  bookTitle: string;
  isLoading: boolean;
}

export function SalesHistoryTable({ history, bookTitle, isLoading }: SalesHistoryTableProps) {
  const headingId = useId();
  const [isOpen, setIsOpen] = useState(true);

  const rows = history?.rows ?? [];

  return (
    <section
      className="rounded-card border border-border-warm bg-surface"
      aria-labelledby={headingId}
      data-testid="sales-history-table"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        aria-controls={`${headingId}-content`}
      >
        <h2 id={headingId} className="text-label text-foreground">
          {m.sectionTitle(bookTitle)}
        </h2>
        <ChevronIcon open={isOpen} />
      </button>

      {isOpen && (
        <div id={`${headingId}-content`} className="px-4 pb-4">
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-6 animate-pulse rounded bg-charcoal-04" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="text-body-sm text-muted">{m.empty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-body-sm">
                <thead>
                  <tr className="border-b border-border-warm text-muted">
                    <th scope="col" className="pb-2 pr-4 text-left font-medium">{m.colYearMonth}</th>
                    <th scope="col" className="pb-2 pr-4 text-right font-medium">{m.colRoyalty}</th>
                    <th scope="col" className="pb-2 pr-4 text-right font-medium">{m.colReviewCount}</th>
                    <th scope="col" className="pb-2 text-right font-medium">{m.colAvgStars}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.year_month}
                      className="border-b border-border-warm/50 last:border-0"
                    >
                      <td className="py-1.5 pr-4 text-charcoal">{row.year_month}</td>
                      <td className="py-1.5 pr-4 text-right text-charcoal">
                        ¥{row.royalty_jpy.toLocaleString('ja-JP')}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-charcoal">{row.review_count}</td>
                      <td className="py-1.5 text-right text-charcoal">
                        {row.avg_stars != null ? row.avg_stars.toFixed(1) : m.noStars}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('shrink-0 text-muted transition-transform', open && 'rotate-180')}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
