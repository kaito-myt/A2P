'use client';

/**
 * PipelineSettingsForm — 出版パイプラインの各工程を AI 判断で自動パスするか設定するフォーム。
 *
 * テーマ選定 / アウトライン承認 / 本文承認 / サムネ承認 / KDP入稿 の On/Off に加え、
 * テーマ選定は 1日の生成数と方向性(フリーテキスト)を設定できる。updatePipelineSettings SA を呼ぶ。
 */
import { useState, useCallback } from 'react';
import { CheckCircle, XCircle } from 'lucide-react';

import { updatePipelineSettings } from '@/app/actions/pipeline-settings';
import { messages } from '@/lib/messages';
import type { PipelineSettingsView } from '@/lib/pipeline-settings-core';

const m = messages.pipelineSettings;

function Toggle({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground ${
        checked ? 'bg-foreground' : 'bg-border-warm'
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function StageRow({
  checked,
  onChange,
  title,
  help,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  help: string;
  testId: string;
}) {
  return (
    <div className="flex items-start justify-between gap-space-loose rounded-button border border-border-warm bg-white px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-body font-medium text-charcoal">{title}</span>
        <span className="text-button-sm text-muted">{help}</span>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} testId={testId} />
    </div>
  );
}

export function PipelineSettingsForm({ initial }: { initial: PipelineSettingsView }) {
  const [theme, setTheme] = useState(initial.autopass_theme_enabled);
  const [perDay, setPerDay] = useState(initial.pipeline_themes_per_day);
  const [direction, setDirection] = useState(initial.pipeline_theme_direction);
  const [outline, setOutline] = useState(initial.autopass_outline_enabled);
  const [content, setContent] = useState(initial.autopass_content_enabled);
  const [cover, setCover] = useState(initial.autopass_cover_enabled);
  const [kdp, setKdp] = useState(initial.autopass_kdp_enabled);
  const [isPending, setIsPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const clampPerDay = (n: number) => Math.max(1, Math.min(30, Math.round(n || 1)));

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setIsPending(true);
      setFeedback(null);
      const result = await updatePipelineSettings({
        autopass_theme_enabled: theme,
        pipeline_themes_per_day: clampPerDay(perDay),
        pipeline_theme_direction: direction,
        autopass_outline_enabled: outline,
        autopass_content_enabled: content,
        autopass_cover_enabled: cover,
        autopass_kdp_enabled: kdp,
      });
      setIsPending(false);
      setFeedback(result.ok ? { ok: true, msg: m.saved } : { ok: false, msg: result.error.message });
    },
    [theme, perDay, direction, outline, content, cover, kdp],
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-space-loose" data-testid="pipeline-settings-form">
      {/* テーマ選定 */}
      <section
        aria-labelledby="pipeline-theme-heading"
        className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-loose"
      >
        <h2 id="pipeline-theme-heading" className="text-sub-heading text-foreground">
          {m.themeHeading}
        </h2>
        <StageRow
          checked={theme}
          onChange={setTheme}
          title={m.themeAutoLabel}
          help={m.themeAutoHelp}
          testId="pipeline-autopass-theme"
        />
        <div className={`flex flex-col gap-2 ${theme ? '' : 'opacity-60'}`}>
          <label htmlFor="themes-per-day" className="text-body font-medium text-charcoal">
            {m.themesPerDayLabel}
          </label>
          <input
            id="themes-per-day"
            type="number"
            min={1}
            max={30}
            value={perDay}
            disabled={!theme}
            onChange={(e) => setPerDay(Number(e.target.value))}
            onBlur={() => setPerDay((v) => clampPerDay(v))}
            data-testid="pipeline-themes-per-day"
            className="w-28 rounded-button border border-border-warm bg-white px-3 py-2 text-body text-charcoal focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground disabled:cursor-not-allowed disabled:bg-gray-100 disabled:opacity-60"
          />
        </div>
        <div className={`flex flex-col gap-2 ${theme ? '' : 'opacity-60'}`}>
          <label htmlFor="theme-direction" className="text-body font-medium text-charcoal">
            {m.themeDirectionLabel}
          </label>
          <textarea
            id="theme-direction"
            rows={3}
            value={direction}
            disabled={!theme}
            onChange={(e) => setDirection(e.target.value)}
            placeholder={m.themeDirectionPlaceholder}
            data-testid="pipeline-theme-direction"
            className="w-full rounded-button border border-border-warm bg-white px-3 py-2 text-body text-charcoal focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground disabled:cursor-not-allowed disabled:bg-gray-100 disabled:opacity-60"
          />
          <p className="text-button-sm text-muted">{m.themeDirectionHelp}</p>
        </div>
      </section>

      {/* 承認ゲート */}
      <section
        aria-labelledby="pipeline-stages-heading"
        className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-loose"
      >
        <h2 id="pipeline-stages-heading" className="text-sub-heading text-foreground">
          {m.stagesHeading}
        </h2>
        <StageRow checked={outline} onChange={setOutline} title={m.outlineLabel} help={m.outlineHelp} testId="pipeline-autopass-outline" />
        <StageRow checked={content} onChange={setContent} title={m.contentLabel} help={m.contentHelp} testId="pipeline-autopass-content" />
        <StageRow checked={cover} onChange={setCover} title={m.coverLabel} help={m.coverHelp} testId="pipeline-autopass-cover" />
        <StageRow checked={kdp} onChange={setKdp} title={m.kdpLabel} help={m.kdpHelp} testId="pipeline-autopass-kdp" />
      </section>

      <div className="flex items-center gap-space-snug">
        <button
          type="submit"
          disabled={isPending}
          data-testid="pipeline-settings-save"
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
            {feedback.ok ? <CheckCircle aria-hidden="true" className="h-4 w-4" /> : <XCircle aria-hidden="true" className="h-4 w-4" />}
            {feedback.msg}
          </div>
        )}
      </div>
    </form>
  );
}
