'use client';

/**
 * S-017 SalesKpiShell (T-08-07, F-039).
 *
 * クライアントシェル: フィルタバーと子コンポーネントを保持する。
 * フィルタ変更は searchParams 経由で RSC を再実行。
 *
 * 仕様根拠: docs/04 S-017 / SP-08 T-08-07
 */

import type { ReactNode } from 'react';

import { SalesFilterBar } from './sales-filter-bar';

interface AccountOption {
  id: string;
  pen_name: string;
}

interface SalesKpiShellProps {
  accounts: AccountOption[];
  currentPeriod: string;
  currentAccountId: string;
  currentGenre: string;
  children: ReactNode;
}

export function SalesKpiShell({
  accounts,
  currentPeriod,
  currentAccountId,
  currentGenre,
  children,
}: SalesKpiShellProps) {
  return (
    <div className="flex flex-col gap-space-loose" data-testid="sales-kpi-shell">
      <SalesFilterBar
        accounts={accounts}
        currentPeriod={currentPeriod}
        currentAccountId={currentAccountId}
        currentGenre={currentGenre}
      />
      {children}
    </div>
  );
}
