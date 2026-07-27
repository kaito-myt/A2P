'use client';

/**
 * BulkQueueButton — S-015 一覧の「準備完了の本をまとめて入稿キューに登録」(F-041)。
 *
 * `readyBookIds` (RSC 側で算出した「ブロックなし・メタデータあり・未キュー」の書籍 ID) を
 * `submitToKdp` に渡す。20 件超は分割送信する (SA の入力上限)。
 * 実際の入稿は行わない — ローカルのアシスト出版ツール (scripts/kdp-publish.mjs) がキューを拾う。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Info } from 'lucide-react';

import { submitToKdp } from '@/app/actions/kdp-submit';
import { messages } from '@/lib/messages';

const m = messages.kdpChecklist.bulkSubmitKdp;

const MAX_BATCH_SIZE = 20;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

interface BulkQueueButtonProps {
  readyBookIds: string[];
}

export function BulkQueueButton({ readyBookIds }: BulkQueueButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  function handleClick() {
    setFeedback(null);
    if (readyBookIds.length === 0) {
      setFeedback({ ok: false, msg: m.noReadyBooks });
      return;
    }
    startTransition(async () => {
      let queuedTotal = 0;
      let blockedTotal = 0;
      for (const batch of chunk(readyBookIds, MAX_BATCH_SIZE)) {
        const result = await submitToKdp({ book_ids: batch });
        if (!result.ok) {
          setFeedback({ ok: false, msg: result.error.message });
          return;
        }
        queuedTotal += result.data.queued.length;
        blockedTotal += result.data.blocked.length;
      }
      setFeedback({ ok: true, msg: m.result(queuedTotal, blockedTotal) });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="bulk-queue-kdp-wrapper">
      <div className="flex flex-wrap items-center gap-space-snug">
        <button
          type="button"
          onClick={handleClick}
          disabled={pending || readyBookIds.length === 0}
          className="inline-flex items-center gap-1.5 rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="bulk-queue-kdp-btn"
        >
          {pending ? m.queueing : m.button}
        </button>
        {feedback && (
          <span
            role="status"
            aria-live="polite"
            className={`text-button-sm ${feedback.ok ? 'text-success' : 'text-destructive'}`}
            data-testid="bulk-queue-kdp-feedback"
          >
            {feedback.msg}
          </span>
        )}
      </div>
      <p className="flex items-start gap-1 text-button-sm text-muted" data-testid="bulk-queue-kdp-helper">
        <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {m.helperText}
      </p>
    </div>
  );
}
