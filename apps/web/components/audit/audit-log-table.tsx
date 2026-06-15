'use client';

/**
 * S-029 AuditLogTable (T-09-03, F-029/F-046).
 *
 * 時刻 | アクター | アクション | 対象 | before→after 要約 | 展開
 * 各行クリックで JsonDiffExpander をインライン展開。
 * ページネーション付き。
 *
 * 仕様根拠: docs/04 S-029 / docs/wireframes/S-029-audit-log/prompt.md §Section 3
 */

import { useState, useCallback, useId, Fragment } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { messages } from '@/lib/messages';
import { type AuditLogSerialized } from '@/lib/audit-view';

import { JsonDiffExpander } from './json-diff-expander';

interface AuditLogTableProps {
  rows: AuditLogSerialized[];
  currentPage: number;
  totalRows: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

const m = messages.audit;
const mt = messages.audit.table;
const actionLabels = messages.audit.actionLabels;
const targetKindLabels = messages.audit.targetKindLabels;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AuditLogTable({
  rows,
  currentPage,
  totalRows,
  pageSize,
  onPageChange,
}: AuditLogTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const tableId = useId();

  const toggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const from = currentPage * pageSize + 1;
  const to = Math.min((currentPage + 1) * pageSize, totalRows);

  return (
    <div className="flex flex-col gap-space-snug" data-testid="audit-log-table">
      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-card border border-border-warm md:block">
        <table
          className="w-full table-auto text-body"
          aria-label="監査ログ"
          id={tableId}
        >
          <thead>
            <tr className="border-b border-border-warm bg-cream-light text-left text-button-sm text-muted">
              <th className="px-space-snug py-space-snug font-medium">{mt.colTime}</th>
              <th className="px-space-snug py-space-snug font-medium">{mt.colActor}</th>
              <th className="px-space-snug py-space-snug font-medium">{mt.colAction}</th>
              <th className="px-space-snug py-space-snug font-medium">{mt.colTarget}</th>
              <th className="px-space-snug py-space-snug font-medium">{mt.colSummary}</th>
              <th className="px-space-snug py-space-snug font-medium">{mt.colExpand}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const expanded = expandedId === row.id;
              const expandedPanelId = `audit-expand-${row.id}`;
              return (
                <Fragment key={row.id}>
                  <tr
                    className={`border-b border-border-warm last:border-0 hover:bg-cream-light ${expanded ? 'bg-cream-light' : 'bg-white'}`}
                    data-testid={`audit-row-${row.id}`}
                  >
                    <td className="whitespace-nowrap px-space-snug py-space-snug tabular-nums text-caption text-muted">
                      <time dateTime={row.created_at}>{formatTime(row.created_at)}</time>
                    </td>
                    <td className="px-space-snug py-space-snug text-caption">
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                          row.actor_id !== null
                            ? 'bg-accent/10 text-accent'
                            : 'bg-muted/10 text-muted'
                        }`}
                      >
                        {row.actor_label}
                      </span>
                    </td>
                    <td className="px-space-snug py-space-snug text-caption">
                      <code className="rounded bg-cream-light px-1 py-0.5 font-mono text-[11px] text-charcoal">
                        {actionLabels[row.action] ?? row.action}
                      </code>
                    </td>
                    <td className="px-space-snug py-space-snug text-caption text-muted">
                      <span className="mr-1 font-medium text-charcoal">
                        {targetKindLabels[row.target_kind] ?? row.target_kind}
                      </span>
                      <span className="font-mono text-[11px] opacity-70">{row.target_id.slice(0, 20)}{row.target_id.length > 20 ? '…' : ''}</span>
                    </td>
                    <td className="max-w-xs px-space-snug py-space-snug text-caption text-muted">
                      <span className="line-clamp-2">{row.before_after_summary}</span>
                    </td>
                    <td className="px-space-snug py-space-snug">
                      <button
                        type="button"
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-foreground hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        onClick={() => toggle(row.id)}
                        aria-expanded={expanded}
                        aria-controls={expandedPanelId}
                        data-testid={`audit-expand-btn-${row.id}`}
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        <span>{expanded ? mt.collapseRow : mt.expandRow}</span>
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr
                      id={expandedPanelId}
                      data-testid={`audit-expand-panel-${row.id}`}
                    >
                      <td colSpan={6} className="p-0">
                        <JsonDiffExpander
                          beforeJson={row.before_json}
                          afterJson={row.after_json}
                          actorLabel={row.actor_label}
                          createdAt={row.created_at}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <ul className="flex flex-col gap-space-snug md:hidden" aria-label="監査ログ">
        {rows.map((row) => {
          const expanded = expandedId === row.id;
          const expandedPanelId = `audit-expand-mobile-${row.id}`;
          return (
            <li
              key={row.id}
              className="rounded-card border border-border-warm bg-white"
              data-testid={`audit-card-${row.id}`}
            >
              <div className="flex items-start justify-between gap-2 px-space-snug py-space-snug">
                <div className="flex flex-col gap-1 min-w-0">
                  <time
                    dateTime={row.created_at}
                    className="tabular-nums text-caption text-muted"
                  >
                    {formatTime(row.created_at)}
                  </time>
                  <div className="flex flex-wrap gap-1">
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                        row.actor_id !== null
                          ? 'bg-accent/10 text-accent'
                          : 'bg-muted/10 text-muted'
                      }`}
                    >
                      {row.actor_label}
                    </span>
                    <code className="rounded bg-cream-light px-1 py-0.5 font-mono text-[11px] text-charcoal">
                      {actionLabels[row.action] ?? row.action}
                    </code>
                  </div>
                  <p className="text-caption text-muted">
                    <span className="font-medium text-charcoal">
                      {targetKindLabels[row.target_kind] ?? row.target_kind}
                    </span>{' '}
                    <span className="font-mono text-[11px] opacity-70">
                      {row.target_id.slice(0, 16)}{row.target_id.length > 16 ? '…' : ''}
                    </span>
                  </p>
                  <p className="text-caption text-muted line-clamp-2">{row.before_after_summary}</p>
                </div>
                <button
                  type="button"
                  className="flex-shrink-0 rounded px-2 py-1 text-caption text-foreground hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => toggle(row.id)}
                  aria-expanded={expanded}
                  aria-controls={expandedPanelId}
                >
                  {expanded ? (
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  )}
                  <span className="sr-only">{expanded ? mt.collapseRow : mt.expandRow}</span>
                </button>
              </div>

              {expanded && (
                <div id={expandedPanelId}>
                  <JsonDiffExpander
                    beforeJson={row.before_json}
                    afterJson={row.after_json}
                    actorLabel={row.actor_label}
                    createdAt={row.created_at}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* Pagination */}
      {totalRows > pageSize && (
        <nav
          className="flex items-center justify-between rounded-card border border-border-warm bg-cream-light px-space-normal py-space-snug"
          aria-label="ページネーション"
        >
          <span className="text-caption text-muted">
            {mt.pagination(from, to, totalRows)}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded px-2 py-1 text-button-sm text-foreground hover:bg-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => onPageChange(currentPage - 1)}
              disabled={currentPage === 0}
              aria-label="前のページ"
            >
              {mt.prevPage}
            </button>
            <span className="px-2 text-button-sm tabular-nums text-muted">
              {currentPage + 1} / {totalPages}
            </span>
            <button
              type="button"
              className="rounded px-2 py-1 text-button-sm text-foreground hover:bg-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => onPageChange(currentPage + 1)}
              disabled={currentPage >= totalPages - 1}
              aria-label="次のページ"
            >
              {mt.nextPage}
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
