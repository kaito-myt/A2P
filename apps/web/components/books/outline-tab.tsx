'use client';

/**
 * S-010 アウトライン タブ (T-04-09).
 *
 * 単冊版アウトライン表示 + 承認/差戻し操作。
 * S-011 (バルク承認) と同等の操作を 1 冊単位で行える。
 * 差戻しはモーダルでコメント入力を求める。
 */
import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import type {
  BookOutlineSerialized,
  BookStatus,
  OutlineStatus,
} from '@/lib/books-view';
import { formatDateTime } from '@/lib/books-view';

import { bulkApproveOutlines, bulkRejectOutlines } from '@/app/actions/outlines';

const m = messages.books.outline;

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function outlineStatusVariant(status: OutlineStatus): 'success' | 'must' | 'should' | 'neutral' {
  switch (status) {
    case 'approved':
      return 'success';
    case 'rejected':
      return 'must';
    case 'pending_review':
      return 'should';
    default:
      return 'neutral';
  }
}

function outlineStatusLabel(status: OutlineStatus): string {
  switch (status) {
    case 'draft':
      return m.statusDraft;
    case 'pending_review':
      return m.statusPendingReview;
    case 'approved':
      return m.statusApproved;
    case 'rejected':
      return m.statusRejected;
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface OutlineTabProps {
  outline: BookOutlineSerialized | null;
  bookId: string;
  bookStatus: BookStatus;
  onAction: () => void;
}

export function OutlineTab({ outline, bookId, bookStatus, onAction }: OutlineTabProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  if (!outline) {
    return (
      <div
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        data-testid="outline-tab-empty"
      >
        <p className="text-body text-muted">{m.noOutline}</p>
      </div>
    );
  }

  const canApproveReject = outline.status === 'pending_review';

  const handleApprove = useCallback(() => {
    setError(null);
    setSuccessMessage(null);
    startTransition(async () => {
      const result = await bulkApproveOutlines({ outline_ids: [outline.id] });
      if (result.ok) {
        setSuccessMessage(m.approveSuccess);
        router.refresh();
        onAction();
      } else {
        setError(result.error?.message ?? messages.books.errors.approveUnknown);
      }
    });
  }, [outline.id, router, onAction]);

  const handleRejectSubmit = useCallback(() => {
    if (!rejectNote.trim()) {
      setError(m.rejectNoteRequired);
      return;
    }
    setError(null);
    setSuccessMessage(null);
    startTransition(async () => {
      const result = await bulkRejectOutlines({
        items: [{ outline_id: outline.id, reject_note: rejectNote.trim() }],
      });
      if (result.ok) {
        setSuccessMessage(m.rejectSuccess);
        setShowRejectModal(false);
        setRejectNote('');
        router.refresh();
        onAction();
      } else {
        setError(result.error?.message ?? messages.books.errors.rejectUnknown);
      }
    });
  }, [outline.id, rejectNote, router, onAction]);

  return (
    <div className="flex flex-col gap-space-snug" data-testid="outline-tab">
      {/* Status & Meta */}
      <div
        className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 text-button-sm text-charcoal-82"
        data-testid="outline-meta"
      >
        <span>
          {m.statusLabel}:{' '}
          <Badge variant={outlineStatusVariant(outline.status)}>
            {outlineStatusLabel(outline.status)}
          </Badge>
        </span>
        <span>
          {m.createdAtLabel}: {formatDateTime(outline.created_at)}
        </span>
        {outline.approved_at && (
          <span>
            {m.approvedAtLabel}: {formatDateTime(outline.approved_at)}
          </span>
        )}
        <span>
          {m.totalCharsLabel}: {outline.total_target_chars.toLocaleString('ja-JP')} {m.totalCharsSuffix}
        </span>
      </div>

      {/* Reject note */}
      {outline.reject_note && (
        <div
          className="rounded-snug border border-destructive-bg bg-destructive-bg/30 p-space-snug text-body text-destructive"
          data-testid="outline-reject-note"
        >
          <strong>{m.rejectNoteLabel}:</strong> {outline.reject_note}
        </div>
      )}

      {/* Chapter list */}
      {outline.chapters.length === 0 ? (
        <p className="text-body text-muted">{m.noChapters}</p>
      ) : (
        <div className="flex flex-col gap-space-snug" data-testid="outline-chapters-list">
          {outline.chapters.map((ch, i) => {
            const idx = ch.index ?? i + 1;
            return (
              <div
                key={`${idx}-${ch.heading}`}
                className="rounded-card border border-border-warm bg-cream p-space-snug"
                data-testid={`outline-chapter-${idx}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-card-title">
                    {m.chapterPrefix(idx)}: {ch.heading}
                  </h3>
                  {typeof ch.target_chars === 'number' && (
                    <span className="text-caption text-muted">
                      {ch.target_chars.toLocaleString('ja-JP')} {m.targetCharsSuffix}
                    </span>
                  )}
                </div>
                {ch.summary && (
                  <div className="mt-1">
                    <span className="text-caption text-muted">{m.summaryLabel}: </span>
                    <span className="text-body">{ch.summary}</span>
                  </div>
                )}
                {ch.subheadings && ch.subheadings.length > 0 && (
                  <div className="mt-1">
                    <span className="text-caption text-muted">{m.subheadingsLabel}: </span>
                    <span className="text-body">{ch.subheadings.join(' / ')}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Feedback */}
      {error && (
        <div className="rounded-snug bg-destructive-bg p-space-snug text-body text-destructive" data-testid="outline-error">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="rounded-snug bg-success-bg p-space-snug text-body text-success" data-testid="outline-success">
          {successMessage}
        </div>
      )}

      {/* Approve / Reject actions */}
      {canApproveReject && (
        <div className="flex gap-space-snug" data-testid="outline-actions">
          <button
            type="button"
            className="rounded-card bg-foreground px-4 py-2 text-button-sm text-cream hover:bg-charcoal-82 disabled:opacity-50"
            onClick={handleApprove}
            disabled={isPending}
            data-testid="outline-approve-btn"
          >
            {isPending ? m.approving : m.approve}
          </button>
          <button
            type="button"
            className="rounded-card border border-border-warm bg-cream px-4 py-2 text-button-sm text-foreground hover:bg-charcoal-04 disabled:opacity-50"
            onClick={() => setShowRejectModal(true)}
            disabled={isPending}
            data-testid="outline-reject-btn"
          >
            {m.reject}
          </button>
        </div>
      )}

      {/* Reject modal (simple inline) */}
      {showRejectModal && (
        <div
          className="rounded-card border border-border-warm bg-cream-light p-space-loose"
          data-testid="outline-reject-modal"
        >
          <h3 className="text-card-title">{m.rejectModalTitle}</h3>
          <p className="mt-1 text-caption text-muted">{m.rejectModalDescription}</p>
          <textarea
            className="mt-space-snug w-full rounded-snug border border-border-warm bg-cream p-space-snug text-body focus:outline-none focus:ring-2 focus:ring-accent"
            rows={3}
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            placeholder={m.rejectNotePlaceholder}
            data-testid="outline-reject-note-input"
          />
          <div className="mt-space-snug flex gap-space-snug">
            <button
              type="button"
              className="rounded-card bg-foreground px-4 py-2 text-button-sm text-cream hover:bg-charcoal-82 disabled:opacity-50"
              onClick={handleRejectSubmit}
              disabled={isPending}
              data-testid="outline-reject-submit-btn"
            >
              {isPending ? m.rejecting : m.submit}
            </button>
            <button
              type="button"
              className="rounded-card border border-border-warm bg-cream px-4 py-2 text-button-sm text-foreground hover:bg-charcoal-04"
              onClick={() => {
                setShowRejectModal(false);
                setRejectNote('');
                setError(null);
              }}
              data-testid="outline-reject-cancel-btn"
            >
              {m.cancel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
