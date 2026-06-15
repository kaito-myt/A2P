'use client';

/**
 * CommentAffordance — "+ コメント" icon trigger per target_kind (docs/04 §5).
 *
 * Display style varies by target_kind:
 *   - chapter:   paragraph inline icon (right edge, hover reveal)
 *   - cover:     image overlay icon (fixed position; coordinate selection in T-06-04)
 *   - metadata / theme / outline / cover_text:  field-adjacent icon
 *
 * Clicking opens CommentDrawer.
 */
import { useState, useCallback } from 'react';

import { messages } from '@/lib/messages';
import type { CommentPriority, CommentStatus, TargetKind } from '@/lib/comment-helpers';
import { CommentBadge } from './comment-badge';
import { CommentDrawer, type ExistingComment } from './comment-drawer';

const m = messages.comments.affordance;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CommentAffordanceProps {
  bookId: string;
  targetKind: TargetKind;
  targetId: string;
  anchorJson?: Record<string, unknown> | null;
  existingComments?: ExistingComment[];
  onCommentChange?: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Style per target_kind
// ---------------------------------------------------------------------------

function getAffordanceStyle(targetKind: TargetKind): {
  wrapper: string;
  button: string;
} {
  switch (targetKind) {
    case 'chapter':
      return {
        wrapper: 'absolute -right-8 top-0 opacity-0 transition-opacity group-hover:opacity-100',
        button:
          'flex h-6 w-6 items-center justify-center rounded-full border border-border-warm bg-cream text-caption text-muted hover:bg-charcoal-04 hover:text-charcoal',
      };
    case 'cover':
      return {
        wrapper: 'absolute right-2 top-2',
        button:
          'flex h-8 w-8 items-center justify-center rounded-full border border-border-warm bg-cream/90 text-body text-muted shadow-l1-soft hover:bg-cream hover:text-charcoal',
      };
    default:
      return {
        wrapper: 'inline-flex',
        button:
          'flex h-6 items-center gap-0.5 rounded-card border border-border-warm bg-cream px-1.5 text-caption text-muted hover:bg-charcoal-04 hover:text-charcoal',
      };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommentAffordance({
  bookId,
  targetKind,
  targetId,
  anchorJson,
  existingComments = [],
  onCommentChange,
  className,
}: CommentAffordanceProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const styles = getAffordanceStyle(targetKind);

  const pendingComments = existingComments.filter((c) => c.status === 'pending');
  const mustCount = pendingComments.filter((c) => c.priority === 'must').length;

  const handleCommentChange = useCallback(() => {
    onCommentChange?.();
  }, [onCommentChange]);

  return (
    <>
      <div className={`${styles.wrapper} ${className ?? ''}`} data-testid="comment-affordance">
        {pendingComments.length > 0 ? (
          <CommentBadge
            pending={pendingComments.length}
            must={mustCount}
            onClick={() => setDrawerOpen(true)}
          />
        ) : (
          <button
            type="button"
            className={styles.button}
            onClick={() => setDrawerOpen(true)}
            aria-label={m.addCommentAriaLabel}
            data-testid="comment-affordance-trigger"
          >
            <PlusIcon />
            {targetKind !== 'chapter' && targetKind !== 'cover' && (
              <span>{m.addComment}</span>
            )}
          </button>
        )}
      </div>

      <CommentDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        bookId={bookId}
        targetKind={targetKind}
        targetId={targetId}
        anchorJson={anchorJson}
        existingComments={existingComments}
        onCommentCreated={handleCommentChange}
        onCommentUpdated={handleCommentChange}
        onCommentDeleted={handleCommentChange}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline SVG icon
// ---------------------------------------------------------------------------

function PlusIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}
