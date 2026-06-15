'use client';

/**
 * DiffReviewer — S-014 diff 表示 (T-06-09).
 *
 * Phase 1: 章本文の Markdown diff のみ実装。
 * サムネ before/after と JSON diff は placeholder 表示。
 *
 * diff ライブラリ (`diff` npm) の `diffLines` で行単位差分を計算し、
 * 追加行を緑背景、削除行を赤背景で表示。
 */
import { useState } from 'react';
import { diffLines, type Change } from 'diff';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { messages } from '@/lib/messages';
import type { RunCommentSerialized, ChapterDiffData } from '@/lib/revision-runs-view';

const m = messages.revisionRuns.diff;

interface DiffReviewerProps {
  comments: RunCommentSerialized[];
  chapterDiffs: ChapterDiffData[];
}

export function DiffReviewer({ comments, chapterDiffs }: DiffReviewerProps) {
  const firstComment = comments[0] as RunCommentSerialized | undefined;
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    firstComment?.id ?? null,
  );

  if (!firstComment) {
    return (
      <div
        data-testid="diff-reviewer-empty"
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
      >
        <p className="text-body text-muted">{m.noComments}</p>
      </div>
    );
  }

  const selectedComment: RunCommentSerialized =
    comments.find((c) => c.id === selectedCommentId) ?? firstComment;

  return (
    <div data-testid="diff-reviewer" className="flex flex-col gap-space-snug md:flex-row">
      {/* Left: Comment list */}
      <div className="w-full shrink-0 md:w-64">
        <h3 className="mb-2 text-card-title">{m.commentListHeading}</h3>
        <ul className="flex flex-col gap-1" data-testid="diff-comment-list">
          {comments.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelectedCommentId(c.id)}
                className={cn(
                  'w-full rounded-default px-3 py-2 text-left text-button-sm transition-colors',
                  c.id === selectedComment.id
                    ? 'bg-charcoal-04 text-charcoal'
                    : 'text-charcoal-82 hover:bg-charcoal-04',
                )}
                data-testid="diff-comment-item"
              >
                <div className="flex items-center gap-2">
                  <CommentStatusBadge status={c.status} />
                  <span className="truncate">{c.body.slice(0, 40)}</span>
                </div>
                <div className="mt-0.5 text-caption text-muted">
                  {c.book_title} / {c.target_kind}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Right: Diff content */}
      <div className="min-w-0 flex-1">
        <CommentDiffView
          comment={selectedComment}
          chapterDiffs={chapterDiffs}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommentStatusBadge
// ---------------------------------------------------------------------------

function CommentStatusBadge({ status }: { status: string }) {
  if (status === 'applied') {
    return <Badge variant="success">{m.appliedBadge}</Badge>;
  }
  if (status === 'not_applicable') {
    return <Badge variant="should">{m.notApplicableBadge}</Badge>;
  }
  return <Badge variant="neutral">{m.pendingBadge}</Badge>;
}

// ---------------------------------------------------------------------------
// CommentDiffView
// ---------------------------------------------------------------------------

function CommentDiffView({
  comment,
  chapterDiffs,
}: {
  comment: RunCommentSerialized;
  chapterDiffs: ChapterDiffData[];
}) {
  const appResult = comment.application_result_json;

  return (
    <Card data-testid="comment-diff-view">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CommentStatusBadge status={comment.status} />
          <span className="text-body">{comment.body}</span>
        </CardTitle>
        {comment.status === 'not_applicable' && appResult?.reason && (
          <p className="text-caption text-muted">
            {m.reasonLabel}: {appResult.reason}
          </p>
        )}
      </CardHeader>
      <CardContent>
        {comment.target_kind === 'chapter' ? (
          <ChapterDiffContent
            targetId={comment.target_id}
            chapterDiffs={chapterDiffs}
          />
        ) : comment.target_kind === 'cover' ? (
          <PlaceholderContent message={m.thumbnailPlaceholder} />
        ) : comment.target_kind === 'metadata' ? (
          <PlaceholderContent message={m.jsonDiffPlaceholder} />
        ) : (
          <PlaceholderContent message={m.jsonDiffPlaceholder} />
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ChapterDiffContent
// ---------------------------------------------------------------------------

function ChapterDiffContent({
  targetId,
  chapterDiffs,
}: {
  targetId: string;
  chapterDiffs: ChapterDiffData[];
}) {
  const diff = chapterDiffs.find((d) => d.chapter_id === targetId);

  if (!diff) {
    return (
      <p className="text-body text-muted">{m.noDiffs}</p>
    );
  }

  const changes = diffLines(diff.old_body_md, diff.new_body_md);

  return (
    <div className="flex flex-col gap-space-snug" data-testid="chapter-diff">
      <p className="text-button-sm text-charcoal-82">
        {m.chapterPrefix(diff.chapter_index)}: {diff.chapter_heading}
      </p>

      <div className="overflow-x-auto rounded-default border border-border-warm">
        <div className="font-mono text-caption leading-relaxed">
          {changes.map((change, i) => (
            <DiffBlock key={i} change={change} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DiffBlock({ change }: { change: Change }) {
  const lines = change.value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  if (change.added) {
    return (
      <>
        {lines.map((line, i) => (
          <div
            key={i}
            className="bg-success-bg px-3 py-0.5 text-success"
            data-testid="diff-line-added"
          >
            + {line}
          </div>
        ))}
      </>
    );
  }

  if (change.removed) {
    return (
      <>
        {lines.map((line, i) => (
          <div
            key={i}
            className="bg-destructive-bg px-3 py-0.5 text-destructive"
            data-testid="diff-line-removed"
          >
            - {line}
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className="px-3 py-0.5 text-charcoal-82">
          &nbsp; {line}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// PlaceholderContent
// ---------------------------------------------------------------------------

function PlaceholderContent({ message }: { message: string }) {
  return (
    <div
      className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
      data-testid="diff-placeholder"
    >
      <p className="text-body text-muted">{message}</p>
    </div>
  );
}
