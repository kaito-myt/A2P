'use client';

/**
 * S-008 ページ本体 (T-03-09 / T-07-10).
 *
 * RSC (page.tsx) から theme rows / preview rows / forecast を受け取り、
 * BatchScheduleForm の controlled state + 送信ボタン処理を司る。
 *
 * SA 呼出:
 *  - kickMode='scheduled' → createBatchPlan のみ
 *  - kickMode='now'       → createBatchPlan → 成功時にそのまま kickBatchNow
 *
 * 成功時:
 *  - scheduled → /batches へ遷移
 *  - now       → /dashboard へ遷移
 *
 * T-07-10: wouldExceedMonthly=true の場合、kick ボタンを disabled に。
 * forceOverride=true (強制続行スイッチ ON) の場合のみ kick 可。
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { createBatchPlan, kickBatchNow } from '@/app/actions/batches';
import { messages } from '@/lib/messages';

import {
  BatchScheduleForm,
  type BatchScheduleFormValues,
  type KickMode,
} from './batch-schedule-form';

const m = messages.batches;
const mWarn = messages.batches.monthlyBudgetWarning;

interface BatchesPageShellProps {
  themeIds: readonly string[];
  themeCount: number;
  /** model 割当 / カタログが揃っていない場合は kick 禁止 (UI 警告は別カードに既出)。 */
  canKick: boolean;
  /** 月次予算レッド閾値超過予測 (T-07-10)。true の場合、強制続行 OFF なら kick 禁止。 */
  wouldExceedMonthly?: boolean;
}

function defaultPlannedAtLocal(): string {
  // 当日 23:00 (ローカルタイムゾーン) を datetime-local 形式で構築
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 文字列 → ISO 文字列 (timezone はブラウザに依存)。 */
function localToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function BatchesPageShell({
  themeIds,
  themeCount,
  canKick,
  wouldExceedMonthly = false,
}: BatchesPageShellProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [forceOverride, setForceOverride] = useState(false);

  const [values, setValues] = useState<BatchScheduleFormValues>(() => ({
    kickMode: 'scheduled' as KickMode,
    plannedAtLocal: defaultPlannedAtLocal(),
    concurrency: 5,
    deadlineLocal: '',
  }));

  const submitDisabled = pending || themeCount === 0;
  // kick が disabled な条件: canKick 不足 OR (月次超過 AND forceOverride OFF)
  const kickDisabled = submitDisabled || !canKick || (wouldExceedMonthly && !forceOverride);

  function submit(mode: KickMode) {
    setError(null);
    setInfo(null);
    if (themeCount === 0) {
      setError(m.errors.noAcceptedThemes);
      return;
    }
    startTransition(async () => {
      const created = await createBatchPlan({
        themeIds: [...themeIds],
        plannedAt:
          mode === 'now'
            ? new Date().toISOString()
            : localToIso(values.plannedAtLocal),
        concurrency: values.concurrency,
        ...(values.deadlineLocal
          ? { deadline: localToIso(values.deadlineLocal) }
          : {}),
      });
      if (!created.ok) {
        setError(created.error.message);
        return;
      }

      if (mode === 'scheduled') {
        setInfo(m.schedule.successScheduled(created.data.item_count));
        router.push('/batches');
        return;
      }

      // 即時キックモード: 続けて kickBatchNow (force=true を明示)
      const kicked = await kickBatchNow({
        batchPlanId: created.data.batch_id,
        ...(forceOverride ? { force: true } : {}),
      });
      if (!kicked.ok) {
        setError(kicked.error.message);
        return;
      }
      setInfo(m.schedule.successKicked(kicked.data.kicked_count));
      router.push('/dashboard');
    });
  }

  return (
    <div data-testid="batches-page-shell" className="flex flex-col gap-space-snug">
      <BatchScheduleForm values={values} onChange={setValues} disabled={pending} />

      {wouldExceedMonthly && (
        <div className="rounded-default border border-destructive bg-destructive-bg px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-button-sm text-destructive">
            <input
              type="checkbox"
              data-testid="batch-force-override-checkbox"
              checked={forceOverride}
              onChange={(e) => setForceOverride(e.target.checked)}
              className="h-4 w-4 accent-destructive"
            />
            <span>{mWarn.forceLabel}</span>
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-space-snug">
        {error && (
          <span
            data-testid="batches-error"
            role="alert"
            className="text-button-sm text-destructive"
          >
            {error}
          </span>
        )}
        {info && (
          <span
            data-testid="batches-info"
            className="text-button-sm text-success"
          >
            {info}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={submitDisabled}
          onClick={() => submit('scheduled')}
          data-testid="batch-create-button"
        >
          {pending ? m.schedule.saving : m.schedule.saveButton}
        </Button>
        <Button
          type="button"
          variant="default"
          disabled={kickDisabled}
          onClick={() => submit('now')}
          data-testid="batch-kick-now-button"
        >
          {pending ? m.schedule.kicking : m.schedule.kickButton}
        </Button>
      </div>
    </div>
  );
}
