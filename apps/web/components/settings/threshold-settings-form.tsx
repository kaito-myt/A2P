'use client';

/**
 * ThresholdSettingsForm — S-027 設定画面 コスト閾値セクション (T-07-09).
 *
 * Manages per-book warn/pause, monthly yellow/orange/red, catalog threshold.
 * Uses manual isPending state (NOT useTransition) per UI/UX requirement.
 */
import { useState, useCallback } from 'react';
import { CheckCircle, XCircle } from 'lucide-react';

import { updateSettings } from '@/app/actions/settings';
import { messages } from '@/lib/messages';

const m = messages.settings;
const ms = m.sections.threshold;

interface ThresholdSettingsFormProps {
  initialData: {
    cost_per_book_warn_jpy: number;
    cost_per_book_pause_jpy: number;
    monthly_cost_yellow_jpy: number;
    monthly_cost_orange_jpy: number;
    monthly_cost_red_jpy: number;
    catalog_price_change_threshold: number;
  };
}

type FieldValues = {
  cost_per_book_warn_jpy: string;
  cost_per_book_pause_jpy: string;
  monthly_cost_yellow_jpy: string;
  monthly_cost_orange_jpy: string;
  monthly_cost_red_jpy: string;
  catalog_price_change_threshold: string;
};

type FieldErrors = Partial<Record<keyof FieldValues, string>>;

export function ThresholdSettingsForm({ initialData }: ThresholdSettingsFormProps) {
  const [values, setValues] = useState<FieldValues>({
    cost_per_book_warn_jpy: String(initialData.cost_per_book_warn_jpy),
    cost_per_book_pause_jpy: String(initialData.cost_per_book_pause_jpy),
    monthly_cost_yellow_jpy: String(initialData.monthly_cost_yellow_jpy),
    monthly_cost_orange_jpy: String(initialData.monthly_cost_orange_jpy),
    monthly_cost_red_jpy: String(initialData.monthly_cost_red_jpy),
    catalog_price_change_threshold: String(
      Math.round(initialData.catalog_price_change_threshold * 100),
    ),
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [isPending, setIsPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const validateField = useCallback((field: keyof FieldValues, val: string): string | null => {
    const n = Number(val);
    if (!val || isNaN(n) || !Number.isFinite(n)) return '数値を入力してください';
    if (n <= 0) return '1 以上の値を入力してください';
    if (field === 'catalog_price_change_threshold') {
      if (n < 0 || n > 100) return '0〜100 の値を入力してください';
    }
    return null;
  }, []);

  const handleBlur = useCallback((field: keyof FieldValues) => {
    const err = validateField(field, values[field]);
    setErrors((prev) => ({ ...prev, [field]: err ?? undefined }));
  }, [values, validateField]);

  const handleChange = useCallback((field: keyof FieldValues, val: string) => {
    setValues((prev) => ({ ...prev, [field]: val }));
  }, []);

  const validate = useCallback((): FieldErrors | null => {
    const errs: FieldErrors = {};
    for (const field of Object.keys(values) as Array<keyof FieldValues>) {
      const err = validateField(field, values[field]);
      if (err) errs[field] = err;
    }
    // Cross-field
    const warn = Number(values.cost_per_book_warn_jpy);
    const pause = Number(values.cost_per_book_pause_jpy);
    if (warn >= pause) {
      errs.cost_per_book_warn_jpy = m.errors.perBookWarnGtPause;
    }
    const yellow = Number(values.monthly_cost_yellow_jpy);
    const orange = Number(values.monthly_cost_orange_jpy);
    const red = Number(values.monthly_cost_red_jpy);
    if (yellow >= orange || orange >= red) {
      errs.monthly_cost_yellow_jpy = m.errors.monthlyThresholdOrder;
    }
    return Object.keys(errs).length > 0 ? errs : null;
  }, [values, validateField, m.errors]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (errs) {
      setErrors(errs);
      return;
    }
    setIsPending(true);
    setFeedback(null);
    const result = await updateSettings({
      cost_per_book_warn_jpy: Number(values.cost_per_book_warn_jpy),
      cost_per_book_pause_jpy: Number(values.cost_per_book_pause_jpy),
      monthly_cost_yellow_jpy: Number(values.monthly_cost_yellow_jpy),
      monthly_cost_orange_jpy: Number(values.monthly_cost_orange_jpy),
      monthly_cost_red_jpy: Number(values.monthly_cost_red_jpy),
      catalog_price_change_threshold: Number(values.catalog_price_change_threshold) / 100,
    });
    setIsPending(false);
    if (result.ok) {
      setFeedback({ ok: true, msg: m.saveSuccess });
    } else {
      setFeedback({ ok: false, msg: result.error.message });
    }
  }, [values, validate, m.saveSuccess]);

  return (
    <section
      aria-labelledby="threshold-settings-heading"
      className="rounded-card border border-border-warm bg-cream-light p-space-loose"
      data-testid="threshold-settings-form"
    >
      <div className="mb-space-snug">
        <h2
          id="threshold-settings-heading"
          className="text-sub-heading text-foreground"
        >
          {ms.title}
        </h2>
        <p className="text-body text-muted">{ms.subtitle}</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-space-loose">
        {/* Per-book thresholds */}
        <fieldset className="flex flex-col gap-space-snug">
          <legend className="text-body font-medium text-charcoal">{ms.perBookSection}</legend>
          <NumberField
            id="cost-per-book-warn"
            label={ms.perBookWarnLabel}
            hint={ms.perBookWarnHint}
            value={values.cost_per_book_warn_jpy}
            error={errors.cost_per_book_warn_jpy}
            onChange={(v) => handleChange('cost_per_book_warn_jpy', v)}
            onBlur={() => handleBlur('cost_per_book_warn_jpy')}
          />
          <NumberField
            id="cost-per-book-pause"
            label={ms.perBookPauseLabel}
            hint={ms.perBookPauseHint}
            value={values.cost_per_book_pause_jpy}
            error={errors.cost_per_book_pause_jpy}
            onChange={(v) => handleChange('cost_per_book_pause_jpy', v)}
            onBlur={() => handleBlur('cost_per_book_pause_jpy')}
          />
        </fieldset>

        {/* Monthly thresholds */}
        <fieldset className="flex flex-col gap-space-snug">
          <legend className="text-body font-medium text-charcoal">{ms.monthlySection}</legend>
          <NumberField
            id="monthly-cost-yellow"
            label={ms.monthlyYellowLabel}
            hint={ms.monthlyYellowHint}
            value={values.monthly_cost_yellow_jpy}
            error={errors.monthly_cost_yellow_jpy}
            onChange={(v) => handleChange('monthly_cost_yellow_jpy', v)}
            onBlur={() => handleBlur('monthly_cost_yellow_jpy')}
          />
          <NumberField
            id="monthly-cost-orange"
            label={ms.monthlyOrangeLabel}
            hint={ms.monthlyOrangeHint}
            value={values.monthly_cost_orange_jpy}
            error={errors.monthly_cost_orange_jpy}
            onChange={(v) => handleChange('monthly_cost_orange_jpy', v)}
            onBlur={() => handleBlur('monthly_cost_orange_jpy')}
          />
          <NumberField
            id="monthly-cost-red"
            label={ms.monthlyRedLabel}
            hint={ms.monthlyRedHint}
            value={values.monthly_cost_red_jpy}
            error={errors.monthly_cost_red_jpy}
            onChange={(v) => handleChange('monthly_cost_red_jpy', v)}
            onBlur={() => handleBlur('monthly_cost_red_jpy')}
          />
        </fieldset>

        {/* Catalog threshold */}
        <fieldset className="flex flex-col gap-space-snug">
          <legend className="text-body font-medium text-charcoal">{ms.catalogSection}</legend>
          <NumberField
            id="catalog-threshold"
            label={ms.catalogThresholdLabel}
            hint={ms.catalogThresholdHint}
            value={values.catalog_price_change_threshold}
            error={errors.catalog_price_change_threshold}
            onChange={(v) => handleChange('catalog_price_change_threshold', v)}
            onBlur={() => handleBlur('catalog_price_change_threshold')}
            min={0}
            max={100}
            step={1}
          />
        </fieldset>

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

function NumberField({
  id,
  label,
  hint,
  value,
  error,
  onChange,
  onBlur,
  min,
  max,
  step = 1,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  error?: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-body font-medium text-charcoal">
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="w-40 rounded-button border border-border-warm bg-white px-3 py-2 text-body text-charcoal focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
      />
      <p className="text-button-sm text-muted">{hint}</p>
      {error && (
        <p role="alert" className="text-button-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
