'use client';

/**
 * S-028 AlertsPageShell (T-07-08).
 *
 * Client container that manages filter/selection state.
 * Receives serialized rows from RSC page.
 */
import { useCallback, useMemo, useState } from 'react';

import {
  filterAlerts,
  computeAlertsKpi,
  type AlertRowSerialized,
  type AlertsPageFilter,
} from '@/lib/alerts-view';

import { AlertsKpiStripe } from './alerts-kpi';
import { AlertsFilterBar } from './alerts-filter-bar';
import { AlertsTable } from './alerts-table';
import { AlertsBulkActionBar } from './alerts-bulk-action-bar';

interface AlertsPageShellProps {
  rows: AlertRowSerialized[];
}

export function AlertsPageShell({ rows }: AlertsPageShellProps) {
  const [filter, setFilter] = useState<AlertsPageFilter>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const filteredRows = useMemo(
    () => filterAlerts(rows, filter),
    [rows, filter],
  );

  const kpi = useMemo(
    () => computeAlertsKpi(rows),
    [rows],
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
        next.add(r.id);
      }
      setSelected(next);
    },
    [filteredRows],
  );

  const onClear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const handleFilterChange = useCallback(
    (key: keyof AlertsPageFilter, value: string | undefined) => {
      setFilter((prev) => ({ ...prev, [key]: value || undefined }));
    },
    [],
  );

  const selectedIds = useMemo(
    () => Array.from(selected).filter((id) =>
      filteredRows.some((r) => r.id === id),
    ),
    [selected, filteredRows],
  );

  return (
    <div className="flex flex-col gap-space-snug">
      <AlertsKpiStripe kpi={kpi} />

      <AlertsFilterBar
        filter={filter}
        onFilterChange={handleFilterChange}
      />

      <AlertsTable
        rows={filteredRows}
        selectedIds={selected}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
      />

      {selectedIds.length > 0 && (
        <AlertsBulkActionBar
          selectedIds={selectedIds}
          onSelectionClear={onClear}
        />
      )}
    </div>
  );
}
