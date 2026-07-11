'use client';

/**
 * docs/06 P3 — 全社ToDoボードの横断運用ボタン。
 * - 運用監視 (org.ops.watch): 失敗/スタックジョブ検知 → 復旧/要調査ToDo起票
 * - 予算ガード (org.finance.tick): 本部別コスト集計 → 超過なら enforce_limit 起票
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { LifeBuoy, ShieldAlert } from 'lucide-react';

import { runOrgOpsWatch, runOrgFinanceTick } from '@/app/actions/org';
import { messages } from '@/lib/messages';

const m = messages.org.board;

interface TickButtonProps {
  action: () => Promise<{ ok: boolean; error?: { message?: string } }>;
  label: string;
  hint: string;
  queued: string;
  icon: React.ReactNode;
  testid: string;
}

function TickButton({ action, label, hint, queued, icon, testid }: TickButtonProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setNote(null);
    setError(null);
    start(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error?.message ?? m.tickError);
        return;
      }
      setNote(queued);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-card border border-line bg-cream-light px-3 py-2 text-button-sm text-charcoal hover:opacity-80 disabled:opacity-50"
        data-testid={testid}
      >
        {icon}
        {label}
      </button>
      <span className="text-caption text-muted">{hint}</span>
      {note && <span className="text-caption text-success" role="status">{note}</span>}
      {error && <span className="text-caption text-destructive" role="alert">{error}</span>}
    </div>
  );
}

export function RunOrgTickButtons() {
  return (
    <div className="flex flex-col gap-space-snug sm:flex-row sm:flex-wrap">
      <TickButton
        action={runOrgOpsWatch}
        label={m.opsWatch}
        hint={m.opsWatchHint}
        queued={m.opsWatchQueued}
        icon={<LifeBuoy aria-hidden className="h-4 w-4" />}
        testid="org-run-ops-watch"
      />
      <TickButton
        action={runOrgFinanceTick}
        label={m.financeTick}
        hint={m.financeTickHint}
        queued={m.financeTickQueued}
        icon={<ShieldAlert aria-hidden className="h-4 w-4" />}
        testid="org-run-finance-tick"
      />
    </div>
  );
}
