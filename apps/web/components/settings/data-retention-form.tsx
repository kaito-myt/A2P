'use client';

/**
 * DataRetentionForm — S-027 設定画面 データ管理セクション (T-07-09).
 *
 * Manages job_log_retention_days, r2_archive_threshold_days, ai_disclosure_text.
 */
import { useState, useCallback } from 'react';
import { CheckCircle, XCircle } from 'lucide-react';

import { updateSettings } from '@/app/actions/settings';
import { messages } from '@/lib/messages';

const m = messages.settings;
const ms = m.sections.dataRetention;

interface DataRetentionFormProps {
  initialData: {
    job_log_retention_days: number;
    r2_archive_threshold_days: number;
    ai_disclosure_text: string;
  };
}

export function DataRetentionForm({ initialData }: DataRetentionFormProps) {
  const [jobLogDays, setJobLogDays] = useState(String(initialData.job_log_retention_days));
  const [r2Days, setR2Days] = useState(String(initialData.r2_archive_threshold_days));
  const [aiText, setAiText] = useState(initialData.ai_disclosure_text);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, setIsPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const validateJobDays = useCallback((v: string): string | null => {
    const n = Number(v);
    if (!v || isNaN(n) || !Number.isFinite(n)) return '数値を入力してください';
    if (n < 7 || n > 365) return '7〜365 の値を入力してください';
    return null;
  }, []);

  const validateR2Days = useCallback((v: string): string | null => {
    const n = Number(v);
    if (!v || isNaN(n) || !Number.isFinite(n)) return '数値を入力してください';
    if (n < 30 || n > 3650) return '30〜3650 の値を入力してください';
    return null;
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const jobErr = validateJobDays(jobLogDays);
    if (jobErr) errs.jobLogDays = jobErr;
    const r2Err = validateR2Days(r2Days);
    if (r2Err) errs.r2Days = r2Err;
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setIsPending(true);
    setFeedback(null);
    const result = await updateSettings({
      job_log_retention_days: Number(jobLogDays),
      r2_archive_threshold_days: Number(r2Days),
      ai_disclosure_text: aiText,
    });
    setIsPending(false);
    if (result.ok) {
      setFeedback({ ok: true, msg: m.saveSuccess });
    } else {
      setFeedback({ ok: false, msg: result.error.message });
    }
  }, [jobLogDays, r2Days, aiText, validateJobDays, validateR2Days, m.saveSuccess]);

  return (
    <section
      aria-labelledby="data-retention-heading"
      className="rounded-card border border-border-warm bg-cream-light p-space-loose"
      data-testid="data-retention-form"
    >
      <div className="mb-space-snug">
        <h2
          id="data-retention-heading"
          className="text-sub-heading text-foreground"
        >
          {ms.title}
        </h2>
        <p className="text-body text-muted">{ms.subtitle}</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-space-snug">
        {/* Job log retention */}
        <div className="flex flex-col gap-1">
          <label htmlFor="job-log-days" className="text-body font-medium text-charcoal">
            {ms.jobLogRetentionLabel}
          </label>
          <input
            id="job-log-days"
            type="number"
            min={7}
            max={365}
            value={jobLogDays}
            onChange={(e) => setJobLogDays(e.target.value)}
            onBlur={() => setErrors((p) => ({ ...p, jobLogDays: validateJobDays(jobLogDays) ?? '' }))}
            className="w-40 rounded-button border border-border-warm bg-white px-3 py-2 text-body text-charcoal focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
          />
          <p className="text-button-sm text-muted">{ms.jobLogRetentionHint}</p>
          {errors.jobLogDays && (
            <p role="alert" className="text-button-sm text-destructive">{errors.jobLogDays}</p>
          )}
        </div>

        {/* R2 archive threshold */}
        <div className="flex flex-col gap-1">
          <label htmlFor="r2-days" className="text-body font-medium text-charcoal">
            {ms.r2ArchiveThresholdLabel}
          </label>
          <input
            id="r2-days"
            type="number"
            min={30}
            max={3650}
            value={r2Days}
            onChange={(e) => setR2Days(e.target.value)}
            onBlur={() => setErrors((p) => ({ ...p, r2Days: validateR2Days(r2Days) ?? '' }))}
            className="w-40 rounded-button border border-border-warm bg-white px-3 py-2 text-body text-charcoal focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
          />
          <p className="text-button-sm text-muted">{ms.r2ArchiveThresholdHint}</p>
          {errors.r2Days && (
            <p role="alert" className="text-button-sm text-destructive">{errors.r2Days}</p>
          )}
        </div>

        {/* AI disclosure text */}
        <div className="flex flex-col gap-1">
          <label htmlFor="ai-disclosure" className="text-body font-medium text-charcoal">
            {ms.aiDisclosureLabel}
          </label>
          <textarea
            id="ai-disclosure"
            value={aiText}
            onChange={(e) => setAiText(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder={ms.aiDisclosurePlaceholder}
            className="rounded-button border border-border-warm bg-white px-3 py-2 text-body text-charcoal placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
          />
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
