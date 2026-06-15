'use client';

/**
 * S-012 CoverBulkActionBar (T-05-10, F-019).
 *
 * Actions:
 *  - "選択候補を一括採用": bulkAdoptCovers SA
 *  - "全候補を再生成": regenerateCover SA for each selected book
 *  - "カバーテキスト再生成": regenerateCoverText SA for each selected book
 *  - "選択解除": clear selection
 *
 * Pattern: same as outline-bulk-action-bar.tsx
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  bulkAdoptCovers,
  regenerateCover,
  regenerateCoverText,
} from '@/app/actions/covers';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';

const m = messages.covers;

interface CoverBulkActionBarProps {
  /** Cover IDs eligible for adoption (one per selected book). */
  selectedCoverIds: string[];
  /** Book IDs of selected books (for regenerate actions). */
  selectedBookIds: string[];
  onSelectionClear: () => void;
}

export function CoverBulkActionBar({
  selectedCoverIds,
  selectedBookIds,
  onSelectionClear,
}: CoverBulkActionBarProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const canAct = selectedCoverIds.length > 0;

  function handleAdopt() {
    setError(null);
    setInfo(null);
    if (!canAct) {
      setError(m.errors.noSelection);
      return;
    }
    startTransition(async () => {
      const result = await bulkAdoptCovers({
        cover_ids: selectedCoverIds,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setInfo(m.bulkAdoptSuccess(result.data.adopted));
      onSelectionClear();
      router.refresh();
    });
  }

  function handleRegenerateAll() {
    setError(null);
    setInfo(null);
    if (selectedBookIds.length === 0) {
      setError(m.errors.noSelection);
      return;
    }
    startTransition(async () => {
      let successCount = 0;
      let lastError: string | null = null;
      for (const bookId of selectedBookIds) {
        const result = await regenerateCover({ book_id: bookId });
        if (result.ok) {
          successCount++;
        } else {
          lastError = result.error.message;
        }
      }
      if (lastError && successCount === 0) {
        setError(lastError);
        return;
      }
      setInfo(m.regenerateSuccess);
      onSelectionClear();
      router.refresh();
    });
  }

  function handleRegenerateText() {
    setError(null);
    setInfo(null);
    if (selectedBookIds.length === 0) {
      setError(m.errors.noSelection);
      return;
    }
    startTransition(async () => {
      let successCount = 0;
      let lastError: string | null = null;
      for (const bookId of selectedBookIds) {
        const result = await regenerateCoverText({ book_id: bookId });
        if (result.ok) {
          successCount++;
        } else {
          lastError = result.error.message;
        }
      }
      if (lastError && successCount === 0) {
        setError(lastError);
        return;
      }
      setInfo(m.regenerateTextSuccess);
      onSelectionClear();
      router.refresh();
    });
  }

  return (
    <div
      data-testid="cover-bulk-action-bar"
      className="sticky bottom-0 z-10 flex flex-wrap items-center gap-space-snug border-t-2 border-charcoal bg-cream-light px-space-relaxed py-space-snug shadow-l2-inset"
    >
      <span
        data-testid="cover-bulk-selection-count"
        className="text-button font-medium text-charcoal"
      >
        {m.bulk.selectionCount(selectedBookIds.length)}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-space-snug">
        {error && (
          <span
            data-testid="cover-bulk-error"
            className="text-button-sm text-destructive"
          >
            {error}
          </span>
        )}
        {info && (
          <span
            data-testid="cover-bulk-info"
            className="text-button-sm text-success"
          >
            {info}
          </span>
        )}
        <Button
          type="button"
          variant="default"
          disabled={pending || !canAct}
          onClick={handleAdopt}
          data-testid="cover-bulk-adopt"
        >
          {m.bulk.adoptSelected}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || selectedBookIds.length === 0}
          onClick={handleRegenerateAll}
          data-testid="cover-bulk-regenerate"
        >
          {m.bulk.regenerateAll}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || selectedBookIds.length === 0}
          onClick={handleRegenerateText}
          data-testid="cover-bulk-regenerate-text"
        >
          {m.bulk.regenerateText}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending || selectedBookIds.length === 0}
          onClick={onSelectionClear}
          data-testid="cover-bulk-clear"
        >
          {m.bulk.clear}
        </Button>
      </div>
    </div>
  );
}
