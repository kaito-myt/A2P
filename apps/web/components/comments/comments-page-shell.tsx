'use client';

/**
 * S-013 CommentsPageShell (T-06-06).
 *
 * Client container that manages filter/group/selection state.
 * Receives serialized rows from RSC page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  filterCommentsPage,
  groupComments,
  computeKpi,
  type CommentRowSerialized,
  type CommentsPageFilter,
  type GroupByKey,
  type BookOption,
} from '@/lib/comments-view';

import { messages } from '@/lib/messages';

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
  // 既定は「完了以外」= 未消化(pending) のみ表示。対応済み(applied/not_applicable)は
  // ステータスフィルタを「すべて」等に切り替えると見られる。
  const [filter, setFilter] = useState<CommentsPageFilter>({ status: 'pending' });
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

  // グループ単位の一括選択 (指定した未消化 ID 群を追加/除去)。
  const onToggleGroup = useCallback((ids: string[], selectAll: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selectAll) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

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

  // 全 pending 件数と選択状況 (グローバル全選択チェックボックスの状態算出)。
  const totalPending = useMemo(
    () => filteredRows.filter((r) => r.status === 'pending').length,
    [filteredRows],
  );
  const allSelected = totalPending > 0 && selectedIds.length === totalPending;
  const someSelected = selectedIds.length > 0 && !allSelected;

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

      <p className="text-caption text-muted" data-testid="comments-checkbox-hint">
        {messages.commentsPage.checkboxHint}
      </p>

      <SelectionToolbar
        totalPending={totalPending}
        selectedCount={selectedIds.length}
        allSelected={allSelected}
        someSelected={someSelected}
        onToggleAll={onToggleAll}
        onClear={onClear}
      />

      <CommentsTable
        groups={groups}
        selectedIds={selected}
        onToggle={onToggle}
        onToggleGroup={onToggleGroup}
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

const tm = messages.commentsPage.table;

/**
 * テーブル上部の一括選択ツールバー (標準的な位置)。
 * マスタ全選択チェックボックス + 選択件数 + 選択解除。
 */
function SelectionToolbar({
  totalPending,
  selectedCount,
  allSelected,
  someSelected,
  onToggleAll,
  onClear,
}: {
  totalPending: number;
  selectedCount: number;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: (selectAll: boolean) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected;
  }, [someSelected]);

  return (
    <div
      data-testid="comments-selection-toolbar"
      className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 rounded-card border border-border-warm bg-cream px-3 py-2"
    >
      <label className="flex cursor-pointer items-center gap-2 text-button-sm text-charcoal">
        <input
          ref={ref}
          type="checkbox"
          checked={allSelected}
          disabled={totalPending === 0}
          onChange={(e) => onToggleAll(e.target.checked)}
          aria-label={tm.selectAllAria}
          className="h-4 w-4 rounded border-charcoal-40 disabled:opacity-40"
          data-testid="select-all-checkbox"
        />
        <span>{tm.selectAllLabel(totalPending)}</span>
      </label>
      <span className="text-button-sm text-muted" data-testid="comments-selected-count">
        {tm.selectedCount(selectedCount)}
      </span>
      {selectedCount > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="text-button-sm text-accent underline underline-offset-2 hover:no-underline"
          data-testid="comments-clear-selection"
        >
          {tm.clearSelection}
        </button>
      )}
    </div>
  );
}
