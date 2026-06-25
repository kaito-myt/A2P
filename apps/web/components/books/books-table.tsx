'use client';

/**
 * S-009 BooksTable (T-05-11 / docs/04 S-009).
 *
 * Columns: checkbox | title | account | genre | status | cost | comments | updated_at | download | actions
 * Phase 1: status filter only (dropdown). Full filters deferred.
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { messages } from '@/lib/messages';
import {
  formatBookStatus,
  formatCostStatus,
  formatDateTime,
  formatGenre,
  findArtifactByKind,
  type BookRowSerialized,
  type BookStatus,
} from '@/lib/books-view';

import { ArtifactDownloadGroup } from './artifact-download-group';
import { BookStatusBadge } from './book-status-badge';
import { PublishStatusControl } from './publish-status-control';

const m = messages.books;

interface BooksTableProps {
  rows: readonly BookRowSerialized[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (selectAll: boolean) => void;
}

const STATUS_OPTIONS: Array<{ value: BookStatus | 'all'; label: string }> = [
  { value: 'all', label: m.filter.statusAll },
  { value: 'queued', label: m.status.queued },
  { value: 'running', label: m.status.running },
  { value: 'editing', label: m.status.editing },
  { value: 'content_review', label: m.status.content_review },
  { value: 'judging', label: m.status.judging },
  { value: 'thumbnail', label: m.status.thumbnail },
  { value: 'exporting', label: m.status.exporting },
  { value: 'done', label: m.status.done },
  { value: 'needs_human_review', label: m.status.needs_human_review },
  { value: 'failed', label: m.status.failed },
  { value: 'cancelled', label: m.status.cancelled },
  { value: 'paused_cost', label: m.status.paused_cost },
];

export function BooksTable({
  rows,
  selectedIds,
  onToggle,
  onToggleAll,
}: BooksTableProps) {
  const [statusFilter, setStatusFilter] = useState<BookStatus | 'all'>('all');

  const filteredRows = useMemo(() => {
    if (statusFilter === 'all') return rows;
    return rows.filter((r) => r.status === statusFilter);
  }, [rows, statusFilter]);

  const allSelected =
    filteredRows.length > 0 && filteredRows.every((r) => selectedIds.has(r.id));

  return (
    <div className="flex flex-col gap-space-snug">
      {/* Filter bar */}
      <div
        className="flex flex-wrap items-center gap-space-snug"
        data-testid="books-filter-bar"
      >
        <label className="flex items-center gap-2 text-button-sm text-charcoal-82">
          {m.filter.statusLabel}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as BookStatus | 'all')}
            className="rounded-button border border-border-warm bg-cream-light px-3 py-1.5 text-button-sm text-charcoal"
            data-testid="books-status-filter"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-button-sm text-muted" data-testid="books-total-count">
          {m.table.totalCount(filteredRows.length)}
        </span>
      </div>

      {/* Table */}
      <div
        data-testid="books-table"
        className="overflow-x-auto rounded-card border border-border-warm"
      >
        <table className="w-full border-collapse text-body">
          <thead className="bg-charcoal-04">
            <tr>
              <Th align="left" className="w-10">
                <input
                  type="checkbox"
                  aria-label={m.table.checkbox}
                  checked={allSelected}
                  disabled={filteredRows.length === 0}
                  onChange={(e) => onToggleAll(e.currentTarget.checked)}
                  data-testid="books-select-all"
                />
              </Th>
              <Th>{m.table.title}</Th>
              <Th>{m.table.account}</Th>
              <Th>{m.table.genre}</Th>
              <Th>{m.table.status}</Th>
              <Th>{m.table.publishStatus}</Th>
              <Th align="right">{m.table.costJpy}</Th>
              <Th>{m.table.commentCount}</Th>
              <Th>{m.table.updatedAt}</Th>
              <Th>{m.table.download}</Th>
              <Th align="right">{m.table.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => {
              const checked = selectedIds.has(row.id);
              return (
                <tr
                  key={row.id}
                  data-testid={`book-row-${row.id}`}
                  data-selected={checked ? 'true' : 'false'}
                  className={`border-t border-border-warm ${checked ? 'bg-charcoal-04' : ''}`}
                >
                  <Td className="w-10">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(row.id)}
                      aria-label={row.title}
                      data-testid={`book-checkbox-${row.id}`}
                    />
                  </Td>
                  <Td>
                    <Link
                      href={`/books/${row.id}`}
                      className="font-medium text-charcoal underline-offset-4 hover:underline"
                      data-testid={`book-title-${row.id}`}
                    >
                      {row.title}
                    </Link>
                  </Td>
                  <Td>{row.account.pen_name}</Td>
                  <Td>{formatGenre(row.genre) ?? '—'}</Td>
                  <Td>
                    <BookStatusBadge status={row.status} />
                  </Td>
                  <Td>
                    <PublishStatusControl bookId={row.id} value={row.publish_status} />
                  </Td>
                  <Td align="right">
                    <span
                      className={row.cost_jpy_total > 500 ? 'text-destructive font-medium' : ''}
                    >
                      {`¥${Math.round(row.cost_jpy_total).toLocaleString()}`}
                    </span>
                  </Td>
                  <Td>
                    {row.has_blocking_comments ? (
                      <Link
                        href={`/comments?priority=must&book=${row.id}`}
                        className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-button-sm text-destructive no-underline hover:underline"
                        data-testid={`book-blocking-badge-${row.id}`}
                      >
                        {m.table.blockingBadge}
                      </Link>
                    ) : row.has_pending_comments ? (
                      <Link
                        href={`/comments?book=${row.id}`}
                        className="inline-flex items-center rounded-full bg-charcoal-04 px-2 py-0.5 text-button-sm text-muted no-underline hover:underline"
                      >
                        {m.table.commentCount}
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td>{formatDateTime(row.updated_at)}</Td>
                  <Td>
                    <ArtifactDownloadGroup artifacts={row.artifacts} />
                  </Td>
                  <Td align="right">
                    <Link
                      href={`/books/${row.id}`}
                      className="text-charcoal underline-offset-4 hover:underline"
                      data-testid={`book-detail-link-${row.id}`}
                    >
                      {m.table.detailLink}
                    </Link>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-space-relaxed py-2 text-button-sm font-normal text-charcoal-82 ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${className ?? ''}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={`px-space-relaxed py-3 text-body align-middle ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${className ?? ''}`}
    >
      {children}
    </td>
  );
}
