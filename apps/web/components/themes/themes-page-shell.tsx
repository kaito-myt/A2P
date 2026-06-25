'use client';

/**
 * S-006 ページ本体 (T-03-07).
 *
 * selection state を持つ Client コンポーネント。RSC (page.tsx) から行データだけ
 * 受け取り、テーブル + BulkActionBar を統括する。
 *
 * selection toggle 仕様:
 *  - pending 行のみ選択可能。pending 以外は checkbox disabled (table 側で制御)
 *  - 「全選択」は pending 行のみ対象
 *  - bulk SA 成功後は selection をクリアし router.refresh() で再取得
 */
import { useCallback, useMemo, useState } from 'react';

import { pickPendingIds, pickSelectedIds, type ThemeRowSerialized, type ThemeStatus } from '@/lib/themes-view';

import { BulkActionBar } from './bulk-action-bar';
import { ThemeCandidatesTable } from './theme-candidates-table';

interface ThemesPageShellProps {
  rows: readonly ThemeRowSerialized[];
}

type ThemeStatusFilter = ThemeStatus | 'all';

const STATUS_FILTER_OPTIONS: { value: ThemeStatusFilter; label: string }[] = [
  { value: 'pending', label: '未採用' },
  { value: 'accepted', label: '採用済み' },
  { value: 'rejected', label: '却下' },
  { value: 'all', label: 'すべて' },
];

export function ThemesPageShell({ rows }: ThemesPageShellProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // 既定は「未採用」のみ表示。採用済み・却下はフィルタで切り替える。
  const [statusFilter, setStatusFilter] = useState<ThemeStatusFilter>('pending');

  const visibleRows = useMemo(
    () => (statusFilter === 'all' ? rows : rows.filter((r) => r.status === statusFilter)),
    [rows, statusFilter],
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
      setSelected(() => {
        if (!selectAll) return new Set();
        const next = new Set<string>();
        for (const r of visibleRows) {
          if (r.status === 'pending') next.add(r.id);
        }
        return next;
      });
    },
    [visibleRows],
  );

  const onClear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const selectedIds = useMemo(() => pickSelectedIds(rows, selected), [rows, selected]);
  const selectedPendingIds = useMemo(
    () => pickPendingIds(rows, selected),
    [rows, selected],
  );

  return (
    <div className="flex flex-col gap-space-snug">
      <div className="flex items-center gap-2" data-testid="themes-status-filter-bar">
        <label htmlFor="themes-status-filter" className="text-button-sm text-muted">
          ステータス
        </label>
        <select
          id="themes-status-filter"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as ThemeStatusFilter);
            setSelected(new Set());
          }}
          data-testid="themes-status-filter"
          className="rounded-default border border-border-warm bg-cream-light px-3 py-1.5 text-button-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {STATUS_FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-caption text-muted">{visibleRows.length} 件</span>
      </div>

      <ThemeCandidatesTable
        rows={visibleRows}
        selectedIds={selected}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
      />
      {selectedIds.length > 0 && (
        <BulkActionBar
          selectedIds={selectedIds}
          selectedPendingIds={selectedPendingIds}
          onSelectionClear={onClear}
        />
      )}
    </div>
  );
}
