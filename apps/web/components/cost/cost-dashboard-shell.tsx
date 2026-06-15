'use client';

/**
 * S-024 CostDashboardShell (T-07-05).
 *
 * Client container managing period-filter state (Phase 1: current month only).
 * Receives pre-computed data from RSC page.
 */
import type { ReactNode } from 'react';

import { CsvExportButton } from './csv-export-button';

interface CostDashboardShellProps {
  year: number;
  month: number;
  children: ReactNode;
}

export function CostDashboardShell({ year, month, children }: CostDashboardShellProps) {
  return (
    <div className="flex flex-col gap-space-loose" data-testid="cost-dashboard-shell">
      <div className="flex flex-wrap items-center justify-between gap-space-snug">
        <div className="text-body text-muted">
          {`${year} 年 ${month} 月`}
        </div>
        <CsvExportButton year={year} month={month} />
      </div>
      {children}
    </div>
  );
}
