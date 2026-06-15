'use client';

/**
 * S-021 ComparisonForm (T-13-05, F-026).
 *
 * モード・役割・期間/ID 選択フォーム。送信時に onSubmit で AbComparisonFilter を渡す。
 * @a2p/db を import しない。
 *
 * 仕様根拠: docs/04 §S-021 / SP-13 T-13-05
 */

import { useState } from 'react';

import { messages } from '@/lib/messages';
import type { AbComparisonFilterSerialized, AbComparisonMode } from '@/lib/ab-comparison-shared';

interface ComparisonFormProps {
  filter: AbComparisonFilterSerialized;
  onSubmit: (filter: AbComparisonFilterSerialized) => void;
}

const m = messages.abComparison.form;

export function ComparisonForm({ filter, onSubmit }: ComparisonFormProps) {
  const [mode, setMode] = useState<AbComparisonMode>(filter.mode);
  const [role, setRole] = useState(filter.role ?? 'writer');
  const [dateFromA, setDateFromA] = useState(
    filter.periodA ? filter.periodA.from : '',
  );
  const [dateToA, setDateToA] = useState(
    filter.periodA ? filter.periodA.to : '',
  );
  const [dateFromB, setDateFromB] = useState(
    filter.periodB ? filter.periodB.from : '',
  );
  const [dateToB, setDateToB] = useState(
    filter.periodB ? filter.periodB.to : '',
  );
  const [baselineId, setBaselineId] = useState(filter.baselineId ?? '');
  const [candidateId, setCandidateId] = useState(filter.candidateId ?? '');
  const [minSample, setMinSample] = useState(String(filter.minSample ?? 5));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const parsedMinSample = parseInt(minSample, 10);
    const safeMinSample = Number.isFinite(parsedMinSample) && parsedMinSample > 0
      ? parsedMinSample
      : 5;

    if (mode === 'period') {
      onSubmit({
        mode: 'period',
        periodA: { from: dateFromA, to: dateToA },
        periodB: { from: dateFromB, to: dateToB },
        minSample: safeMinSample,
      });
    } else {
      onSubmit({
        mode,
        role,
        baselineId,
        candidateId,
        minSample: safeMinSample,
      });
    }
  }

  const inputCls =
    'rounded-card border border-border-warm bg-white px-2 py-1.5 text-body text-foreground focus:outline focus:outline-2 focus:outline-accent';
  const labelCls = 'text-button-sm text-muted';
  const fieldCls = 'flex flex-col gap-1';

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-card border border-border-warm bg-cream-light p-space-snug"
      data-testid="ab-comparison-form"
    >
      <div className="flex flex-wrap gap-space-snug">
        {/* Mode */}
        <div className={fieldCls}>
          <label className={labelCls} htmlFor="ab-mode">
            {m.modeLabel}
          </label>
          <select
            id="ab-mode"
            className={inputCls}
            value={mode}
            onChange={(e) => setMode(e.target.value as AbComparisonMode)}
            data-testid="ab-mode-select"
          >
            {(Object.keys(m.modes) as Array<keyof typeof m.modes>).map((k) => (
              <option key={k} value={k}>
                {m.modes[k]}
              </option>
            ))}
          </select>
        </div>

        {/* Role (always shown for context) */}
        <div className={fieldCls}>
          <label className={labelCls} htmlFor="ab-role">
            {m.roleLabel}
          </label>
          <select
            id="ab-role"
            className={inputCls}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            data-testid="ab-role-select"
          >
            {(Object.keys(m.roles) as Array<keyof typeof m.roles>).map((k) => (
              <option key={k} value={k}>
                {m.roles[k]}
              </option>
            ))}
          </select>
        </div>

        {/* Min sample */}
        <div className={fieldCls}>
          <label className={labelCls} htmlFor="ab-min-sample">
            {m.minSampleLabel}
          </label>
          <input
            id="ab-min-sample"
            type="number"
            min={1}
            max={100}
            className={`${inputCls} w-20`}
            value={minSample}
            onChange={(e) => setMinSample(e.target.value)}
            data-testid="ab-min-sample-input"
          />
        </div>
      </div>

      {/* Period mode fields */}
      {mode === 'period' && (
        <div className="mt-space-snug grid grid-cols-1 gap-space-snug sm:grid-cols-2">
          <fieldset className="flex flex-col gap-space-snug rounded-card border border-border-warm p-space-snug">
            <legend className="text-button-sm text-muted">{m.periodALabel}</legend>
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="ab-date-from-a">
                {m.dateFromLabel}
              </label>
              <input
                id="ab-date-from-a"
                type="date"
                className={inputCls}
                value={dateFromA}
                onChange={(e) => setDateFromA(e.target.value)}
                data-testid="ab-date-from-a"
              />
            </div>
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="ab-date-to-a">
                {m.dateToLabel}
              </label>
              <input
                id="ab-date-to-a"
                type="date"
                className={inputCls}
                value={dateToA}
                onChange={(e) => setDateToA(e.target.value)}
                data-testid="ab-date-to-a"
              />
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-space-snug rounded-card border border-border-warm p-space-snug">
            <legend className="text-button-sm text-muted">{m.periodBLabel}</legend>
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="ab-date-from-b">
                {m.dateFromLabel}
              </label>
              <input
                id="ab-date-from-b"
                type="date"
                className={inputCls}
                value={dateFromB}
                onChange={(e) => setDateFromB(e.target.value)}
                data-testid="ab-date-from-b"
              />
            </div>
            <div className={fieldCls}>
              <label className={labelCls} htmlFor="ab-date-to-b">
                {m.dateToLabel}
              </label>
              <input
                id="ab-date-to-b"
                type="date"
                className={inputCls}
                value={dateToB}
                onChange={(e) => setDateToB(e.target.value)}
                data-testid="ab-date-to-b"
              />
            </div>
          </fieldset>
        </div>
      )}

      {/* Prompt / Model mode fields */}
      {mode !== 'period' && (
        <div className="mt-space-snug flex flex-wrap gap-space-snug">
          <div className={fieldCls}>
            <label className={labelCls} htmlFor="ab-baseline-id">
              {m.baselineIdLabel}
            </label>
            <input
              id="ab-baseline-id"
              type="text"
              className={`${inputCls} min-w-48`}
              placeholder={m.baselineIdPlaceholder}
              value={baselineId}
              onChange={(e) => setBaselineId(e.target.value)}
              data-testid="ab-baseline-id-input"
            />
          </div>
          <div className={fieldCls}>
            <label className={labelCls} htmlFor="ab-candidate-id">
              {m.candidateIdLabel}
            </label>
            <input
              id="ab-candidate-id"
              type="text"
              className={`${inputCls} min-w-48`}
              placeholder={m.candidateIdPlaceholder}
              value={candidateId}
              onChange={(e) => setCandidateId(e.target.value)}
              data-testid="ab-candidate-id-input"
            />
          </div>
        </div>
      )}

      <div className="mt-space-snug">
        <button
          type="submit"
          className="inline-flex cursor-pointer items-center rounded-card bg-charcoal px-4 py-2 text-button-sm text-white hover:bg-charcoal/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="ab-form-submit"
        >
          {m.submitButton}
        </button>
      </div>
    </form>
  );
}
