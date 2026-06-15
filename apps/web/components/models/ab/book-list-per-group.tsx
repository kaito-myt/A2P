'use client';

/**
 * S-021 BookListPerGroup (T-13-05, F-026).
 *
 * A 群 / B 群 書籍リスト。書籍 ID から書籍タイトル等は表示できないため
 * (RSC から個別 book データを渡していない)、book_ids の一覧と
 * S-010 へのリンクを提供する。
 *
 * 集計済みの group stats から book_ids を使ってリンクのみ表示。
 * 個別書籍の Quality/コスト は別途 RSC 拡張で追加可能。
 *
 * @a2p/db を import しない。
 *
 * 仕様根拠: docs/04 §S-021 / SP-13 T-13-05
 */

import Link from 'next/link';

import { messages } from '@/lib/messages';
import type { AbGroupStatsSerialized } from '@/lib/ab-comparison-shared';

interface BookListPerGroupProps {
  groupA: AbGroupStatsSerialized;
  groupB: AbGroupStatsSerialized;
}

const m = messages.abComparison.bookList;

export function BookListPerGroup({ groupA, groupB }: BookListPerGroupProps) {
  return (
    <div className="grid grid-cols-1 gap-space-snug lg:grid-cols-2" data-testid="ab-book-list">
      <GroupBookList
        heading={`${m.groupAHeading}（${groupA.label}）`}
        bookIds={groupA.book_ids}
        insufficient={groupA.insufficient_data}
        testId="ab-book-list-a"
      />
      <GroupBookList
        heading={`${m.groupBHeading}（${groupB.label}）`}
        bookIds={groupB.book_ids}
        insufficient={groupB.insufficient_data}
        testId="ab-book-list-b"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal: single group book list
// ---------------------------------------------------------------------------

interface GroupBookListProps {
  heading: string;
  bookIds: string[];
  insufficient: boolean;
  testId: string;
}

function GroupBookList({ heading, bookIds, insufficient, testId }: GroupBookListProps) {
  return (
    <div className="rounded-card border border-border-warm bg-white" data-testid={testId}>
      <div className="border-b border-border-warm px-space-snug py-2">
        <h3 className="text-card-title text-foreground">{heading}</h3>
      </div>

      {insufficient ? (
        <div className="px-space-snug py-space-snug">
          <p className="text-body text-muted" data-testid={`${testId}-insufficient`}>
            {messages.abComparison.sampleCount.insufficient}
          </p>
        </div>
      ) : bookIds.length === 0 ? (
        <div className="px-space-snug py-space-snug">
          <p className="text-body text-muted">{m.empty}</p>
        </div>
      ) : (
        <table className="w-full text-body" data-testid={`${testId}-table`}>
          <thead>
            <tr className="border-b border-border-warm bg-cream-light">
              <th className="px-3 py-2 text-left text-button-sm text-muted">書籍 ID</th>
              <th className="px-3 py-2 text-right text-button-sm text-muted">{m.colAction}</th>
            </tr>
          </thead>
          <tbody>
            {bookIds.map((bookId) => (
              <tr
                key={bookId}
                className="border-b border-border-warm last:border-0 hover:bg-cream-light"
                data-testid="ab-book-list-row"
              >
                <td className="px-3 py-2 font-mono text-caption text-muted">
                  {bookId.slice(0, 8)}…
                </td>
                <td className="px-3 py-2 text-right">
                  <Link
                    href={`/books/${bookId}`}
                    className="text-button-sm text-accent underline hover:text-accent/80"
                    data-testid="book-list-row-link"
                  >
                    {m.detailLink}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
