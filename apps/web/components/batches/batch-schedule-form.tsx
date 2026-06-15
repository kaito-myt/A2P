'use client';

/**
 * S-008 バッチ設定フォーム (T-03-09, Client).
 *
 * 「スケジュール登録」/「即時キック」モードのラジオ + planned_at datetime-local
 * + concurrency セレクタ + deadline (任意) を扱う controlled form。
 *
 * 送信は親 (BatchesPageShell) の onSubmit に委譲し、SA 呼出 + redirect は
 * 親側で行う設計とする (Bulk SA パターン踏襲)。
 */
import { useCallback } from 'react';

import { Input } from '@/components/ui/input';
import { messages } from '@/lib/messages';

const m = messages.batches.schedule;

export type KickMode = 'scheduled' | 'now';

export interface BatchScheduleFormValues {
  kickMode: KickMode;
  /** datetime-local 形式の文字列 (空は未指定)。 */
  plannedAtLocal: string;
  concurrency: number;
  deadlineLocal: string;
}

interface BatchScheduleFormProps {
  values: BatchScheduleFormValues;
  onChange: (next: BatchScheduleFormValues) => void;
  disabled?: boolean;
}

export function BatchScheduleForm({
  values,
  onChange,
  disabled = false,
}: BatchScheduleFormProps) {
  const setKickMode = useCallback(
    (kickMode: KickMode) => {
      onChange({ ...values, kickMode });
    },
    [onChange, values],
  );

  const setPlannedAt = useCallback(
    (plannedAtLocal: string) => {
      onChange({ ...values, plannedAtLocal });
    },
    [onChange, values],
  );

  const setConcurrency = useCallback(
    (concurrency: number) => {
      onChange({ ...values, concurrency });
    },
    [onChange, values],
  );

  const setDeadline = useCallback(
    (deadlineLocal: string) => {
      onChange({ ...values, deadlineLocal });
    },
    [onChange, values],
  );

  return (
    <section
      data-testid="batch-schedule-form"
      className="rounded-card border border-border-warm bg-cream"
    >
      <header className="px-space-loose pt-space-loose">
        <h2 className="text-card-title text-foreground">{m.sectionTitle}</h2>
      </header>
      <div className="grid gap-space-snug px-space-loose pb-space-loose pt-space-snug">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-button-sm font-medium text-foreground">
            {m.kickModeLabel}
          </legend>
          <div className="flex flex-wrap gap-space-relaxed">
            <label className="flex items-center gap-2 text-button-sm text-charcoal">
              <input
                type="radio"
                name="kickMode"
                value="scheduled"
                checked={values.kickMode === 'scheduled'}
                onChange={() => setKickMode('scheduled')}
                disabled={disabled}
                data-testid="batch-kick-mode-radio-scheduled"
              />
              {m.kickModeScheduled}
            </label>
            <label className="flex items-center gap-2 text-button-sm text-charcoal">
              <input
                type="radio"
                name="kickMode"
                value="now"
                checked={values.kickMode === 'now'}
                onChange={() => setKickMode('now')}
                disabled={disabled}
                data-testid="batch-kick-mode-radio-now"
              />
              {m.kickModeNow}
            </label>
          </div>
        </fieldset>

        <label className="flex flex-col gap-1.5">
          <span className="text-button-sm font-medium text-foreground">
            {m.plannedAtLabel}
          </span>
          <Input
            type="datetime-local"
            value={values.plannedAtLocal}
            onChange={(e) => setPlannedAt(e.currentTarget.value)}
            disabled={disabled || values.kickMode === 'now'}
            data-testid="batch-scheduled-at-input"
          />
          <span className="text-caption text-muted">{m.plannedAtHint}</span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-button-sm font-medium text-foreground">
            {m.concurrencyLabel}
          </span>
          <select
            value={values.concurrency}
            onChange={(e) => setConcurrency(Number(e.currentTarget.value))}
            disabled={disabled}
            data-testid="batch-concurrency-select"
            className="h-10 rounded-default border border-border-warm bg-cream-light px-3 text-body text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="text-caption text-muted">{m.concurrencyHint}</span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-button-sm font-medium text-foreground">
            {m.deadlineLabel}
          </span>
          <Input
            type="datetime-local"
            value={values.deadlineLocal}
            onChange={(e) => setDeadline(e.currentTarget.value)}
            disabled={disabled}
            data-testid="batch-deadline-input"
          />
        </label>
      </div>
    </section>
  );
}
