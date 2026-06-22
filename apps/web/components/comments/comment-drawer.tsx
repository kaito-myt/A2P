'use client';

/**
 * CommentDrawer — right slide-in drawer for comment creation & listing (docs/04 §5).
 *
 * Uses shadcn Sheet (Radix Dialog) per docs/04 §6.2:
 *   "ドロワー（右側スライドイン）で文脈を保持したまま編集を行う"
 *
 * Upper section: new comment form (body textarea + priority select + submit).
 * Lower section: existing comments list (priority badge + body + edit/delete).
 * Inline edit mode: body textarea + priority select + save/cancel.
 */
import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

import { messages } from '@/lib/messages';
import { sortComments, targetKindLabel, type CommentPriority, type CommentStatus, type TargetKind } from '@/lib/comment-helpers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

import { createComment, updateComment, deleteComment } from '@/app/actions/comments';

const m = messages.comments.drawer;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExistingComment {
  id: string;
  body: string;
  priority: CommentPriority;
  status: CommentStatus;
  created_at: string;
}

export interface CommentDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookId: string;
  targetKind: TargetKind;
  targetId: string;
  anchorJson?: Record<string, unknown> | null;
  existingComments?: ExistingComment[];
  onCommentCreated?: () => void;
  onCommentUpdated?: () => void;
  onCommentDeleted?: () => void;
}

// ---------------------------------------------------------------------------
// Priority select helper
// ---------------------------------------------------------------------------

function PrioritySelect({
  value,
  onChange,
  id,
}: {
  value: CommentPriority;
  onChange: (p: CommentPriority) => void;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as CommentPriority)}
      className="rounded-card border border-border-warm bg-cream px-2 py-1 text-body"
      data-testid="priority-select"
    >
      <option value="must">{m.priorityMust}</option>
      <option value="should">{m.priorityShould}</option>
      <option value="may">{m.priorityMay}</option>
    </select>
  );
}

// ---------------------------------------------------------------------------
// Inline edit row
// ---------------------------------------------------------------------------

function CommentEditRow({
  comment,
  onSave,
  onCancel,
}: {
  comment: ExistingComment;
  onSave: (id: string, body: string, priority: CommentPriority) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(comment.body);
  const [priority, setPriority] = useState<CommentPriority>(comment.priority);

  return (
    <div className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream p-3" data-testid="comment-edit-row">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="min-h-[80px] w-full rounded-card border border-border-warm bg-cream-light p-2 text-body"
        maxLength={2000}
        data-testid="comment-edit-body"
      />
      <div className="flex items-center gap-2">
        <PrioritySelect value={priority} onChange={setPriority} />
        <Button
          size="sm"
          onClick={() => onSave(comment.id, body, priority)}
          disabled={!body.trim()}
          data-testid="comment-save-btn"
        >
          {m.saveButton}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="comment-cancel-btn">
          {m.cancelButton}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comment row (display mode)
// ---------------------------------------------------------------------------

function CommentRow({
  comment,
  onEdit,
  onDelete,
}: {
  comment: ExistingComment;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-card border border-border-warm bg-cream-light p-3"
      data-testid="comment-row"
    >
      <div className="flex items-center justify-between gap-2">
        <Badge variant={comment.priority} data-testid="comment-priority-badge">
          {comment.priority}
        </Badge>
        <span className="text-caption text-muted">
          {new Date(comment.created_at).toLocaleString('ja-JP')}
        </span>
      </div>
      <p className="whitespace-pre-wrap text-body text-charcoal" data-testid="comment-body">
        {comment.body}
      </p>
      {comment.status === 'pending' && (
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onEdit(comment.id)}
            data-testid="comment-edit-btn"
          >
            {m.editButton}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete(comment.id)}
            data-testid="comment-delete-btn"
          >
            {m.deleteButton}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main CommentDrawer
// ---------------------------------------------------------------------------

export function CommentDrawer({
  open,
  onOpenChange,
  bookId,
  targetKind,
  targetId,
  anchorJson,
  existingComments = [],
  onCommentCreated,
  onCommentUpdated,
  onCommentDeleted,
}: CommentDrawerProps) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<CommentPriority>('should');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedComments = sortComments(existingComments);

  const handleSubmit = useCallback(async () => {
    if (!body.trim()) return;
    setIsPending(true);
    setError(null);
    const rangePayload = anchorJson ?? null;
    const result = await createComment({
      book_id: bookId,
      target_kind: targetKind,
      target_id: targetId,
      range: rangePayload,
      body: body.trim(),
      priority,
    });
    setIsPending(false);
    if (result.ok) {
      setBody('');
      setPriority('should');
      onCommentCreated?.();
      // 呼び出し側が onCommentChange を渡していない画面 (チェックリスト等) でも
      // 登録結果が反映されるよう、RSC を再取得する。
      router.refresh();
    } else {
      setError(result.error?.message ?? messages.comments.errors.createUnknown);
    }
  }, [body, priority, bookId, targetKind, targetId, anchorJson, onCommentCreated, router]);

  const handleSaveEdit = useCallback(
    async (commentId: string, newBody: string, newPriority: CommentPriority) => {
      setIsPending(true);
      setError(null);
      const result = await updateComment({
        comment_id: commentId,
        body: newBody.trim(),
        priority: newPriority,
      });
      setIsPending(false);
      if (result.ok) {
        setEditingId(null);
        onCommentUpdated?.();
        router.refresh();
      } else {
        setError(result.error?.message ?? messages.comments.errors.updateUnknown);
      }
    },
    [onCommentUpdated, router],
  );

  const handleDelete = useCallback(
    async (commentId: string) => {
      setIsPending(true);
      setError(null);
      const result = await deleteComment({ comment_id: commentId });
      setIsPending(false);
      if (result.ok) {
        onCommentDeleted?.();
        router.refresh();
      } else {
        setError(result.error?.message ?? messages.comments.errors.deleteUnknown);
      }
    },
    [onCommentDeleted, router],
  );

  const kindLabel = targetKindLabel(targetKind);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" data-testid="comment-drawer">
        <SheetHeader>
          <SheetTitle>{m.title}</SheetTitle>
          <SheetDescription>{kindLabel}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-space-relaxed overflow-y-auto px-6 py-4">
          {/* New comment form */}
          <section data-testid="new-comment-form">
            <h3 className="mb-2 text-button-sm font-medium text-charcoal">
              {m.newCommentHeading}
            </h3>
            <div className="flex flex-col gap-space-snug">
              <label htmlFor="comment-body" className="sr-only">
                {m.bodyLabel}
              </label>
              <textarea
                id="comment-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={m.bodyPlaceholder}
                className="min-h-[100px] w-full rounded-card border border-border-warm bg-cream p-2 text-body placeholder:text-muted"
                maxLength={2000}
                data-testid="new-comment-body"
              />
              <div className="flex items-center gap-2">
                <label htmlFor="comment-priority" className="text-caption text-muted">
                  {m.priorityLabel}
                </label>
                <PrioritySelect
                  id="comment-priority"
                  value={priority}
                  onChange={setPriority}
                />
              </div>
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={isPending || !body.trim()}
                data-testid="new-comment-submit"
              >
                {isPending ? m.submitting : m.submit}
              </Button>
              {error && (
                <p
                  role="alert"
                  className="text-caption text-destructive"
                  data-testid="comment-error"
                >
                  {error}
                </p>
              )}
            </div>
          </section>

          {/* Existing comments */}
          <section data-testid="existing-comments">
            <h3 className="mb-2 text-button-sm font-medium text-charcoal">
              {m.existingHeading}
              {sortedComments.length > 0 && (
                <span className="ml-1 font-normal text-muted">
                  ({sortedComments.length})
                </span>
              )}
            </h3>
            {sortedComments.length === 0 ? (
              <p className="text-caption text-muted" data-testid="no-comments">
                {m.noComments}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {sortedComments.map((c) =>
                  editingId === c.id ? (
                    <CommentEditRow
                      key={c.id}
                      comment={c}
                      onSave={handleSaveEdit}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <CommentRow
                      key={c.id}
                      comment={c}
                      onEdit={setEditingId}
                      onDelete={handleDelete}
                    />
                  ),
                )}
              </div>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
