'use client';

/**
 * 全社ToDoボードの「承認済タスクを実行」ボタン。org.execute.dispatch を enqueue する。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Play } from 'lucide-react';

import { runOrgDispatch } from '@/app/actions/org';
import { messages } from '@/lib/messages';

const m = messages.org.board;

export function RunDispatchButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setNote(null);
    setError(null);
    start(async () => {
      const res = await runOrgDispatch();
      if (!res.ok) {
        setError(res.error?.message ?? m.dispatchError);
        return;
      }
      setNote(m.dispatchQueued);
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
        data-testid="org-run-dispatch"
      >
        <Play aria-hidden className="h-4 w-4" />
        {pending ? m.dispatchRunning : m.dispatch}
      </button>
      <span className="text-caption text-muted">{m.dispatchHint}</span>
      {note && <span className="text-caption text-success" role="status">{note}</span>}
      {error && <span className="text-caption text-destructive" role="alert">{error}</span>}
    </div>
  );
}
