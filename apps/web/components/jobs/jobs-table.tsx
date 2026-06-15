'use client';

/**
 * S-025 JobsTable (T-09-01, F-045/F-046).
 *
 * 列: チェックボックス | ID | 種別 | 関連書籍 | ステータス | 開始 | 終了 | 経過 | リトライ回数 | エラー要約。
 * Row click → /jobs/[id]。
 * Pagination: 1 ページ = 25 件。
 * 選択行を親 (JobsPageShell) に通知。
 *
 * 仕様根拠: docs/04 S-025 / SP-09 T-09-01
 */

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronUp, ChevronDown } from 'lucide-react';

import { messages } from '@/lib/messages';
import { formatElapsedMs, type JobRowSerialized } from '@/lib/jobs-view';

const PAGE_SIZE = 25;

const m = messages.jobs.table;
const mKinds = messages.jobs.kindLabels;
const mStatus = messages.jobs.status;

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

function statusBadgeClass(status: string): string {
  switch (status as JobStatus) {
    case 'done':
      return 'bg-green-100 text-green-800';
    case 'running':
      return 'bg-blue-100 text-blue-800';
    case 'failed':
      return 'bg-red-100 text-red-800';
    case 'cancelled':
      return 'bg-gray-100 text-gray-600';
    case 'queued':
    default:
      return 'bg-amber-100 text-amber-800';
  }
}

function StatusBadge({ status }: { status: string }) {
  const label = mStatus[status as keyof typeof mStatus] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium ${statusBadgeClass(status)}`}
      aria-label={`ステータス: ${label}`}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface JobsTableProps {
  rows: JobRowSerialized[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  currentPage: number;
  onPageChange: (page: number) => void;
}

type SortKey = 'started_at' | 'elapsed_ms' | 'retries';
type SortDir = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function JobsTable({
  rows,
  selectedIds,
  onSelectionChange,
  currentPage,
  onPageChange,
}: JobsTableProps) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>('started_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'started_at') {
        const aVal = a.started_at ?? '';
        const bVal = b.started_at ?? '';
        cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      } else if (sortKey === 'elapsed_ms') {
        cmp = (a.elapsed_ms ?? -1) - (b.elapsed_ms ?? -1);
      } else if (sortKey === 'retries') {
        cmp = a.retries - b.retries;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages - 1);
  const pageRows = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const allPageSelected =
    pageRows.length > 0 && pageRows.every((r) => selectedIds.has(r.id));

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('desc');
      }
    },
    [sortKey],
  );

  const toggleAll = useCallback(() => {
    const next = new Set(selectedIds);
    if (allPageSelected) {
      for (const r of pageRows) next.delete(r.id);
    } else {
      for (const r of pageRows) next.add(r.id);
    }
    onSelectionChange(next);
  }, [allPageSelected, pageRows, selectedIds, onSelectionChange]);

  const toggleRow = useCallback(
    (id: string) => {
      const next = new Set(selectedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      onSelectionChange(next);
    },
    [selectedIds, onSelectionChange],
  );

  const handleRowClick = useCallback(
    (id: string, e: React.MouseEvent) => {
      // Don't navigate when clicking checkbox cell
      if ((e.target as HTMLElement).closest('[data-checkbox-cell]')) return;
      router.push(`/jobs/${id}`);
    },
    [router],
  );

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return null;
    return sortDir === 'asc' ? (
      <ChevronUp className="inline h-3.5 w-3.5" aria-hidden="true" />
    ) : (
      <ChevronDown className="inline h-3.5 w-3.5" aria-hidden="true" />
    );
  }

  function thClass(sortable = false) {
    return `px-3 py-2 text-left text-caption font-medium text-muted whitespace-nowrap${sortable ? ' cursor-pointer select-none hover:text-foreground' : ''}`;
  }

  const from = sorted.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const to = Math.min((safePage + 1) * PAGE_SIZE, sorted.length);

  return (
    <div className="flex flex-col gap-space-snug" data-testid="jobs-table">
      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-card border border-border-warm md:block">
        <table className="w-full text-sm">
          <thead className="bg-cream-light">
            <tr>
              <th className="px-3 py-2" data-checkbox-cell>
                <input
                  type="checkbox"
                  aria-label={m.selectAll}
                  checked={allPageSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer rounded accent-accent"
                />
              </th>
              <th className={thClass()}>ID</th>
              <th className={thClass()}>{m.colKind}</th>
              <th className={thClass()}>{m.colBook}</th>
              <th className={thClass()}>{m.colStatus}</th>
              <th
                className={thClass(true)}
                onClick={() => toggleSort('started_at')}
                aria-sort={
                  sortKey === 'started_at'
                    ? sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                {m.colStarted}
                <SortIcon col="started_at" />
              </th>
              <th className={thClass()}>{m.colFinished}</th>
              <th
                className={thClass(true)}
                onClick={() => toggleSort('elapsed_ms')}
                aria-sort={
                  sortKey === 'elapsed_ms'
                    ? sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                {m.colElapsed}
                <SortIcon col="elapsed_ms" />
              </th>
              <th
                className={thClass(true)}
                onClick={() => toggleSort('retries')}
                aria-sort={
                  sortKey === 'retries'
                    ? sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                {m.colRetries}
                <SortIcon col="retries" />
              </th>
              <th className={thClass()}>{m.colError}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-warm">
            {pageRows.map((row) => (
              <tr
                key={row.id}
                className={`cursor-pointer transition-colors hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${selectedIds.has(row.id) ? 'bg-amber-50' : ''}`}
                onClick={(e) => handleRowClick(row.id, e)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    router.push(`/jobs/${row.id}`);
                  }
                }}
                aria-selected={selectedIds.has(row.id)}
              >
                <td className="px-3 py-2" data-checkbox-cell onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`ジョブ ${row.id} を選択`}
                    checked={selectedIds.has(row.id)}
                    onChange={() => toggleRow(row.id)}
                    className="h-4 w-4 cursor-pointer rounded accent-accent"
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td className="px-3 py-2 font-mono text-caption text-muted">
                  {row.id.slice(0, 12)}...
                </td>
                <td className="px-3 py-2 text-body">
                  {mKinds[row.kind] ?? row.kind}
                </td>
                <td className="px-3 py-2 text-body text-muted">
                  {row.book_title ?? m.noBook}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={row.status} />
                </td>
                <td className="px-3 py-2 text-body tabular-nums text-muted">
                  {row.started_at ? formatDateTime(row.started_at) : m.noDate}
                </td>
                <td className="px-3 py-2 text-body tabular-nums text-muted">
                  {row.finished_at ? formatDateTime(row.finished_at) : m.noDate}
                </td>
                <td className="px-3 py-2 text-body tabular-nums">
                  {formatElapsedMs(row.elapsed_ms)}
                </td>
                <td className="px-3 py-2 text-body tabular-nums">
                  {row.retries}
                </td>
                <td className="px-3 py-2">
                  {row.error_summary ? (
                    <span className="text-caption text-red-700" title={row.error_summary}>
                      {row.error_summary.slice(0, 40)}
                      {row.error_summary.length > 40 ? '...' : ''}
                    </span>
                  ) : (
                    <span className="text-body text-muted">{m.noError}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="flex flex-col gap-space-snug md:hidden">
        {pageRows.map((row) => (
          <div
            key={row.id}
            className={`flex gap-3 rounded-card border border-border-warm p-space-snug ${selectedIds.has(row.id) ? 'bg-amber-50' : 'bg-white'}`}
          >
            <div className="pt-0.5">
              <input
                type="checkbox"
                aria-label={`ジョブ ${row.id} を選択`}
                checked={selectedIds.has(row.id)}
                onChange={() => toggleRow(row.id)}
                className="h-4 w-4 cursor-pointer rounded accent-accent"
              />
            </div>
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => router.push(`/jobs/${row.id}`)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-caption text-muted">
                  {row.id.slice(0, 12)}...
                </span>
                <StatusBadge status={row.status} />
              </div>
              <div className="mt-1 text-body font-medium">
                {mKinds[row.kind] ?? row.kind}
              </div>
              {row.book_title && (
                <div className="text-caption text-muted">{row.book_title}</div>
              )}
              <div className="mt-1 flex gap-3 text-caption tabular-nums text-muted">
                <span>{row.started_at ? formatDateTime(row.started_at) : m.noDate}</span>
                <span>{formatElapsedMs(row.elapsed_ms)}</span>
                <span>
                  {m.colRetries}: {row.retries}
                </span>
              </div>
              {row.error_summary && (
                <div className="mt-1 text-caption text-red-700">{row.error_summary}</div>
              )}
            </button>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {sorted.length > 0 && (
        <div className="flex items-center justify-between text-body text-muted">
          <span className="tabular-nums">
            {m.pagination(from, to, sorted.length)}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onPageChange(safePage - 1)}
              disabled={safePage === 0}
              className="rounded px-2 py-1 text-body hover:bg-cream-light disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              aria-label="前のページ"
            >
              {m.prevPage}
            </button>
            <button
              type="button"
              onClick={() => onPageChange(safePage + 1)}
              disabled={safePage >= totalPages - 1}
              className="rounded px-2 py-1 text-body hover:bg-cream-light disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              aria-label="次のページ"
            >
              {m.nextPage}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}
