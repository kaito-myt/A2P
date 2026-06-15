'use client';

/**
 * S-025 BulkActionBar (T-09-01, F-046).
 *
 * 画面下部固定: N 件選択中 + [選択ジョブを一括リトライ] + [選択解除]。
 * 結果 (retried_count + skipped reasons) をインラインフィードバックで表示。
 *
 * 仕様根拠: docs/04 S-025 / SP-09 T-09-01
 */

import { useCallback, useState } from 'react';
import { Loader2, RotateCcw, X } from 'lucide-react';

import { bulkRetryJobs } from '@/app/actions/jobs';
import { messages } from '@/lib/messages';
import type { BulkRetryJobsResult } from '@/lib/jobs-core';

interface BulkActionBarProps {
  selectedIds: Set<string>;
  onClear: () => void;
  onRetried: () => void;
}

const m = messages.jobs.bulk;
const mErr = messages.jobs.errors;

interface FeedbackState {
  kind: 'success' | 'error';
  message: string;
}

export function BulkActionBar({ selectedIds, onClear, onRetried }: BulkActionBarProps) {
  const [isPending, setIsPending] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);

  const count = selectedIds.size;

  const handleRetry = useCallback(async () => {
    if (count === 0 || isPending) return;

    setIsPending(true);
    setFeedback(null);

    try {
      const result = await bulkRetryJobs({ job_ids: Array.from(selectedIds) });

      if (result.ok) {
        const data = result.data as BulkRetryJobsResult;
        let msg = messages.jobs.bulkRetrySuccess(data.retried_count);
        if (data.skipped.length > 0) {
          msg += ` (${data.skipped.length} 件スキップ)`;
        }
        setFeedback({ kind: 'success', message: msg });
        onRetried();
        onClear();
      } else {
        setFeedback({
          kind: 'error',
          message: result.error.message ?? mErr.bulkUnknown,
        });
      }
    } catch {
      setFeedback({ kind: 'error', message: mErr.bulkUnknown });
    } finally {
      setIsPending(false);
    }
  }, [count, isPending, selectedIds, onRetried, onClear]);

  if (count === 0 && !feedback) return null;

  return (
    <div
      role="region"
      aria-label="一括操作バー"
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-border-warm bg-white px-space-relaxed py-space-snug shadow-lg"
      data-testid="bulk-action-bar"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-space-snug">
        {/* Left: selection count + feedback */}
        <div className="flex items-center gap-space-snug">
          {count > 0 && (
            <span
              className="rounded-full bg-accent px-3 py-1 text-button-sm font-semibold text-white"
              aria-live="polite"
            >
              {m.selectionCount(count)}
            </span>
          )}
          {feedback && (
            <span
              className={`text-button-sm ${feedback.kind === 'success' ? 'text-green-700' : 'text-red-700'}`}
              aria-live="assertive"
              role="status"
            >
              {feedback.message}
            </span>
          )}
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-space-snug">
          {count > 0 && (
            <>
              <button
                type="button"
                onClick={handleRetry}
                disabled={isPending}
                className="flex min-h-[44px] items-center gap-1.5 rounded-card bg-accent px-space-relaxed py-2 text-button-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                aria-label={m.retry}
                data-testid="bulk-retry-button"
              >
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                )}
                {isPending ? m.retrying : m.retry}
              </button>

              <button
                type="button"
                onClick={onClear}
                disabled={isPending}
                className="flex min-h-[44px] items-center gap-1 rounded-card border border-border-warm px-space-relaxed py-2 text-button-sm text-muted hover:bg-cream-light disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                aria-label={m.clear}
                data-testid="bulk-clear-button"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                {m.clear}
              </button>
            </>
          )}

          {feedback && (
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="text-caption text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              aria-label="フィードバックを閉じる"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
