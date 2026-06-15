'use client';

/**
 * ActionBar — S-023 プロンプト改訂承認アクション (T-11-07).
 *
 * ボタン:
 *  - 承認 (approve)
 *  - 編集して承認 (edit_and_approve) — textarea ダイアログ
 *  - 却下 (reject) — rejection_note 必須ダイアログ
 *  - ロールバック (rollback) — rollback_until が未来のときのみ enabled
 *
 * SA: decideProposal / rollbackAutoApproved (apps/web/app/actions/prompt-proposals.ts)
 * 成功時: data-testid="toast-success" のインライン通知 + router.refresh()
 */
import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { decideProposal, rollbackAutoApproved } from '@/app/actions/prompt-proposals';
import { messages } from '@/lib/messages';
import type { ProposalDetail } from '@/lib/prompt-proposals-view';

const m = messages.promptProposals.actions;

interface ActionBarProps {
  proposal: ProposalDetail;
}

export function ActionBar({ proposal }: ActionBarProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // 成功/エラー通知
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 却下ダイアログ
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [rejectionNote, setRejectionNote] = useState('');
  const [rejectNoteError, setRejectNoteError] = useState<string | null>(null);

  // 編集して承認ダイアログ
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editedBody, setEditedBody] = useState(proposal.proposed_body);

  const isPending = proposal.status === 'pending';
  const isAutoApproved = proposal.status === 'auto_approved';

  // ロールバック可否: rollback_until が未来かつ auto_approved
  const rollbackEnabled =
    isAutoApproved &&
    !!proposal.rollback_until &&
    new Date(proposal.rollback_until) > new Date();

  function clearMessages() {
    setSuccessMsg(null);
    setErrorMsg(null);
  }

  // 承認
  const handleApprove = useCallback(() => {
    clearMessages();
    startTransition(async () => {
      const result = await decideProposal({
        proposal_id: proposal.id,
        decision: 'approve',
      });
      if (!result.ok) {
        setErrorMsg(messages.promptProposals.toast.error(result.error.message));
        return;
      }
      setSuccessMsg(messages.promptProposals.toast.approveSuccess);
      router.refresh();
    });
  }, [proposal.id, router]);

  // 編集して承認 — ダイアログ送信
  const handleEditAndApprove = useCallback(() => {
    clearMessages();
    startTransition(async () => {
      const result = await decideProposal({
        proposal_id: proposal.id,
        decision: 'edit_and_approve',
        edited_body: editedBody,
      });
      if (!result.ok) {
        setErrorMsg(messages.promptProposals.toast.error(result.error.message));
        return;
      }
      setShowEditDialog(false);
      setSuccessMsg(messages.promptProposals.toast.approveSuccess);
      router.refresh();
    });
  }, [proposal.id, editedBody, router]);

  // 却下 — バリデーション + 送信
  const handleReject = useCallback(() => {
    if (!rejectionNote.trim()) {
      setRejectNoteError(m.rejectNoteRequired);
      return;
    }
    clearMessages();
    setRejectNoteError(null);
    startTransition(async () => {
      const result = await decideProposal({
        proposal_id: proposal.id,
        decision: 'reject',
        rejection_note: rejectionNote,
      });
      if (!result.ok) {
        setErrorMsg(messages.promptProposals.toast.error(result.error.message));
        return;
      }
      setShowRejectDialog(false);
      setRejectionNote('');
      setSuccessMsg(messages.promptProposals.toast.rejectSuccess);
      router.refresh();
    });
  }, [proposal.id, rejectionNote, router]);

  // ロールバック
  const handleRollback = useCallback(() => {
    clearMessages();
    startTransition(async () => {
      const result = await rollbackAutoApproved({ proposal_id: proposal.id });
      if (!result.ok) {
        setErrorMsg(messages.promptProposals.toast.error(result.error.message));
        return;
      }
      setSuccessMsg(messages.promptProposals.toast.rollbackSuccess);
      router.refresh();
    });
  }, [proposal.id, router]);

  return (
    <div
      data-testid="action-bar"
      className="flex flex-col gap-space-snug border-t border-border-warm pt-space-snug"
    >
      {/* 成功通知 */}
      {successMsg && (
        <p
          data-testid="toast-success"
          className="rounded-default bg-success-bg px-3 py-2 text-button-sm text-success"
        >
          {successMsg}
        </p>
      )}

      {/* エラー通知 */}
      {errorMsg && (
        <p
          data-testid="toast-error"
          className="rounded-default bg-destructive-bg px-3 py-2 text-button-sm text-destructive"
        >
          {errorMsg}
        </p>
      )}

      {/* アクションボタン群 */}
      <div className="flex flex-wrap items-center gap-space-snug">
        {/* 承認 */}
        <button
          type="button"
          disabled={!isPending || pending}
          onClick={handleApprove}
          data-testid="action-approve"
          className="rounded-default bg-foreground px-4 py-2 text-button-sm text-cream transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? m.approving : m.approve}
        </button>

        {/* 編集して承認 */}
        <button
          type="button"
          disabled={!isPending || pending}
          onClick={() => {
            setEditedBody(proposal.proposed_body);
            setShowEditDialog(true);
          }}
          data-testid="action-edit-approve"
          className="rounded-default border border-foreground px-4 py-2 text-button-sm text-foreground transition-colors hover:bg-charcoal-04 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {m.editAndApprove}
        </button>

        {/* 却下 */}
        <button
          type="button"
          disabled={!isPending || pending}
          onClick={() => {
            setRejectionNote('');
            setRejectNoteError(null);
            setShowRejectDialog(true);
          }}
          data-testid="action-reject"
          className="rounded-default border border-destructive px-4 py-2 text-button-sm text-destructive transition-colors hover:bg-destructive-bg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? m.rejecting : m.reject}
        </button>

        {/* ロールバック */}
        <button
          type="button"
          disabled={!rollbackEnabled || pending}
          onClick={handleRollback}
          data-testid="action-rollback"
          className="rounded-default border border-border-warm px-4 py-2 text-button-sm text-charcoal transition-colors hover:bg-charcoal-04 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? m.rollingBack : m.rollback}
        </button>
      </div>

      {/* 却下ダイアログ */}
      {showRejectDialog && (
        <div
          data-testid="reject-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setShowRejectDialog(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowRejectDialog(false);
          }}
        >
          <div
            className="w-full max-w-md rounded-default bg-cream p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={() => {}}
          >
            <h3 className="mb-2 text-lg font-bold text-charcoal">
              {m.rejectDialogTitle}
            </h3>
            <label
              htmlFor="rejection-note"
              className="mb-1 block text-button-sm font-medium text-charcoal"
            >
              {m.rejectDialogNoteLabel}
            </label>
            <textarea
              id="rejection-note"
              value={rejectionNote}
              onChange={(e) => setRejectionNote(e.target.value)}
              placeholder={m.rejectDialogNotePlaceholder}
              rows={4}
              data-testid="rejection-note-input"
              className="w-full resize-none rounded-default border border-border-warm bg-white p-2 text-button-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-accent"
            />
            {rejectNoteError && (
              <p
                data-testid="rejection-note-error"
                className="mt-1 text-caption text-destructive"
              >
                {rejectNoteError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setShowRejectDialog(false)}
                data-testid="reject-dialog-cancel"
                className="rounded-default border border-border-warm bg-cream px-4 py-2 text-button-sm text-charcoal"
              >
                {m.rejectDialogCancel}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={handleReject}
                data-testid="reject-dialog-submit"
                className="rounded-default bg-destructive px-4 py-2 text-button-sm text-cream disabled:opacity-60"
              >
                {pending ? m.rejecting : m.rejectDialogSubmit}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 編集して承認ダイアログ */}
      {showEditDialog && (
        <div
          data-testid="edit-approve-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setShowEditDialog(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowEditDialog(false);
          }}
        >
          <div
            className="w-full max-w-2xl rounded-default bg-cream p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={() => {}}
          >
            <h3 className="mb-2 text-lg font-bold text-charcoal">
              {m.editDialogTitle}
            </h3>
            <label
              htmlFor="edited-body"
              className="mb-1 block text-button-sm font-medium text-charcoal"
            >
              {m.editDialogBodyLabel}
            </label>
            <textarea
              id="edited-body"
              value={editedBody}
              onChange={(e) => setEditedBody(e.target.value)}
              rows={12}
              data-testid="edited-body-input"
              className="w-full resize-y rounded-default border border-border-warm bg-white p-2 font-mono text-caption text-charcoal focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setShowEditDialog(false)}
                data-testid="edit-approve-dialog-cancel"
                className="rounded-default border border-border-warm bg-cream px-4 py-2 text-button-sm text-charcoal"
              >
                {m.editDialogCancel}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={handleEditAndApprove}
                data-testid="edit-approve-dialog-submit"
                className="rounded-default bg-foreground px-4 py-2 text-button-sm text-cream disabled:opacity-60"
              >
                {pending ? m.approving : m.editDialogSubmit}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
