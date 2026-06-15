'use client';

/**
 * S-013 CommentsBulkActionBar (T-06-06 / T-06-07).
 *
 * Actions:
 *  - "選択を一括反映" -- calls createRevisionRun SA (scope=selected)
 *  - "対象書籍の全 pending を反映" -- calls createRevisionRun SA (scope=all_pending_in_selected_books)
 *  - "優先度変更" -- calls bulkChangePriority SA
 *  - "削除" -- calls deleteComment SA for each
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

import { bulkChangePriority, deleteComment } from '@/app/actions/comments';
import { createRevisionRun } from '@/app/actions/revision-runs';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';
import type { CommentRowSerialized } from '@/lib/comments-view';
import { computeKpi } from '@/lib/comments-view';

const m = messages.commentsPage.bulk;

interface CommentsBulkActionBarProps {
  selectedIds: string[];
  selectedRows: CommentRowSerialized[];
  onSelectionClear: () => void;
}

export function CommentsBulkActionBar({
  selectedIds,
  selectedRows,
  onSelectionClear,
}: CommentsBulkActionBarProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [priorityModalOpen, setPriorityModalOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const [applyScope, setApplyScope] = useState<'selected' | 'all_pending'>('selected');
  const [selectedPriority, setSelectedPriority] = useState<string>('should');

  const count = selectedIds.length;

  const applyKpi = useMemo(() => computeKpi(selectedRows), [selectedRows]);

  // --- Apply selected ---
  function handleApplySelected() {
    setApplyScope('selected');
    setApplyConfirmOpen(true);
  }

  // --- Apply all pending for selected books ---
  function handleApplyAllPending() {
    setApplyScope('all_pending');
    setApplyConfirmOpen(true);
  }

  function confirmApply() {
    setError(null);
    setInfo(null);
    setApplyConfirmOpen(false);
    const scope = applyScope;
    startTransition(async () => {
      const bookIds = [...new Set(selectedRows.map((r) => r.book_id))];
      const result = await createRevisionRun(
        scope === 'selected'
          ? { comment_ids: selectedIds, scope: 'selected' }
          : {
              comment_ids: selectedIds,
              scope: 'all_pending_in_selected_books',
              selected_book_ids: bookIds,
            },
      );
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (result.data.blocked_books.length > 0) {
        setInfo(messages.revisionRuns.blockedBooksWarning(result.data.blocked_books.length));
      }
      onSelectionClear();
      router.push(`/revision-runs/${result.data.run_id}`);
    });
  }

  // --- Priority change ---
  function openPriorityModal() {
    setError(null);
    setInfo(null);
    setPriorityModalOpen(true);
  }

  function submitPriorityChange() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const result = await bulkChangePriority({
        comment_ids: selectedIds,
        priority: selectedPriority,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setInfo(messages.comments.bulkChangePrioritySuccess(result.data.updated));
      setPriorityModalOpen(false);
      onSelectionClear();
      router.refresh();
    });
  }

  // --- Delete ---
  function openDeleteConfirm() {
    setError(null);
    setInfo(null);
    setDeleteConfirmOpen(true);
  }

  function submitDelete() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      let successCount = 0;
      let lastError: string | null = null;
      for (const id of selectedIds) {
        const result = await deleteComment({ comment_id: id });
        if (result.ok) {
          successCount++;
        } else {
          lastError = result.error.message;
        }
      }
      if (lastError && successCount === 0) {
        setError(lastError);
      } else if (lastError) {
        setInfo(messages.comments.deleteSuccess);
        setError(lastError);
      } else {
        setInfo(messages.comments.deleteSuccess);
      }
      setDeleteConfirmOpen(false);
      onSelectionClear();
      router.refresh();
    });
  }

  return (
    <>
      <div
        data-testid="comments-bulk-action-bar"
        className="sticky bottom-0 z-10 flex flex-wrap items-center gap-space-snug border-t-2 border-charcoal bg-cream-light px-space-relaxed py-space-snug shadow-l2-inset"
      >
        <span
          data-testid="comments-bulk-selection-count"
          className="text-button font-medium text-charcoal"
        >
          {m.selectionCount(count)}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-space-snug">
          {error && (
            <span
              data-testid="comments-bulk-error"
              className="text-button-sm text-destructive"
            >
              {error}
            </span>
          )}
          {info && (
            <span
              data-testid="comments-bulk-info"
              className="text-button-sm text-success"
            >
              {info}
            </span>
          )}
          <Button
            type="button"
            variant="default"
            disabled={pending || count === 0}
            onClick={handleApplySelected}
            data-testid="comments-bulk-apply"
          >
            {m.applySelected}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending || count === 0}
            onClick={handleApplyAllPending}
            data-testid="comments-bulk-apply-all"
          >
            {m.applyAllPending}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || count === 0}
            onClick={openPriorityModal}
            data-testid="comments-bulk-priority"
          >
            {m.changePriority}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || count === 0}
            onClick={openDeleteConfirm}
            data-testid="comments-bulk-delete"
          >
            {m.deleteSelected}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending || count === 0}
            onClick={onSelectionClear}
            data-testid="comments-bulk-clear"
          >
            {m.clear}
          </Button>
        </div>
      </div>

      {/* Priority modal */}
      {priorityModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="priority-modal-title"
          data-testid="comments-priority-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 px-space-snug"
        >
          <div className="flex w-full max-w-md flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-loose shadow-l3-focus">
            <h2
              id="priority-modal-title"
              className="text-card-title font-medium text-charcoal"
            >
              {m.priorityModalTitle}
            </h2>
            <p className="text-button-sm text-muted">
              {m.priorityModalDescription}
            </p>
            <label
              htmlFor="priority-select"
              className="text-button-sm font-medium text-charcoal-82"
            >
              {m.priorityModalLabel}
            </label>
            <select
              id="priority-select"
              data-testid="priority-select"
              value={selectedPriority}
              onChange={(e) => setSelectedPriority(e.target.value)}
              className="rounded-default border border-border-warm bg-cream-light px-3 py-2 text-button-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={pending}
            >
              <option value="must">{messages.commentsPage.filter.priorityMust}</option>
              <option value="should">{messages.commentsPage.filter.priorityShould}</option>
              <option value="may">{messages.commentsPage.filter.priorityMay}</option>
            </select>
            <div className="flex items-center justify-end gap-space-snug">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPriorityModalOpen(false)}
                disabled={pending}
                data-testid="priority-cancel"
              >
                {m.cancel}
              </Button>
              <Button
                type="button"
                variant="default"
                onClick={submitPriorityChange}
                disabled={pending}
                data-testid="priority-submit"
              >
                {pending ? m.submitting : m.submit}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-confirm-title"
          data-testid="comments-delete-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 px-space-snug"
        >
          <div className="flex w-full max-w-md flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-loose shadow-l3-focus">
            <h2
              id="delete-confirm-title"
              className="text-card-title font-medium text-charcoal"
            >
              {m.deleteConfirmTitle}
            </h2>
            <p className="text-button-sm text-muted">
              {m.deleteConfirmBody(count)}
            </p>
            <div className="flex items-center justify-end gap-space-snug">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDeleteConfirmOpen(false)}
                disabled={pending}
                data-testid="delete-cancel"
              >
                {m.deleteConfirmNo}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={submitDelete}
                disabled={pending}
                data-testid="delete-submit"
              >
                {pending ? m.deleting : m.deleteConfirmYes}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Apply confirm modal */}
      {applyConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="apply-confirm-title"
          data-testid="comments-apply-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 px-space-snug"
        >
          <div className="flex w-full max-w-md flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-loose shadow-l3-focus">
            <h2
              id="apply-confirm-title"
              className="text-card-title font-medium text-charcoal"
            >
              {m.applyConfirmTitle}
            </h2>
            <p className="text-button-sm text-muted">
              {m.applyConfirmBody(count, applyKpi.affectedBooks, applyKpi.estimatedCostJpy)}
            </p>
            <div className="flex items-center justify-end gap-space-snug">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setApplyConfirmOpen(false)}
                disabled={pending}
                data-testid="apply-cancel"
              >
                {m.applyConfirmNo}
              </Button>
              <Button
                type="button"
                variant="default"
                onClick={confirmApply}
                disabled={pending}
                data-testid="apply-submit"
              >
                {m.applyConfirmYes}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
