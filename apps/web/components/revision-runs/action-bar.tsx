'use client';

/**
 * ActionBar — S-014 アクションボタン群 (T-06-09, T-06-11).
 *
 * - 「承認」→ placeholder (Phase 1)
 * - 「追加コメント」→ /comments へ router.push
 * - 「ロールバック」→ rollbackRevisionRun SA 呼出
 * - 「書籍詳細へ」→ /books/[id] へ router.push
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

import { rollbackRevisionRun } from '@/app/actions/revision-runs';
import { messages } from '@/lib/messages';
import type { RunStatus } from '@/lib/revision-runs-view';

const m = messages.revisionRuns.actions;
const rb = messages.revisionRuns.rollback;

interface ActionBarProps {
  runStatus: RunStatus;
  firstBookId: string | null;
  runId: string;
}

export function ActionBar({ runStatus, firstBookId, runId }: ActionBarProps) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const isComplete = runStatus === 'done' || runStatus === 'partial' || runStatus === 'failed';

  const handleRollback = useCallback(async () => {
    setRolling(true);
    setError(null);
    setInfo(null);
    try {
      const result = await rollbackRevisionRun({ revision_run_id: runId });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setInfo(rb.success(result.data.restored));
      router.refresh();
    } finally {
      setRolling(false);
      setShowConfirm(false);
    }
  }, [runId, router]);

  return (
    <div
      data-testid="action-bar"
      className="flex flex-wrap items-center gap-space-snug border-t border-border-warm pt-space-snug"
    >
      {error && (
        <span
          data-testid="action-bar-error"
          className="text-button-sm text-destructive"
        >
          {error}
        </span>
      )}
      {info && (
        <span
          data-testid="action-bar-info"
          className="text-button-sm text-success"
        >
          {info}
        </span>
      )}
      {isComplete && (
        <button
          type="button"
          className="rounded-default bg-foreground px-4 py-2 text-button-sm text-cream transition-opacity hover:opacity-80"
          title={m.approveTooltip}
          data-testid="action-approve"
          onClick={() => {
            // placeholder: Phase 1 does nothing
          }}
        >
          {m.approve}
        </button>
      )}

      <button
        type="button"
        className="rounded-default border border-border-warm bg-cream px-4 py-2 text-button-sm text-charcoal transition-colors hover:bg-charcoal-04"
        data-testid="action-add-comment"
        onClick={() => router.push('/comments')}
      >
        {m.addComment}
      </button>

      {isComplete && (
        <button
          type="button"
          className="rounded-default border border-destructive bg-cream px-4 py-2 text-button-sm text-destructive transition-colors hover:bg-destructive-bg"
          title={m.rollbackTooltip}
          data-testid="action-rollback"
          disabled={rolling}
          onClick={() => setShowConfirm(true)}
        >
          {m.rollback}
        </button>
      )}

      {firstBookId && (
        <button
          type="button"
          className="rounded-default border border-border-warm bg-cream px-4 py-2 text-button-sm text-charcoal transition-colors hover:bg-charcoal-04"
          data-testid="action-book-detail"
          onClick={() => router.push(`/books/${firstBookId}`)}
        >
          {m.bookDetail}
        </button>
      )}

      {showConfirm && (
        <div
          data-testid="rollback-confirm-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setShowConfirm(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowConfirm(false);
          }}
        >
          <div
            className="w-full max-w-md rounded-default bg-cream p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={() => {}}
          >
            <h3 className="mb-2 text-lg font-bold text-charcoal">
              {m.rollbackConfirmTitle}
            </h3>
            <p className="mb-4 text-sm text-charcoal-60">
              {m.rollbackConfirmBody}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-default border border-border-warm bg-cream px-4 py-2 text-button-sm text-charcoal"
                data-testid="rollback-confirm-cancel"
                disabled={rolling}
                onClick={() => setShowConfirm(false)}
              >
                {m.rollbackConfirmNo}
              </button>
              <button
                type="button"
                className="rounded-default bg-destructive px-4 py-2 text-button-sm text-cream"
                data-testid="rollback-confirm-yes"
                disabled={rolling}
                onClick={handleRollback}
              >
                {rolling ? m.rollback + '...' : m.rollbackConfirmYes}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
