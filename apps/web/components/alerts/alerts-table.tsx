'use client';

/**
 * S-028 AlertsTable (T-07-08).
 *
 * Table with checkbox selection, kind icons, severity badges, message, links.
 */
import Link from 'next/link';

import { messages } from '@/lib/messages';
import type { AlertRowSerialized } from '@/lib/alerts-view';
import {
  formatDateTime,
  getKindLabel,
  getSeverityLabel,
  getSeverityColor,
  getKindIcon,
  getKindIconColor,
  getAlertLink,
  getAlertLinkLabel,
} from '@/lib/alerts-view';

const m = messages.alerts.table;

interface AlertsTableProps {
  rows: AlertRowSerialized[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (selectAll: boolean) => void;
}

export function AlertsTable({
  rows,
  selectedIds,
  onToggle,
  onToggleAll,
}: AlertsTableProps) {
  const allIds = rows.map((r) => r.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));

  if (rows.length === 0) {
    return (
      <div
        data-testid="alerts-table-empty"
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
      >
        <p className="text-body text-muted">
          {messages.alerts.empty.title}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="alerts-table" className="overflow-x-auto rounded-card border border-border-warm">
      <table className="w-full text-left text-button-sm">
        <thead>
          <tr className="border-b border-border-warm bg-cream">
            <th className="w-10 px-3 py-2">
              <input
                type="checkbox"
                data-testid="alerts-select-all"
                checked={allSelected}
                onChange={(e) => onToggleAll(e.target.checked)}
                className="h-4 w-4 accent-charcoal"
                aria-label={m.checkbox}
              />
            </th>
            <th className="px-3 py-2 text-muted">{m.createdAt}</th>
            <th className="px-3 py-2 text-muted">{m.kind}</th>
            <th className="px-3 py-2 text-muted">{m.severity}</th>
            <th className="px-3 py-2 text-muted">{m.message}</th>
            <th className="px-3 py-2 text-muted">{m.link}</th>
            <th className="px-3 py-2 text-muted">{m.status}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isSelected = selectedIds.has(row.id);
            const linkHref = getAlertLink(row.kind);
            const linkLabel = getAlertLinkLabel(row.kind);
            const isRead = !!row.read_at;
            const isResolved = !!row.resolved_at;

            return (
              <tr
                key={row.id}
                data-testid={`alert-row-${row.id}`}
                className={`border-b border-border-warm transition-colors hover:bg-cream ${
                  isSelected ? 'bg-cream' : ''
                } ${!isRead ? 'font-medium' : ''}`}
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    data-testid={`alert-checkbox-${row.id}`}
                    checked={isSelected}
                    onChange={() => onToggle(row.id)}
                    className="h-4 w-4 accent-charcoal"
                    aria-label={`${m.checkbox} ${row.id}`}
                  />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-charcoal-82">
                  {formatDateTime(row.created_at)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs font-bold ${getKindIconColor(row.kind)}`}
                    title={getKindLabel(row.kind)}
                  >
                    {getKindIcon(row.kind)}
                  </span>
                  <span className="ml-2 text-charcoal-82">
                    {getKindLabel(row.kind)}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${getSeverityColor(row.severity)}`}
                  >
                    {getSeverityLabel(row.severity)}
                  </span>
                </td>
                <td className="max-w-xs truncate px-3 py-2 text-charcoal">
                  {row.message}
                </td>
                <td className="px-3 py-2">
                  {linkLabel && (
                    <Link
                      href={linkHref}
                      className="text-button-sm text-foreground underline hover:no-underline"
                      data-testid={`alert-link-${row.id}`}
                    >
                      {linkLabel}
                    </Link>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <span
                      className={`text-xs ${isRead ? 'text-charcoal-82' : 'text-destructive font-medium'}`}
                    >
                      {isRead ? m.statusRead : m.statusUnread}
                    </span>
                    <span
                      className={`text-xs ${isResolved ? 'text-charcoal-82' : 'text-amber-700 font-medium'}`}
                    >
                      {isResolved ? m.statusResolved : m.statusUnresolved}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
