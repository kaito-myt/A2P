'use client';

/**
 * OrgAutomationSettings — 経営ダッシュボード「自律運用設定」セクション。
 *
 * CEO自動計画 / タスク自動実行 / 障害自己復旧 / 予算ガード / KDP事前審査 の
 * 5 フラグ(org_*_enabled)を On/Off し、それぞれの cron スケジュールを編集する。
 * updateOrgAutomation SA を呼ぶ。cron は worker 起動時 (fetchAppSettingsForCron) に
 * しか読まれないため、変更の反映には worker 再起動が必要（ノートで明示）。
 */
import { useCallback, useState } from 'react';
import { CheckCircle, Info, XCircle } from 'lucide-react';

import { updateOrgAutomation } from '@/app/actions/org-automation';
import { isValidCronExpression, nextCronRunJst } from '@/lib/cron-utils';
import { messages } from '@/lib/messages';
import type { OrgAutomationView } from '@/lib/org-automation-core';

const m = messages.orgAutomation;

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

function AutomationRow({
  enabled,
  onToggle,
  cron,
  onCronChange,
  onCronBlur,
  cronError,
  label,
  help,
  testId,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  cron: string;
  onCronChange: (v: string) => void;
  onCronBlur: () => void;
  cronError: string | null;
  label: string;
  help: string;
  testId: string;
}) {
  const nextRun = enabled && !cronError && isValidCronExpression(cron.trim()) ? nextCronRunJst(cron.trim()) : null;
  return (
    <div className="flex flex-col gap-2 rounded-button border border-border-warm bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-space-loose">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-body font-medium text-charcoal">{label}</span>
          <span className="text-button-sm text-muted">{help}</span>
        </div>
        <Toggle checked={enabled} onChange={onToggle} label={label} testId={`${testId}-toggle`} />
      </div>
      <div className={`flex flex-col gap-1 ${enabled ? '' : 'opacity-60'}`}>
        <label htmlFor={`${testId}-cron`} className="text-button-sm font-medium text-charcoal">
          {m.cronLabel}
        </label>
        <input
          id={`${testId}-cron`}
          type="text"
          value={cron}
          disabled={!enabled}
          onChange={(e) => onCronChange(e.target.value)}
          onBlur={onCronBlur}
          data-testid={`${testId}-cron-input`}
          className={`w-56 rounded-button border px-3 py-1.5 text-button-sm text-charcoal focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground disabled:cursor-not-allowed disabled:bg-gray-100 disabled:opacity-60 ${
            cronError ? 'border-destructive bg-white' : 'border-border-warm bg-cream-light'
          }`}
        />
        {cronError && (
          <p role="alert" className="text-button-sm text-destructive" data-testid={`${testId}-cron-error`}>
            {cronError}
          </p>
        )}
        {nextRun && (
          <p className="text-button-sm text-muted" data-testid={`${testId}-next-run`}>
            {m.nextRunLabel}: {nextRun}
          </p>
        )}
      </div>
    </div>
  );
}

export function OrgAutomationSettings({ initial }: { initial: OrgAutomationView }) {
  const [planEnabled, setPlanEnabled] = useState(initial.org_auto_plan_enabled);
  const [planCron, setPlanCron] = useState(initial.org_plan_cron);
  const [planCronError, setPlanCronError] = useState<string | null>(null);

  const [executeEnabled, setExecuteEnabled] = useState(initial.org_auto_execute_enabled);
  const [executeCron, setExecuteCron] = useState(initial.org_execute_cron);
  const [executeCronError, setExecuteCronError] = useState<string | null>(null);

  const [opsWatchEnabled, setOpsWatchEnabled] = useState(initial.org_ops_watch_enabled);
  const [opsWatchCron, setOpsWatchCron] = useState(initial.org_ops_watch_cron);
  const [opsWatchCronError, setOpsWatchCronError] = useState<string | null>(null);

  const [financeTickEnabled, setFinanceTickEnabled] = useState(initial.org_finance_tick_enabled);
  const [financeTickCron, setFinanceTickCron] = useState(initial.org_finance_tick_cron);
  const [financeTickCronError, setFinanceTickCronError] = useState<string | null>(null);

  const [kdpScreenEnabled, setKdpScreenEnabled] = useState(initial.org_kdp_auto_publish_enabled);
  const [kdpScreenCron, setKdpScreenCron] = useState(initial.org_kdp_screen_cron);
  const [kdpScreenCronError, setKdpScreenCronError] = useState<string | null>(null);

  const [isPending, setIsPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const validateCron = useCallback(
    (value: string): string | null => (isValidCronExpression(value.trim()) ? null : m.cronErrorInvalid),
    [],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const rows: Array<{ enabled: boolean; cron: string; setError: (v: string | null) => void }> = [
        { enabled: planEnabled, cron: planCron, setError: setPlanCronError },
        { enabled: executeEnabled, cron: executeCron, setError: setExecuteCronError },
        { enabled: opsWatchEnabled, cron: opsWatchCron, setError: setOpsWatchCronError },
        { enabled: financeTickEnabled, cron: financeTickCron, setError: setFinanceTickCronError },
        { enabled: kdpScreenEnabled, cron: kdpScreenCron, setError: setKdpScreenCronError },
      ];
      let hasError = false;
      for (const row of rows) {
        const err = row.enabled ? validateCron(row.cron) : null;
        row.setError(err);
        if (err) hasError = true;
      }
      if (hasError) return;

      setIsPending(true);
      setFeedback(null);
      const result = await updateOrgAutomation({
        org_auto_plan_enabled: planEnabled,
        org_plan_cron: planCron.trim(),
        org_auto_execute_enabled: executeEnabled,
        org_execute_cron: executeCron.trim(),
        org_ops_watch_enabled: opsWatchEnabled,
        org_ops_watch_cron: opsWatchCron.trim(),
        org_finance_tick_enabled: financeTickEnabled,
        org_finance_tick_cron: financeTickCron.trim(),
        org_kdp_auto_publish_enabled: kdpScreenEnabled,
        org_kdp_screen_cron: kdpScreenCron.trim(),
      });
      setIsPending(false);
      setFeedback(result.ok ? { ok: true, msg: m.saved } : { ok: false, msg: result.error.message });
    },
    [
      planEnabled,
      planCron,
      executeEnabled,
      executeCron,
      opsWatchEnabled,
      opsWatchCron,
      financeTickEnabled,
      financeTickCron,
      kdpScreenEnabled,
      kdpScreenCron,
      validateCron,
    ],
  );

  return (
    <section
      aria-labelledby="org-automation-heading"
      className="flex flex-col gap-space-loose rounded-card border border-border-warm bg-cream-light p-space-loose"
      data-testid="org-automation-settings"
    >
      <div>
        <h2 id="org-automation-heading" className="text-sub-heading text-foreground">
          {m.title}
        </h2>
        <p className="text-body text-muted">{m.subtitle}</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-space-snug">
        <AutomationRow
          enabled={planEnabled}
          onToggle={setPlanEnabled}
          cron={planCron}
          onCronChange={setPlanCron}
          onCronBlur={() => setPlanCronError(planEnabled ? validateCron(planCron) : null)}
          cronError={planCronError}
          label={m.rows.plan.label}
          help={m.rows.plan.help}
          testId="org-automation-plan"
        />
        <AutomationRow
          enabled={executeEnabled}
          onToggle={setExecuteEnabled}
          cron={executeCron}
          onCronChange={setExecuteCron}
          onCronBlur={() => setExecuteCronError(executeEnabled ? validateCron(executeCron) : null)}
          cronError={executeCronError}
          label={m.rows.execute.label}
          help={m.rows.execute.help}
          testId="org-automation-execute"
        />
        <AutomationRow
          enabled={opsWatchEnabled}
          onToggle={setOpsWatchEnabled}
          cron={opsWatchCron}
          onCronChange={setOpsWatchCron}
          onCronBlur={() => setOpsWatchCronError(opsWatchEnabled ? validateCron(opsWatchCron) : null)}
          cronError={opsWatchCronError}
          label={m.rows.opsWatch.label}
          help={m.rows.opsWatch.help}
          testId="org-automation-ops-watch"
        />
        <AutomationRow
          enabled={financeTickEnabled}
          onToggle={setFinanceTickEnabled}
          cron={financeTickCron}
          onCronChange={setFinanceTickCron}
          onCronBlur={() => setFinanceTickCronError(financeTickEnabled ? validateCron(financeTickCron) : null)}
          cronError={financeTickCronError}
          label={m.rows.financeTick.label}
          help={m.rows.financeTick.help}
          testId="org-automation-finance-tick"
        />
        <AutomationRow
          enabled={kdpScreenEnabled}
          onToggle={setKdpScreenEnabled}
          cron={kdpScreenCron}
          onCronChange={setKdpScreenCron}
          onCronBlur={() => setKdpScreenCronError(kdpScreenEnabled ? validateCron(kdpScreenCron) : null)}
          cronError={kdpScreenCronError}
          label={m.rows.kdpScreen.label}
          help={m.rows.kdpScreen.help}
          testId="org-automation-kdp-screen"
        />

        <div className="flex items-start gap-2 rounded-button border border-border-warm bg-white px-3 py-2">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <p className="text-button-sm text-muted" data-testid="org-automation-worker-restart-note">
            {m.workerRestartNote}
          </p>
        </div>

        <div className="flex items-center gap-space-snug">
          <button
            type="submit"
            disabled={isPending}
            data-testid="org-automation-save"
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
    </section>
  );
}
