'use client';

/**
 * YearMonthSelector — 年月選択コンポーネント (S-018, T-08-06).
 *
 * 直近 24 ヶ月のリストから選択する <select>。
 */
import { useId } from 'react';

import { messages } from '@/lib/messages';
import { cn } from '@/lib/cn';

const m = messages.salesManual.selector;

interface YearMonthSelectorProps {
  value: string;
  onChange: (ym: string) => void;
}

/** 当月を起点に過去 24 ヶ月のリストを生成 */
function buildMonthOptions(): Array<{ value: string; label: string }> {
  const now = new Date();
  const options: Array<{ value: string; label: string }> = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const value = `${year}-${month}`;
    options.push({ value, label: value });
  }
  return options;
}

export function YearMonthSelector({ value, onChange }: YearMonthSelectorProps) {
  const selectId = useId();
  const options = buildMonthOptions();

  return (
    <div>
      <label
        htmlFor={selectId}
        className="mb-1 block text-label text-foreground"
      >
        {m.yearMonthLabel}
      </label>
      <select
        id={selectId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full rounded-card border border-border-warm bg-cream px-3 py-2 text-body-sm text-charcoal',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          !value && 'text-muted',
        )}
        data-testid="year-month-selector"
      >
        <option value="" disabled>
          {m.yearMonthPlaceholder}
        </option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
