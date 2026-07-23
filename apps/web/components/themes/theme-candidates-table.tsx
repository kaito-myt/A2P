'use client';

/**
 * S-006 テーマ候補テーブル (T-03-07 / F-017).
 *
 * 表示列: checkbox | title | hook (truncate) | target_reader | competitors |
 *         market_score | created_at | status | actions
 *
 * - 行クリック (アクション列以外) で selection toggle
 * - pending 以外はチェックボックス disabled (wireframes prompt + F-017 受入)
 * - ヘッダー全選択は **pending 行のみ** を対象
 * - data-testid: themes-table / theme-row-{id} / theme-checkbox-{id} /
 *   theme-title-{id} / theme-status-{id}
 */
import Link from 'next/link';

import { messages } from '@/lib/messages';
import {
  formatDateTime,
  pickSelectedIds,
  truncate,
  type ThemeRowSerialized,
} from '@/lib/themes-view';

import { ThemeStatusBadge } from './status-badge';

const m = messages.themes;

interface ThemeCandidatesTableProps {
  rows: readonly ThemeRowSerialized[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (selectAll: boolean) => void;
}

export function ThemeCandidatesTable({
  rows,
  selectedIds,
  onToggle,
  onToggleAll,
}: ThemeCandidatesTableProps) {
  const pendingRows = rows.filter((r) => r.status === 'pending');
  const allPendingSelected =
    pendingRows.length > 0 && pendingRows.every((r) => selectedIds.has(r.id));
  // 「現状の選択 ID 集合」が rows 順では正しく並ばないので、選択件数のみ pickSelectedIds で精査
  const selectedCount = pickSelectedIds(rows, selectedIds).length;

  return (
    <div
      data-testid="themes-table"
      className="overflow-x-auto rounded-card border border-border-warm"
    >
      <table className="w-full border-collapse text-body">
        <thead className="bg-charcoal-04">
          <tr>
            <Th align="left" className="w-10">
              <input
                type="checkbox"
                aria-label={m.bulk.accept}
                checked={allPendingSelected}
                disabled={pendingRows.length === 0}
                onChange={(e) => onToggleAll(e.currentTarget.checked)}
                data-testid="themes-select-all"
              />
            </Th>
            <Th>{m.table.title}</Th>
            <Th>{m.table.hook}</Th>
            <Th>{m.table.targetReader}</Th>
            <Th align="right" className="whitespace-nowrap">{m.table.competitors}</Th>
            <Th align="right" className="whitespace-nowrap">{m.table.marketScore}</Th>
            <Th className="whitespace-nowrap">{m.table.createdAt}</Th>
            <Th className="whitespace-nowrap">{m.table.status}</Th>
            <Th align="right" className="whitespace-nowrap">{m.table.actions}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const checked = selectedIds.has(r.id);
            const checkboxDisabled = r.status !== 'pending';
            return (
              <tr
                key={r.id}
                data-testid={`theme-row-${r.id}`}
                data-selected={checked ? 'true' : 'false'}
                className={`border-t border-border-warm ${
                  checked ? 'bg-charcoal-04' : ''
                }`}
              >
                <Td className="w-10">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={checkboxDisabled}
                    onChange={() => onToggle(r.id)}
                    aria-label={r.title}
                    data-testid={`theme-checkbox-${r.id}`}
                  />
                </Td>
                <Td>
                  <span
                    data-testid={`theme-title-${r.id}`}
                    className="font-medium text-charcoal"
                  >
                    {r.title}
                  </span>
                </Td>
                <Td>
                  <span className="text-body text-charcoal-82">
                    {r.hook ? truncate(r.hook, 60) : m.table.hookEmpty}
                  </span>
                </Td>
                <Td>{r.target_reader ?? m.table.targetReaderEmpty}</Td>
                <Td align="right" className="whitespace-nowrap tabular-nums">
                  {r.competitor_count}
                  {m.table.competitorsUnit}
                </Td>
                <Td align="right" className="whitespace-nowrap tabular-nums">
                  {r.market_score !== null ? r.market_score : m.table.marketScoreEmpty}
                </Td>
                <Td className="whitespace-nowrap tabular-nums">{formatDateTime(r.created_at)}</Td>
                <Td className="whitespace-nowrap">
                  <ThemeStatusBadge status={r.status} rowId={r.id} />
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  <Link
                    href={`/themes/${r.id}`}
                    className="text-charcoal underline-offset-4 hover:underline"
                    data-testid={`theme-detail-link-${r.id}`}
                  >
                    {m.detailLink}
                  </Link>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p
        className="border-t border-border-warm bg-charcoal-03 px-space-relaxed py-2 text-button-sm text-muted"
        data-testid="themes-table-footer"
      >
        {m.bulk.pendingOnlyHint} (
        {m.bulk.selectionCount(selectedCount)})
      </p>
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
