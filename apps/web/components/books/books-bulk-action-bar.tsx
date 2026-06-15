'use client';

/**
 * S-009 BulkActionBar (T-05-11 / docs/04 S-009).
 *
 * Phase 1: All bulk actions are placeholders (disabled with tooltips).
 * - "KDP 入稿チェックリストへ" -> Phase 3
 * - "一括 zip ダウンロード" -> deferred (high implementation cost)
 * - "コメント一括反映へ" -> SP-06
 */
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';

const m = messages.books.bulk;

interface BooksBulkActionBarProps {
  selectedIds: string[];
  onSelectionClear: () => void;
}

export function BooksBulkActionBar({
  selectedIds,
  onSelectionClear,
}: BooksBulkActionBarProps) {
  const selectionCount = selectedIds.length;

  return (
    <div
      data-testid="books-bulk-action-bar"
      className="sticky bottom-0 z-10 flex flex-wrap items-center gap-space-snug border-t-2 border-charcoal bg-cream-light px-space-relaxed py-space-snug shadow-l2-inset"
    >
      <span
        data-testid="books-bulk-selection-count"
        className="text-button font-medium text-charcoal"
      >
        {m.selectionCount(selectionCount)}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-space-snug">
        <Button
          type="button"
          variant="default"
          disabled
          title={m.kdpChecklistTooltip}
          data-testid="books-bulk-kdp-checklist"
        >
          {m.kdpChecklist}
        </Button>
        <Button
          type="button"
          variant="default"
          disabled
          title={m.zipDownloadTooltip}
          data-testid="books-bulk-zip-download"
        >
          {m.zipDownload}
        </Button>
        <Button
          type="button"
          variant="default"
          disabled
          title={m.commentBulkTooltip}
          data-testid="books-bulk-comment-apply"
        >
          {m.commentBulk}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={selectionCount === 0}
          onClick={onSelectionClear}
          data-testid="books-bulk-clear"
        >
          {m.clear}
        </Button>
      </div>
    </div>
  );
}
