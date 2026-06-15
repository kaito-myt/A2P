'use client';

/**
 * SalesInputForm — 売上入力フォーム (S-018, T-08-06).
 *
 * - インラインバリデーション (onBlur)
 * - 既存レコードがある場合はプリフィル (upsert モード)
 * - 保存成功/失敗のフィードバック (isPending with useState)
 *
 * 仕様根拠: docs/04 S-018 / SP-08 T-08-06
 */
import { useState, useEffect, useId } from 'react';
import { Save } from 'lucide-react';

import { messages } from '@/lib/messages';
import { upsertSales } from '@/app/actions/sales';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

const m = messages.salesManual;

interface SalesInputFormProps {
  bookId: string;
  yearMonth: string;
  prefill: {
    royalty_jpy: number;
    review_count: number;
    avg_stars: number | null;
    bsr: number | null;
  } | null;
  isUpsertMode: boolean;
  onSaveSuccess: () => void;
}

interface FormValues {
  royalty_jpy: string;
  review_count: string;
  avg_stars: string;
  bsr: string;
}

interface FormErrors {
  royalty_jpy?: string;
  review_count?: string;
  avg_stars?: string;
  bsr?: string;
  form?: string;
}

const EMPTY_VALUES: FormValues = {
  royalty_jpy: '',
  review_count: '',
  avg_stars: '',
  bsr: '',
};

export function SalesInputForm({
  bookId,
  yearMonth,
  prefill,
  isUpsertMode,
  onSaveSuccess,
}: SalesInputFormProps) {
  const formId = useId();
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isPending, setIsPending] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Prefill when existing data is loaded
  useEffect(() => {
    if (prefill) {
      setValues({
        royalty_jpy: String(prefill.royalty_jpy),
        review_count: String(prefill.review_count),
        avg_stars: prefill.avg_stars != null ? String(prefill.avg_stars) : '',
        bsr: prefill.bsr != null ? String(prefill.bsr) : '',
      });
    } else if (prefill === null) {
      // No existing record — clear form (but keep whatever user typed)
      if (!isUpsertMode) {
        setValues(EMPTY_VALUES);
      }
    }
    setErrors({});
    setSuccessMessage(null);
  }, [prefill, isUpsertMode]);

  // Clear when book/month changes
  useEffect(() => {
    if (!bookId || !yearMonth) {
      setValues(EMPTY_VALUES);
      setErrors({});
      setSuccessMessage(null);
    }
  }, [bookId, yearMonth]);

  function validateField(field: keyof FormValues, val: string): string | undefined {
    switch (field) {
      case 'royalty_jpy': {
        if (val.trim() === '') return m.form.validation.royaltyRequired;
        const n = Number(val);
        if (!Number.isInteger(n) || n < 0) return m.form.validation.royaltyMin;
        return undefined;
      }
      case 'review_count': {
        if (val.trim() === '') return undefined; // optional
        const n = Number(val);
        if (!Number.isInteger(n) || n < 0) return m.form.validation.reviewCountMin;
        return undefined;
      }
      case 'avg_stars': {
        if (val.trim() === '') return undefined; // optional
        const n = Number(val);
        if (isNaN(n) || n < 1 || n > 5) return m.form.validation.avgStarsRange;
        return undefined;
      }
      case 'bsr': {
        if (val.trim() === '') return undefined; // optional
        const n = Number(val);
        if (!Number.isInteger(n) || n < 0) return m.form.validation.bsrMin;
        return undefined;
      }
    }
  }

  function handleBlur(field: keyof FormValues) {
    const err = validateField(field, values[field]);
    setErrors((prev) => ({ ...prev, [field]: err }));
  }

  function handleChange(field: keyof FormValues, val: string) {
    setValues((prev) => ({ ...prev, [field]: val }));
    // Clear field error on change
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
    setSuccessMessage(null);
  }

  function validateAll(): FormErrors {
    const errs: FormErrors = {};
    for (const field of ['royalty_jpy', 'review_count', 'avg_stars', 'bsr'] as const) {
      const err = validateField(field, values[field]);
      if (err) errs[field] = err;
    }
    if (!bookId) errs.form = m.form.validation.bookRequired;
    if (!yearMonth) errs.form = m.form.validation.yearMonthRequired;
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSuccessMessage(null);

    const validationErrors = validateAll();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setIsPending(true);
    setErrors({});

    try {
      const result = await upsertSales({
        book_id: bookId,
        year_month: yearMonth,
        royalty_jpy: parseInt(values.royalty_jpy, 10),
        review_count: values.review_count.trim() !== '' ? parseInt(values.review_count, 10) : 0,
        avg_stars: values.avg_stars.trim() !== '' ? parseFloat(values.avg_stars) : undefined,
        bsr: values.bsr.trim() !== '' ? parseInt(values.bsr, 10) : undefined,
      });

      if (!result.ok) {
        setErrors({ form: result.error.message ?? m.errors.unknown });
        return;
      }

      setSuccessMessage(isUpsertMode ? m.form.saveSuccessUpsert : m.form.saveSuccess);
      onSaveSuccess();
    } finally {
      setIsPending(false);
    }
  }

  function handleClear() {
    setValues(EMPTY_VALUES);
    setErrors({});
    setSuccessMessage(null);
  }

  const isDisabled = !bookId || !yearMonth || isPending;

  return (
    <section
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-surface p-4"
      aria-labelledby={`${formId}-heading`}
      data-testid="sales-input-form"
    >
      <h2 id={`${formId}-heading`} className="text-label text-foreground">
        {m.form.sectionTitle}
      </h2>

      {/* Form-level error */}
      {errors.form && (
        <div role="alert" className="flex items-center gap-2 rounded-card border border-destructive/40 bg-destructive/10 px-3 py-2 text-body-sm text-destructive">
          <AlertCircleIcon />
          {errors.form}
        </div>
      )}

      {/* Success message */}
      {successMessage && (
        <div role="status" aria-live="polite" className="rounded-card border border-green-300 bg-green-50 px-3 py-2 text-body-sm text-green-800">
          {successMessage}
        </div>
      )}

      <form id={formId} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        {/* ロイヤリティ */}
        <FormField
          id={`${formId}-royalty`}
          label={m.form.royaltyLabel}
          required
          error={errors.royalty_jpy}
        >
          <input
            id={`${formId}-royalty`}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            placeholder={m.form.royaltyPlaceholder}
            value={values.royalty_jpy}
            onChange={(e) => handleChange('royalty_jpy', e.target.value)}
            onBlur={() => handleBlur('royalty_jpy')}
            disabled={isDisabled}
            aria-required="true"
            aria-describedby={errors.royalty_jpy ? `${formId}-royalty-err` : undefined}
            aria-invalid={!!errors.royalty_jpy}
            className={inputClass(!!errors.royalty_jpy, isDisabled)}
            data-testid="input-royalty"
          />
        </FormField>

        {/* レビュー件数 */}
        <FormField
          id={`${formId}-review-count`}
          label={m.form.reviewCountLabel}
          error={errors.review_count}
        >
          <input
            id={`${formId}-review-count`}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            placeholder={m.form.reviewCountPlaceholder}
            value={values.review_count}
            onChange={(e) => handleChange('review_count', e.target.value)}
            onBlur={() => handleBlur('review_count')}
            disabled={isDisabled}
            aria-describedby={errors.review_count ? `${formId}-review-count-err` : undefined}
            aria-invalid={!!errors.review_count}
            className={inputClass(!!errors.review_count, isDisabled)}
            data-testid="input-review-count"
          />
        </FormField>

        {/* 平均星 */}
        <FormField
          id={`${formId}-avg-stars`}
          label={m.form.avgStarsLabel}
          error={errors.avg_stars}
        >
          <input
            id={`${formId}-avg-stars`}
            type="number"
            inputMode="decimal"
            min={1}
            max={5}
            step={0.1}
            placeholder={m.form.avgStarsPlaceholder}
            value={values.avg_stars}
            onChange={(e) => handleChange('avg_stars', e.target.value)}
            onBlur={() => handleBlur('avg_stars')}
            disabled={isDisabled}
            aria-describedby={errors.avg_stars ? `${formId}-avg-stars-err` : undefined}
            aria-invalid={!!errors.avg_stars}
            className={inputClass(!!errors.avg_stars, isDisabled)}
            data-testid="input-avg-stars"
          />
        </FormField>

        {/* Amazon 順位 */}
        <FormField
          id={`${formId}-bsr`}
          label={m.form.bsrLabel}
          error={errors.bsr}
        >
          <input
            id={`${formId}-bsr`}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            placeholder={m.form.bsrPlaceholder}
            value={values.bsr}
            onChange={(e) => handleChange('bsr', e.target.value)}
            onBlur={() => handleBlur('bsr')}
            disabled={isDisabled}
            aria-describedby={errors.bsr ? `${formId}-bsr-err` : undefined}
            aria-invalid={!!errors.bsr}
            className={inputClass(!!errors.bsr, isDisabled)}
            data-testid="input-bsr"
          />
        </FormField>

        {/* Actions */}
        <div className="flex gap-3">
          <Button
            type="submit"
            disabled={isDisabled}
            data-testid="save-button"
            className="flex items-center gap-2"
          >
            <Save size={16} aria-hidden="true" />
            {isPending ? m.form.saving : m.form.saveButton}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={handleClear}
            data-testid="clear-button"
          >
            {m.form.clearButton}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface FormFieldProps {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}

function FormField({ id, label, required, error, children }: FormFieldProps) {
  const errId = `${id}-err`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-foreground">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        )}
      </label>
      {children}
      {error && (
        <span id={errId} role="alert" className="flex items-center gap-1 text-body-sm text-destructive">
          <AlertCircleIcon size={12} />
          {error}
        </span>
      )}
    </div>
  );
}

function inputClass(hasError: boolean, disabled: boolean) {
  return cn(
    'rounded-card border bg-cream px-3 py-2 text-body-sm text-charcoal',
    'placeholder:text-muted',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    hasError ? 'border-destructive' : 'border-border-warm',
    disabled && 'opacity-50 cursor-not-allowed',
  );
}

function AlertCircleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
  );
}
