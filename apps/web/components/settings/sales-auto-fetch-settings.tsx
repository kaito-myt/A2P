'use client';

/**
 * SalesAutoFetchSettings — S-027 設定画面 売上自動取得セクション (T-12-08).
 *
 * トグル (sales_auto_fetch_enabled) + cron 入力 (sales_auto_fetch_cron) を管理する。
 * 既存 updateSettings SA を呼ぶ。
 * OFF 時は cron フィールドを disabled にする。
 * 無効な cron 式はフロント側バリデーションエラーで保存をブロックする。
 */
import { useState, useCallback } from 'react';
import { CheckCircle, XCircle, Info } from 'lucide-react';

import { updateSettings } from '@/app/actions/settings';
import { isValidCronExpression, nextCronRunJst } from '@/lib/cron-utils';
import { messages } from '@/lib/messages';

const m = messages.settings;
const ms = m.sections.salesAutoFetch;

interface SalesAutoFetchSettingsProps {
  initialEnabled: boolean;
  initialCron: string;
}

export function SalesAutoFetchSettings({
  initialEnabled,
  initialCron,
}: SalesAutoFetchSettingsProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [cron, setCron] = useState(initialCron);
  const [cronError, setCronError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const validateCron = useCallback((value: string): string | null => {
    if (!isValidCronExpression(value.trim())) {
      return ms.cronErrorInvalid;
    }
    return null;
  }, []);

  const handleToggle = useCallback((checked: boolean) => {
    setEnabled(checked);
    setFeedback(null);
    // Clear cron error when disabling
    if (!checked) setCronError(null);
  }, []);

  const handleCronChange = useCallback((value: string) => {
    setCron(value);
    setFeedback(null);
    // Validate on change
    if (enabled) {
      setCronError(validateCron(value));
    }
  }, [enabled, validateCron]);

  const handleCronBlur = useCallback(() => {
    if (enabled) {
      setCronError(validateCron(cron));
    }
  }, [cron, enabled, validateCron]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate cron if enabled
    if (enabled) {
      const err = validateCron(cron);
      if (err) {
        setCronError(err);
        return;
      }
    }

    setIsPending(true);
    setFeedback(null);

    const result = await updateSettings({
      sales_auto_fetch_enabled: enabled,
      sales_auto_fetch_cron: cron.trim(),
    });

    setIsPending(false);
    if (result.ok) {
      setFeedback({ ok: true, msg: m.saveSuccess });
    } else {
      setFeedback({ ok: false, msg: result.error.message });
    }
  }, [enabled, cron, validateCron]);

  const cronLabel = isValidCronExpression(cron.trim()) ? nextCronRunJst(cron.trim()) : null;

  return (
    <section
      aria-labelledby="sales-auto-fetch-heading"
      className="rounded-card border border-border-warm bg-cream-light p-space-loose"
      data-testid="sales-auto-fetch-settings"
    >
      <div className="mb-space-snug">
        <h2
          id="sales-auto-fetch-heading"
          className="text-sub-heading text-foreground"
        >
          {ms.title}
        </h2>
        <p className="text-body text-muted">{ms.subtitle}</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-space-loose">
        {/* Toggle */}
        <div className="flex flex-col gap-2">
          <label
            className="flex cursor-pointer items-center gap-3"
            data-testid="sales-auto-fetch-toggle-label"
          >
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={ms.enabledLabel}
              data-testid="sales-auto-fetch-toggle"
              onClick={() => handleToggle(!enabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground ${
                enabled ? 'bg-foreground' : 'bg-border-warm'
              }`}
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  enabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
            <span className="text-body text-charcoal">{ms.enabledLabel}</span>
          </label>
        </div>

        {/* Cron input */}
        <div className="flex flex-col gap-2">
          <label
            htmlFor="sales-auto-fetch-cron"
            className={`text-body font-medium ${enabled ? 'text-charcoal' : 'text-muted'}`}
          >
            {ms.cronLabel}
          </label>
          <input
            id="sales-auto-fetch-cron"
            type="text"
            value={cron}
            disabled={!enabled}
            onChange={(e) => handleCronChange(e.target.value)}
            onBlur={handleCronBlur}
            placeholder={ms.cronPlaceholder}
            data-testid="sales-auto-fetch-cron-input"
            className={`w-64 rounded-button border px-3 py-2 text-body text-charcoal focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground ${
              cronError
                ? 'border-destructive bg-white'
                : 'border-border-warm bg-white'
            } disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-muted disabled:opacity-60`}
          />
          <p className="text-button-sm text-muted">{ms.cronHint}</p>

          {/* Cron error */}
          {cronError && (
            <p role="alert" className="text-button-sm text-destructive" data-testid="cron-error">
              {cronError}
            </p>
          )}

          {/* Next run label */}
          {enabled && !cronError && cronLabel && (
            <p className="text-button-sm text-charcoal" data-testid="next-run-label">
              {ms.nextRunLabel}: {cronLabel}
            </p>
          )}
        </div>

        {/* Worker restart note */}
        <div className="flex items-start gap-2 rounded-button border border-border-warm bg-white px-3 py-2">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <p className="text-button-sm text-muted" data-testid="worker-restart-note">
            {ms.workerRestartNote}
          </p>
        </div>

        {/* Submit */}
        <div className="flex items-center gap-space-snug pt-2">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-button bg-foreground px-4 py-2 text-button-sm font-medium text-white disabled:opacity-50"
          >
            {isPending ? m.saving : m.saveButton}
          </button>
          {feedback && (
            <div
              role="status"
              aria-live="polite"
              className={`flex items-center gap-1 text-button-sm ${feedback.ok ? 'text-green-700' : 'text-destructive'}`}
            >
              {feedback.ok
                ? <CheckCircle aria-hidden="true" className="h-4 w-4" />
                : <XCircle aria-hidden="true" className="h-4 w-4" />}
              {feedback.msg}
            </div>
          )}
        </div>
      </form>
    </section>
  );
}
