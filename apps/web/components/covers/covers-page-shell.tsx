'use client';

/**
 * S-012 CoversPageShell (T-05-10).
 *
 * Client container managing:
 * - View mode toggle (bulk grid / single detail)
 * - Selection state (book-level, for bulk actions)
 * - Current book index (for single-detail navigation)
 *
 * Pattern: same as outlines-page-shell.tsx
 */
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { messages } from '@/lib/messages';
import {
  booksWithGeneratedCovers,
  pickEligibleCoverIds,
  type BookCoverGroup,
} from '@/lib/covers-view';

import { CoverBulkActionBar } from './cover-bulk-action-bar';
import { ThumbnailComparator } from './thumbnail-comparator';
import { ThumbnailGrid } from './thumbnail-grid';

const m = messages.covers;

type ViewMode = 'bulk' | 'single';

interface CoversPageShellProps {
  groups: readonly BookCoverGroup[];
}

export function CoversPageShell({ groups }: CoversPageShellProps) {
  const router = useRouter();
  const [mode, setMode] = useState<ViewMode>('bulk');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [singleBookIndex, setSingleBookIndex] = useState(0);

  const handleCommentChange = useCallback(() => {
    router.refresh();
  }, [router]);

  const onToggle = useCallback((bookId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }, []);

  const eligibleBookIds = useMemo(
    () => booksWithGeneratedCovers(groups),
    [groups],
  );

  const onToggleAll = useCallback(
    (selectAll: boolean) => {
      setSelected(() => {
        if (!selectAll) return new Set();
        return new Set(eligibleBookIds);
      });
    },
    [eligibleBookIds],
  );

  const onClear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const eligibleCoverIds = useMemo(
    () => pickEligibleCoverIds(groups, selected),
    [groups, selected],
  );

  const openSingleView = useCallback(
    (bookId: string) => {
      const idx = groups.findIndex((g) => g.book.id === bookId);
      if (idx >= 0) {
        setSingleBookIndex(idx);
        setMode('single');
      }
    },
    [groups],
  );

  const clampedIndex = Math.min(singleBookIndex, groups.length - 1);
  const currentGroup = groups[clampedIndex] ?? null;

  return (
    <div className="flex flex-col gap-space-snug">
      {/* Mode toggle */}
      <div
        className="flex items-center gap-space-relaxed"
        data-testid="covers-mode-toggle"
      >
        <label className="flex items-center gap-1 text-button-sm text-charcoal-82">
          <input
            type="radio"
            name="covers-mode"
            value="bulk"
            checked={mode === 'bulk'}
            onChange={() => setMode('bulk')}
          />
          {m.mode.bulkGrid}
        </label>
        <label className="flex items-center gap-1 text-button-sm text-charcoal-82">
          <input
            type="radio"
            name="covers-mode"
            value="single"
            checked={mode === 'single'}
            onChange={() => setMode('single')}
          />
          {m.mode.singleDetail}
        </label>
      </div>

      {mode === 'bulk' ? (
        <>
          <ThumbnailGrid
            groups={groups}
            selectedBookIds={selected}
            onToggle={onToggle}
            onToggleAll={onToggleAll}
            onOpenSingle={openSingleView}
          />
          {eligibleCoverIds.length > 0 && (
            <CoverBulkActionBar
              selectedCoverIds={eligibleCoverIds}
              selectedBookIds={Array.from(selected)}
              onSelectionClear={onClear}
            />
          )}
        </>
      ) : (
        currentGroup && (
          <ThumbnailComparator
            group={currentGroup}
            currentIndex={clampedIndex}
            totalCount={groups.length}
            onPrev={() =>
              setSingleBookIndex((i) => Math.max(0, i - 1))
            }
            onNext={() =>
              setSingleBookIndex((i) =>
                Math.min(groups.length - 1, i + 1),
              )
            }
            onBackToList={() => setMode('bulk')}
            onCommentChange={handleCommentChange}
          />
        )
      )}
    </div>
  );
}
