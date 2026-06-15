'use client';

/**
 * ActionGroup — ジョブ操作ボタン群 (S-026, T-09-02, F-016/F-046).
 *
 * ボタン:
 *  - リトライ: retryJob({ job_id, from_step: 'auto' }) — failed のみ有効
 *  - ステップから再開: retryJob({ job_id, from_step: 'this_step' }) — failed のみ有効
 *  - 中止: cancelJob({ job_id }) — running/queued のみ有効 + confirm ダイアログ
 *  - 親書籍へ: Link → /books/[book_id]
 *
 * disabled 状態は aria + opacity + title tooltip で明示。
 * 中止は destructive — 赤枠 + confirm ダイアログ必須。
 *
 * 仕様根拠: docs/wireframes/S-026-job-detail/prompt.md §Section 8
 *           ui-ux-pro-max: confirm dialog / disabled states / aria
 */
import { useState, useTransition, useId } from 'react';
import Link from 'next/link';
import { RotateCcw, StepForward, Square, ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { messages } from '@/lib/messages';
import { retryJob, cancelJob } from '@/app/actions/jobs';

const m = messages.jobs.detail;

interface ActionGroupProps {
  jobId: string;
  status: string;
  kind: string;
  bookId: string | null;
}

const CANCELLABLE_STATUSES = new Set(['queued', 'running']);
const RETRIABLE_STATUSES = new Set(['failed']);

const STEP_RESUMABLE_KINDS = new Set([
  'pipeline.book.writer.outline',
  'pipeline.book.writer.chapters.dispatch',
  'pipeline.book.writer.chapter',
  'pipeline.book.editor',
  'pipeline.book.thumbnail.text',
  'pipeline.book.thumbnail.image',
  'pipeline.book.judge',
  'pipeline.book.export',
]);

export function ActionGroup({ jobId, status, kind, bookId }: ActionGroupProps) {
  const router = useRouter();
  const uid = useId();
  const cancelDialogTitleId = `${uid}-cancel-confirm-title`;
  const [isPendingRetry, startRetry] = useTransition();
  const [isPendingStep, startStep] = useTransition();
  const [isPendingCancel, startCancel] = useTransition();
  const [showConfirm, setShowConfirm] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const canRetry = RETRIABLE_STATUSES.has(status);
  const canResume = RETRIABLE_STATUSES.has(status) && STEP_RESUMABLE_KINDS.has(kind);
  const canCancel = CANCELLABLE_STATUSES.has(status);

  const handleRetry = () => {
    setErrorMsg(null);
    startRetry(async () => {
      const result = await retryJob({ job_id: jobId, from_step: 'auto' });
      if (result.ok) {
        router.refresh();
      } else {
        setErrorMsg(result.error.message);
      }
    });
  };

  const handleStepResume = () => {
    setErrorMsg(null);
    startStep(async () => {
      const result = await retryJob({ job_id: jobId, from_step: 'this_step' });
      if (result.ok) {
        router.refresh();
      } else {
        setErrorMsg(result.error.message);
      }
    });
  };

  const handleCancelConfirmed = () => {
    setShowConfirm(false);
    setErrorMsg(null);
    startCancel(async () => {
      const result = await cancelJob({ job_id: jobId });
      if (result.ok) {
        router.refresh();
      } else {
        setErrorMsg(result.error.message);
      }
    });
  };

  const isPending = isPendingRetry || isPendingStep || isPendingCancel;

  function btnBase(disabled: boolean) {
    return `flex items-center justify-center gap-1.5 rounded border px-3 py-1.5 text-body font-medium transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`;
  }

  return (
    <section aria-label="ジョブ操作" className="flex flex-col gap-space-snug">
      {errorMsg && (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-caption text-red-700"
        >
          {errorMsg}
        </div>
      )}

      {/* Retry */}
      <button
        type="button"
        onClick={handleRetry}
        disabled={!canRetry || isPending}
        className={`${btnBase(!canRetry || isPending)} border-border-warm bg-white text-foreground hover:bg-cream-light`}
        title={!canRetry ? m.disabledNotFailed : undefined}
        aria-disabled={!canRetry || isPending}
      >
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        {isPendingRetry ? m.retrying : m.actionRetry}
      </button>

      {/* Step resume */}
      <button
        type="button"
        onClick={handleStepResume}
        disabled={!canResume || isPending}
        className={`${btnBase(!canResume || isPending)} border-border-warm bg-white text-foreground hover:bg-cream-light`}
        title={!canResume ? m.disabledNotFailed : undefined}
        aria-disabled={!canResume || isPending}
      >
        <StepForward className="h-4 w-4" aria-hidden="true" />
        {isPendingStep ? m.retrying : m.actionRetryStep}
      </button>

      {/* Cancel (destructive) */}
      <button
        type="button"
        onClick={() => setShowConfirm(true)}
        disabled={!canCancel || isPending}
        className={`${btnBase(!canCancel || isPending)} border-red-300 bg-red-50 text-red-700 hover:bg-red-100`}
        title={!canCancel ? m.disabledTerminal : undefined}
        aria-disabled={!canCancel || isPending}
      >
        <Square className="h-4 w-4" aria-hidden="true" />
        {isPendingCancel ? m.cancelling : m.actionCancel}
      </button>

      {/* Book link */}
      {bookId && (
        <Link
          href={`/books/${bookId}`}
          className="flex items-center justify-center gap-1.5 rounded border border-border-warm bg-white px-3 py-1.5 text-body text-foreground no-underline hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {m.actionGoBook}
        </Link>
      )}

      {/* Confirm dialog */}
      {showConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={cancelDialogTitleId}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-card border border-border-warm bg-white p-space-normal shadow-lg">
            <h3
              id={cancelDialogTitleId}
              className="text-body font-medium text-foreground"
            >
              {m.actionCancelConfirmTitle}
            </h3>
            <p className="mt-space-snug text-caption text-muted">
              {m.actionCancelConfirmBody}
            </p>
            <div className="mt-space-normal flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="rounded border border-border-warm bg-white px-3 py-1.5 text-body text-foreground hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {m.actionCancelDismiss}
              </button>
              <button
                type="button"
                onClick={handleCancelConfirmed}
                className="rounded border border-red-400 bg-red-600 px-3 py-1.5 text-body font-medium text-white hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400"
              >
                {m.actionCancelConfirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
