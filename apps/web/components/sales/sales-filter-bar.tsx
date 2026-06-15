'use client';

/**
 * S-017 SalesFilterBar (T-08-07, F-039).
 *
 * 期間 / アカウント / ジャンル フィルタ。
 * フィルタ変更は searchParams を更新する (RSC の revalidation で反映)。
 * コスト詳細ダッシュボードの filter アプローチを踏襲。
 *
 * 仕様根拠: docs/04 S-017 / SP-08 T-08-07
 */

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import { Info } from 'lucide-react';

import { messages } from '@/lib/messages';

interface AccountOption {
  id: string;
  pen_name: string;
}

interface SalesFilterBarProps {
  accounts: AccountOption[];
  currentPeriod: string;
  currentAccountId: string;
  currentGenre: string;
}

const m = messages.salesKpi.filter;

export function SalesFilterBar({
  accounts,
  currentPeriod,
  currentAccountId,
  currentGenre,
}: SalesFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === '' || value === 'all') {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      // Reset page on filter change
      params.delete('page');
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    },
    [router, pathname, searchParams],
  );

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-space-snug rounded-card border border-border-warm bg-cream-light px-space-relaxed py-space-snug"
      data-testid="sales-filter-bar"
    >
      {/* Filter selects */}
      <div className="flex flex-wrap items-center gap-space-snug">
        {/* Period */}
        <label className="flex items-center gap-1.5">
          <span className="text-button-sm text-muted whitespace-nowrap">{m.periodLabel}</span>
          <select
            className="cursor-pointer rounded-card border border-border-warm bg-white px-2 py-1 text-body text-charcoal focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            value={currentPeriod}
            disabled={isPending}
            onChange={(e) => updateParam('period', e.target.value)}
            aria-label={m.periodLabel}
          >
            {m.periodOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        {/* Account */}
        <label className="flex items-center gap-1.5">
          <span className="text-button-sm text-muted whitespace-nowrap">{m.accountLabel}</span>
          <select
            className="cursor-pointer rounded-card border border-border-warm bg-white px-2 py-1 text-body text-charcoal focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            value={currentAccountId}
            disabled={isPending}
            onChange={(e) => updateParam('accountId', e.target.value)}
            aria-label={m.accountLabel}
          >
            <option value="all">{m.accountAll}</option>
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.pen_name}
              </option>
            ))}
          </select>
        </label>

        {/* Genre */}
        <label className="flex items-center gap-1.5">
          <span className="text-button-sm text-muted whitespace-nowrap">{m.genreLabel}</span>
          <select
            className="cursor-pointer rounded-card border border-border-warm bg-white px-2 py-1 text-body text-charcoal focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            value={currentGenre}
            disabled={isPending}
            onChange={(e) => updateParam('genre', e.target.value)}
            aria-label={m.genreLabel}
          >
            <option value="all">{m.genreAll}</option>
            {m.genreOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Phase 2 note */}
      <div
        className="flex items-center gap-1.5 text-caption text-muted"
        title={m.autoFetchTooltip}
      >
        <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{m.autoFetchNote}</span>
      </div>
    </div>
  );
}
