'use client';

/**
 * RegeneratePlanButton — 長期出版プラン再生成ボタン + 期間セレクタ (T-08-02, S-005).
 *
 * ローカルステートで isPending を管理 (useTransition-deferred reset は使わない)。
 * 期間セレクタ: 3 / 6 / 12 ヶ月のラベル付き <select>。
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

import { regeneratePlan } from '@/app/actions/plans';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';

const m = messages.plans;

type PlanMonths = 3 | 6 | 12;

interface RegeneratePlanButtonProps {
  accountId: string;
  /** 現在の期間 (デフォルト 6) */
  defaultMonths?: PlanMonths;
  /** ターゲット冊数 (任意) */
  targetCount?: number;
}

export function RegeneratePlanButton({
  accountId,
  defaultMonths = 6,
  targetCount,
}: RegeneratePlanButtonProps) {
  const router = useRouter();
  const [months, setMonths] = useState<PlanMonths>(defaultMonths);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleRegenerate() {
    setIsPending(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await regeneratePlan({
        account_id: accountId,
        months,
        ...(targetCount !== undefined ? { target_count: targetCount } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSuccess(m.regenerateSuccess);
      router.refresh();
    } finally {
      setIsPending(false);
    }
  }

  const selectId = 'plan-period-select';

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-space-snug">
        {/* 期間セレクタ */}
        <div className="flex items-center gap-2">
          <label
            htmlFor={selectId}
            className="text-button-sm text-muted whitespace-nowrap"
          >
            {m.periodLabel}
          </label>
          <select
            id={selectId}
            value={months}
            onChange={(e) => setMonths(Number(e.target.value) as PlanMonths)}
            disabled={isPending}
            className="rounded border border-border-warm bg-white px-2 py-1 text-button-sm text-foreground cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
          >
            {([3, 6, 12] as PlanMonths[]).map((v) => (
              <option key={v} value={v}>
                {m.periodOptions[String(v)]}
              </option>
            ))}
          </select>
        </div>

        {/* 再生成ボタン */}
        <Button
          type="button"
          variant="default"
          disabled={isPending}
          onClick={handleRegenerate}
          className="cursor-pointer focus-visible:ring-2 focus-visible:ring-offset-2"
          aria-busy={isPending}
        >
          <RefreshCw
            className={['h-4 w-4 mr-1', isPending ? 'animate-spin' : ''].join(' ')}
            aria-hidden="true"
          />
          {isPending ? m.regenerating : m.regenerateButton}
        </Button>
      </div>

      {/* フィードバック */}
      {error && (
        <p
          role="alert"
          className="text-button-sm text-destructive"
          data-testid="regenerate-plan-error"
        >
          {error}
        </p>
      )}
      {success && !error && (
        <p
          role="status"
          className="text-button-sm text-success"
          data-testid="regenerate-plan-success"
        >
          {success}
        </p>
      )}
    </div>
  );
}
