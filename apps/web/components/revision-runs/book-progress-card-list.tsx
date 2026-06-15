'use client';

/**
 * BookProgressCardList — S-014 書籍別進捗カード一覧 (T-06-09).
 *
 * Each card shows per-book comment processing progress.
 * SSE updates will be added in T-06-10. Phase 1 is static display.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { messages } from '@/lib/messages';
import type { BookProgress } from '@/lib/revision-runs-view';

const m = messages.revisionRuns.bookProgress;

interface BookProgressCardListProps {
  bookProgress: BookProgress[];
}

export function BookProgressCardList({ bookProgress }: BookProgressCardListProps) {
  if (bookProgress.length === 0) return null;

  return (
    <div
      data-testid="book-progress-card-list"
      className="flex flex-col gap-space-snug"
    >
      {bookProgress.map((bp) => (
        <Card key={bp.book_id} variant="compact" data-testid="book-progress-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-body font-medium">
              {bp.book_title}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              <div className="relative h-2 w-full rounded-pill bg-charcoal-04">
                <div
                  className="h-full rounded-pill bg-foreground transition-all duration-300"
                  style={{ width: `${Math.min(bp.percent, 100)}%` }}
                />
              </div>
              <div className="flex flex-wrap gap-x-space-relaxed text-caption text-charcoal-82">
                <span>{m.applied}: {bp.applied}</span>
                <span>{m.notApplicable}: {bp.not_applicable}</span>
                <span>{m.pending}: {bp.pending}</span>
                <span>({bp.percent}%)</span>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
