'use client';

/**
 * S-009 page shell (T-05-11). Manages selection state and
 * coordinates BooksTable + BooksBulkActionBar.
 */
import { useCallback, useMemo, useState } from 'react';

import type { BookRowSerialized } from '@/lib/books-view';

import { BooksBulkActionBar } from './books-bulk-action-bar';
import { BooksTable } from './books-table';

interface BooksPageShellProps {
  rows: readonly BookRowSerialized[];
}

export function BooksPageShell({ rows }: BooksPageShellProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const onToggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onToggleAll = useCallback(
    (selectAll: boolean) => {
      setSelected(() => {
        if (!selectAll) return new Set();
        return new Set(rows.map((r) => r.id));
      });
    },
    [rows],
  );

  const onClear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const selectedIds = useMemo(
    () => rows.filter((r) => selected.has(r.id)).map((r) => r.id),
    [rows, selected],
  );

  return (
    <div className="flex flex-col gap-space-snug">
      <BooksTable
        rows={rows}
        selectedIds={selected}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
      />
      {selectedIds.length > 0 && (
        <BooksBulkActionBar
          selectedIds={selectedIds}
          onSelectionClear={onClear}
        />
      )}
    </div>
  );
}
