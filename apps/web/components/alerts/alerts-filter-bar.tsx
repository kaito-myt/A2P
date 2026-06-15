'use client';

/**
 * S-028 AlertsFilterBar (T-07-08).
 *
 * Filter controls: kind, severity, status (read/unread, resolved/unresolved).
 */
import { messages } from '@/lib/messages';
import type { AlertsPageFilter, AlertStatusFilter } from '@/lib/alerts-view';

const m = messages.alerts;

interface AlertsFilterBarProps {
  filter: AlertsPageFilter;
  onFilterChange: (key: keyof AlertsPageFilter, value: string | undefined) => void;
}

export function AlertsFilterBar({
  filter,
  onFilterChange,
}: AlertsFilterBarProps) {
  const kindOptions: { value: string; label: string }[] = [
    { value: '', label: m.filter.kindAll },
    ...Object.entries(m.kindLabels).map(([value, label]) => ({
      value,
      label: label as string,
    })),
  ];

  return (
    <div
      data-testid="alerts-filter-bar"
      className="flex flex-wrap items-end gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-snug"
    >
      {/* Kind */}
      <FilterSelect
        testId="filter-kind"
        label={m.filter.kindLabel}
        value={filter.kind ?? ''}
        onChange={(v) => onFilterChange('kind', v || undefined)}
        options={kindOptions}
      />

      {/* Severity */}
      <FilterSelect
        testId="filter-severity"
        label={m.filter.severityLabel}
        value={filter.severity ?? ''}
        onChange={(v) => onFilterChange('severity', v || undefined)}
        options={[
          { value: '', label: m.filter.severityAll },
          { value: 'critical', label: (m.severityLabels as Record<string, string>)['critical'] ?? 'critical' },
          { value: 'warning', label: (m.severityLabels as Record<string, string>)['warning'] ?? 'warning' },
          { value: 'info', label: (m.severityLabels as Record<string, string>)['info'] ?? 'info' },
        ]}
      />

      {/* Status */}
      <FilterSelect
        testId="filter-status"
        label={m.filter.statusLabel}
        value={(filter.status as string) ?? ''}
        onChange={(v) => onFilterChange('status', (v || undefined) as AlertStatusFilter | undefined)}
        options={[
          { value: '', label: m.filter.statusAll },
          { value: 'unread', label: m.filter.statusUnread },
          { value: 'read', label: m.filter.statusRead },
          { value: 'unresolved', label: m.filter.statusUnresolved },
          { value: 'resolved', label: m.filter.statusResolved },
        ]}
      />
    </div>
  );
}

interface FilterSelectProps {
  testId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}

function FilterSelect({ testId, label, value, onChange, options }: FilterSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={testId}
        className="text-button-sm text-muted"
      >
        {label}
      </label>
      <select
        id={testId}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-default border border-border-warm bg-cream-light px-3 py-1.5 text-button-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
