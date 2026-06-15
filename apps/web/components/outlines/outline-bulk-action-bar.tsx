'use client';

/**
 * S-011 OutlineBulkActionBar (T-04-08 / F-018).
 *
 * - 「選択を承認」: `bulkApproveOutlines` SA を起動
 * - 「選択を差戻し」: 差戻しダイアログを開き、reject_note 入力後 `bulkRejectOutlines` SA
 *   (全選択 outline に同一 note を適用)
 * - 「選択解除」: 親 (outlines-page-shell) の selection を空にする
 *
 * 進行中 (useTransition) の間はボタン全部 disabled。
 * 成功後は selection clear + router.refresh()。
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  bulkApproveOutlines,
  bulkRejectOutlines,
} from '@/app/actions/outlines';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { messages } from '@/lib/messages';

const m = messages.outlines;

interface OutlineBulkActionBarProps {
  selectedIds: string[];
  onSelectionClear: () => void;
}

export function OutlineBulkActionBar({
  selectedIds,
  onSelectionClear,
}: OutlineBulkActionBarProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');

  const selectionCount = selectedIds.length;
  const canAct = selectionCount > 0;

  function approve() {
    setError(null);
    setInfo(null);
    if (!canAct) {
      setError(m.errors.noSelection);
      return;
    }
    startTransition(async () => {
      const result = await bulkApproveOutlines({ outline_ids: selectedIds });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const { approved, failed_items } = result.data;
      if (failed_items.length > 0) {
        setInfo(m.bulkSuccess.partial(approved, failed_items.length));
      } else {
        setInfo(m.bulkSuccess.approve(approved));
      }
      onSelectionClear();
      router.refresh();
    });
  }

  function openReject() {
    setError(null);
    setInfo(null);
    if (!canAct) {
      setError(m.errors.noSelection);
      return;
    }
    setRejectNote('');
    setRejectOpen(true);
  }

  function submitReject() {
    setError(null);
    setInfo(null);
    const note = rejectNote.trim();
    if (note.length === 0) {
      setError(m.errors.rejectNoteRequired);
      return;
    }
    const items = selectedIds.map((id) => ({ outline_id: id, reject_note: note }));
    startTransition(async () => {
      const result = await bulkRejectOutlines({ items });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const { rejected, failed_items } = result.data;
      if (failed_items.length > 0) {
        setInfo(m.bulkSuccess.partial(rejected, failed_items.length));
      } else {
        setInfo(m.bulkSuccess.reject(rejected));
      }
      setRejectOpen(false);
      setRejectNote('');
      onSelectionClear();
      router.refresh();
    });
  }

  return (
    <>
      <div
        data-testid="outline-bulk-action-bar"
        className="sticky bottom-0 z-10 flex flex-wrap items-center gap-space-snug border-t-2 border-charcoal bg-cream-light px-space-relaxed py-space-snug shadow-l2-inset"
      >
        <span
          data-testid="outline-bulk-selection-count"
          className="text-button font-medium text-charcoal"
        >
          {m.bulk.selectionCount(selectionCount)}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-space-snug">
          {error && (
            <span
              data-testid="outline-bulk-error"
              className="text-button-sm text-destructive"
            >
              {error}
            </span>
          )}
          {info && (
            <span
              data-testid="outline-bulk-info"
              className="text-button-sm text-success"
            >
              {info}
            </span>
          )}
          <Button
            type="button"
            variant="default"
            disabled={pending || !canAct}
            onClick={approve}
            data-testid="outline-bulk-approve"
          >
            {m.bulk.approve}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || !canAct}
            onClick={openReject}
            data-testid="outline-bulk-reject"
          >
            {m.bulk.reject}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending || selectionCount === 0}
            onClick={onSelectionClear}
            data-testid="outline-bulk-clear"
          >
            {m.bulk.clear}
          </Button>
        </div>
      </div>

      {rejectOpen && (
        <RejectDialog
          selectionCount={selectionCount}
          note={rejectNote}
          onNoteChange={setRejectNote}
          submitting={pending}
          onCancel={() => {
            setRejectOpen(false);
            setRejectNote('');
            setError(null);
          }}
          onSubmit={submitReject}
        />
      )}
    </>
  );
}

interface RejectDialogProps {
  selectionCount: number;
  note: string;
  onNoteChange: (v: string) => void;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}

function RejectDialog({
  selectionCount,
  note,
  onNoteChange,
  submitting,
  onCancel,
  onSubmit,
}: RejectDialogProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="outline-reject-dialog-title"
      data-testid="outline-reject-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 px-space-snug"
    >
      <div className="flex w-full max-w-lg flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-loose shadow-l3-focus">
        <h2
          id="outline-reject-dialog-title"
          className="text-card-title font-medium text-charcoal"
        >
          {m.bulk.rejectModalTitle}
        </h2>
        <p className="text-button-sm text-muted">
          {m.bulk.rejectModalCount(selectionCount)}
          {' — '}
          {m.bulk.rejectModalDescription}
        </p>
        <label
          htmlFor="outline-reject-note"
          className="text-button-sm font-medium text-charcoal-82"
        >
          {m.bulk.rejectModalNoteLabel}
        </label>
        <Textarea
          id="outline-reject-note"
          data-testid="outline-reject-note"
          value={note}
          onChange={(e) => onNoteChange(e.currentTarget.value)}
          placeholder={m.bulk.rejectModalNotePlaceholder}
          rows={5}
          maxLength={2000}
          autoFocus
          disabled={submitting}
        />
        <div className="flex items-center justify-end gap-space-snug">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={submitting}
            data-testid="outline-reject-cancel"
          >
            {m.bulk.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onSubmit}
            disabled={submitting || note.trim().length === 0}
            data-testid="outline-reject-submit"
          >
            {submitting ? m.bulk.submitting : m.bulk.submit}
          </Button>
        </div>
      </div>
    </div>
  );
}
