'use client';

/**
 * RunHeader — S-014 実行ヘッダー (T-06-09).
 *
 * Title + status badge + triggered_at + books count + comments count + elapsed time.
 */
import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import type { RevisionRunSerialized } from '@/lib/revision-runs-view';
import {
  formatRunStatus,
  runStatusVariant,
  formatDateTime,
  formatElapsedTime,
} from '@/lib/revision-runs-view';

const m = messages.revisionRuns;

interface RunHeaderProps {
  run: RevisionRunSerialized;
}

export function RunHeader({ run }: RunHeaderProps) {
  return (
    <div data-testid="run-header" className="flex flex-col gap-space-snug">
      <h1 className="text-sub-heading text-foreground">
        {m.pageTitle} — {run.id.slice(0, 12)}
      </h1>

      <div
        className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 text-button-sm text-charcoal-82"
        data-testid="run-header-meta"
      >
        <span>
          {m.header.triggeredAtLabel}: {formatDateTime(run.triggered_at)}
        </span>
        <span>
          {m.header.booksLabel}: {run.book_ids.length} {m.header.booksSuffix}
        </span>
        <span>
          {m.header.commentsLabel}: {run.comment_ids.length} {m.header.commentsSuffix}
        </span>
        <Badge
          variant={runStatusVariant(run.status)}
          data-testid="run-status-badge"
        >
          {formatRunStatus(run.status)}
        </Badge>
        <span>
          {m.header.elapsedLabel}: {formatElapsedTime(run.triggered_at, run.finished_at)}
        </span>
      </div>
    </div>
  );
}
