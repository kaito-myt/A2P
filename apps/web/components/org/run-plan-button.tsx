'use client';

/**
 * 経営ダッシュボードの「CEO に立案させる」ボタン。org.plan を enqueue する。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';

import { runOrgPlan } from '@/app/actions/org';
import { messages } from '@/lib/messages';

const m = messages.org.dashboard;

export function RunPlanButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setNote(null);
    setError(null);
    start(async () => {
      const res = await runOrgPlan();
      if (!res.ok) {
        setError(res.error?.message ?? m.runError);
        return;
      }
      setNote(m.runQueued);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-card bg-charcoal px-4 py-2 text-button-sm text-cream-light shadow-l2-inset hover:opacity-80 disabled:opacity-50"
        data-testid="org-run-plan"
      >
        <Sparkles aria-hidden className="h-4 w-4" />
        {pending ? m.running : m.runPlan}
      </button>
      <span className="text-caption text-muted">{m.runHint}</span>
      {note && <span className="text-caption text-success" role="status">{note}</span>}
      {error && <span className="text-caption text-destructive" role="alert">{error}</span>}
    </div>
  );
}
