'use client';

/**
 * SubmitToKdpButton — S-015 詳細の入稿キュー登録/取消 (T-08-03/T-08-09, F-041).
 *
 * サーバから直接 KDP へ入稿することはできない (Amazon がインタラクティブな 2FA
 * 再認証を都度要求するため)。クリックで `Book.kdp_publish_queued` を立てるだけで、
 * 実際の入稿はローカルのアシスト出版ツール (scripts/kdp-publish.mjs) が行う。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { submitToKdp, unqueueFromKdp } from '@/app/actions/kdp-submit';
import { messages } from '@/lib/messages';

interface SubmitToKdpButtonProps {
  bookId: string;
  /** true = must コメント未対応・メタデータ未生成・出版済みのいずれか (入稿不可) */
  disabled: boolean;
  /** Book.kdp_publish_queued の初期値 */
  queued: boolean;
}

const m = messages.kdpChecklist.submitKdp;

export function SubmitToKdpButton({ bookId, disabled, queued: initialQueued }: SubmitToKdpButtonProps) {
  const router = useRouter();
  const [queued, setQueued] = useState(initialQueued);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  function handleQueue() {
    setFeedback(null);
    startTransition(async () => {
      const result = await submitToKdp({ book_ids: [bookId] });
      if (!result.ok) {
        setFeedback({ ok: false, msg: result.error.message });
        return;
      }
      if (result.data.blocked.length > 0) {
        setFeedback({ ok: false, msg: result.data.blocked[0]!.reason });
        return;
      }
      setQueued(true);
      setFeedback({ ok: true, msg: m.queueSuccess });
      router.refresh();
    });
  }

  function handleUnqueue() {
    setFeedback(null);
    startTransition(async () => {
      const result = await unqueueFromKdp({ book_ids: [bookId] });
      if (!result.ok) {
        setFeedback({ ok: false, msg: result.error.message });
        return;
      }
      setQueued(false);
      setFeedback({ ok: true, msg: m.unqueueSuccess });
      router.refresh();
    });
  }

  if (queued) {
    return (
      <div className="flex items-center gap-space-snug" data-testid="submit-to-kdp-wrapper">
        <span
          className="inline-flex items-center gap-1.5 rounded-card border border-border-warm bg-success-bg px-3 py-1.5 text-button-sm text-success"
          data-testid="submit-to-kdp-queued-badge"
        >
          {m.queuedLabel}
        </span>
        <button
          type="button"
          onClick={handleUnqueue}
          disabled={pending}
          className="text-button-sm text-muted underline underline-offset-2 hover:no-underline disabled:opacity-50"
          data-testid="submit-to-kdp-cancel-btn"
        >
          {pending ? m.cancelling : m.cancelButton}
        </button>
        {feedback && (
          <span
            role="status"
            aria-live="polite"
            className={`text-button-sm ${feedback.ok ? 'text-success' : 'text-destructive'}`}
            data-testid="submit-to-kdp-feedback"
          >
            {feedback.msg}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-space-snug" data-testid="submit-to-kdp-wrapper">
      <button
        type="button"
        onClick={handleQueue}
        disabled={disabled || pending}
        aria-disabled={disabled || pending}
        title={disabled ? m.disabledTooltip : undefined}
        className="inline-flex items-center gap-1.5 rounded-card border border-border-warm bg-cream px-4 py-2 text-button-sm text-charcoal hover:bg-charcoal-04 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="submit-to-kdp-btn"
      >
        {pending ? m.queueing : m.button}
      </button>
      {feedback && (
        <span
          role="status"
          aria-live="polite"
          className={`text-button-sm ${feedback.ok ? 'text-success' : 'text-destructive'}`}
          data-testid="submit-to-kdp-feedback"
        >
          {feedback.msg}
        </span>
      )}
    </div>
  );
}
