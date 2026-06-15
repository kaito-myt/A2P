'use client';

/**
 * S-013 CommentsPageShell (T-06-06).
 *
 * Client container that manages filter/group/selection state.
 * Receives serialized rows from RSC page.
 */
import { useCallback, useMemo, useState } from 'react';

import {
  filterCommentsPage,
  groupComments,
  computeKpi,
  type CommentRowSerialized,
  type CommentsPageFilter,
  type GroupByKey,
  type BookOption,
} from '@/lib/comments-view';

import { CommentsBulkActionBar } from './comments-bulk-action-bar';
import { CommentsFilterBar } from './comments-filter-bar';
import { CommentsSummaryKpi } from './comments-summary-kpi';
import { CommentsTable } from './comments-table';

interface CommentsPageShellProps {
  rows: CommentRowSerialized[];
  bookOptions: BookOption[];
}

export function CommentsPageShell({
  rows,
  bookOptions,
}: CommentsPageShellProps) {
  const [filter, setFilter] = useState<CommentsPageFilter>({});
  const [groupBy, setGroupBy] = useState<GroupByKey>('book');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const filteredRows = useMemo(
    () => filterCommentsPage(rows, filter),
    [rows, filter],
  );

  const kpi = useMemo(
    () => computeKpi(filteredRows),
    [filteredRows],
  );

  const groups = useMemo(
    () => groupComments(filteredRows, groupBy),
    [filteredRows, groupBy],
  );

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
      if (!selectAll) {
        setSelected(new Set());
        return;
      }
      const next = new Set<string>();
      for (const r of filteredRows) {
        if (r.status === 'pending') next.add(r.id);
      }
      setSelected(next);
    },
    [filteredRows],
  );

  const onClear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const handleFilterChange = useCallback(
    (key: keyof CommentsPageFilter, value: string | undefined) => {
      setFilter((prev) => ({ ...prev, [key]: value || undefined }));
    },
    [],
  );

  const selectedIds = useMemo(
    () => Array.from(selected).filter((id) =>
      filteredRows.some((r) => r.id === id && r.status === 'pending'),
    ),
    [selected, filteredRows],
  );

  const selectedRows = useMemo(
    () => filteredRows.filter((r) => selected.has(r.id)),
    [filteredRows, selected],
  );

  return (
    <div className="flex flex-col gap-space-snug">
      <CommentsSummaryKpi kpi={kpi} />

      <CommentsFilterBar
        filter={filter}
        onFilterChange={handleFilterChange}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        bookOptions={bookOptions}
      />

      <CommentsTable
        groups={groups}
        selectedIds={selected}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
      />

      {selectedIds.length > 0 && (
        <CommentsBulkActionBar
          selectedIds={selectedIds}
          selectedRows={selectedRows}
          onSelectionClear={onClear}
        />
      )}
    </div>
  );
}
