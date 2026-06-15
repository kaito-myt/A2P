'use client';

/**
 * S-012 ThumbnailComparator (T-05-10, T-06-04, F-019, F-049).
 *
 * Single-book detail mode: shows all cover candidates side by side
 * at larger size, with cover text proposals below.
 *
 * T-06-04: CommentAffordance overlay on each cover card.
 *   - Click on image to select anchor region (image_region).
 *   - Existing comments with image_region shown as CommentBadge overlays.
 *
 * data-testid:
 *  - covers-comparator
 *  - cover-comparator-image-{cover.id}
 *  - cover-comparator-adopt-{cover.id}
 *  - cover-comment-overlay-{cover.id}
 *  - cover-region-badge-{comment.id}
 */
import { useRouter } from 'next/navigation';
import { useState, useCallback, useTransition, type MouseEvent } from 'react';

import { bulkAdoptCovers } from '@/app/actions/covers';
import { Button } from '@/components/ui/button';
import { CommentAffordance } from '@/components/comments/comment-affordance';
import { CommentBadge } from '@/components/comments/comment-badge';
import { messages } from '@/lib/messages';
import {
  extractCoverCost,
  extractCoverModel,
  type BookCoverGroup,
  type CoverRowSerialized,
  type CoverCommentSerialized,
} from '@/lib/covers-view';
import { clickToImageRegion, getImageRegion } from '@/lib/comment-helpers';
import type { CommentPriority, CommentStatus } from '@/lib/comment-helpers';

import { CoverTextProposalsList } from './cover-text-proposals-list';

const m = messages.covers;

interface ThumbnailComparatorProps {
  group: BookCoverGroup;
  currentIndex: number;
  totalCount: number;
  onPrev: () => void;
  onNext: () => void;
  onBackToList: () => void;
  onCommentChange?: () => void;
}

export function ThumbnailComparator({
  group,
  currentIndex,
  totalCount,
  onPrev,
  onNext,
  onBackToList,
  onCommentChange,
}: ThumbnailComparatorProps) {
  const { book, covers, coverTextProposals, comments } = group;

  return (
    <div
      data-testid="covers-comparator"
      className="flex flex-col gap-space-loose"
    >
      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBackToList}
          className="text-button-sm text-foreground underline hover:no-underline"
          data-testid="covers-back-to-list"
        >
          {m.comparator.backToList}
        </button>
        <div className="flex items-center gap-space-snug">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={currentIndex === 0}
            onClick={onPrev}
            data-testid="covers-prev-book"
          >
            {m.comparator.prevBook}
          </Button>
          <span className="text-button-sm text-muted">
            {currentIndex + 1} / {totalCount}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={currentIndex >= totalCount - 1}
            onClick={onNext}
            data-testid="covers-next-book"
          >
            {m.comparator.nextBook}
          </Button>
        </div>
      </div>

      {/* Book title */}
      <h2 className="text-sub-heading text-foreground">{book.title}</h2>

      {/* Cover candidates side by side */}
      <section className="flex flex-col gap-space-snug">
        <h3 className="text-card-title font-medium text-charcoal">
          {m.comparator.heading}
        </h3>
        <div className="flex flex-wrap gap-space-relaxed">
          {covers.map((cover, idx) => (
            <ComparatorCoverCard
              key={cover.id}
              cover={cover}
              index={idx}
              bookId={book.id}
              comments={comments.filter(
                (c) => c.target_kind === 'cover' && c.target_id === cover.id,
              )}
              onCommentChange={onCommentChange}
            />
          ))}
        </div>
      </section>

      {/* Cover text proposals */}
      <CoverTextProposalsList proposals={coverTextProposals} />
    </div>
  );
}

interface ComparatorCoverCardProps {
  cover: CoverRowSerialized;
  index: number;
  bookId: string;
  comments: CoverCommentSerialized[];
  onCommentChange?: () => void;
}

/**
 * Convert CoverCommentSerialized to ExistingComment shape for CommentDrawer.
 */
function toExistingComment(c: CoverCommentSerialized) {
  return {
    id: c.id,
    body: c.body,
    priority: c.priority as CommentPriority,
    status: c.status as CommentStatus,
    created_at: c.created_at,
  };
}

function ComparatorCoverCard({
  cover,
  index,
  bookId,
  comments,
  onCommentChange,
}: ComparatorCoverCardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [clickAnchor, setClickAnchor] = useState<Record<string, unknown> | null>(null);
  const cost = extractCoverCost(cover.generation_meta_json);
  const model = extractCoverModel(cover.generation_meta_json);
  const isAdopted = cover.status === 'adopted';
  const canAdopt = cover.status === 'generated';

  const pendingComments = comments.filter((c) => c.status === 'pending');
  const mustCount = pendingComments.filter((c) => c.priority === 'must').length;

  function handleAdopt() {
    setError(null);
    startTransition(async () => {
      const result = await bulkAdoptCovers({ cover_ids: [cover.id] });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      router.refresh();
    });
  }

  const handleImageClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      const region = clickToImageRegion(
        clickX,
        clickY,
        rect.width,
        rect.height,
      );
      setClickAnchor({ image_region: region });
    },
    [],
  );

  return (
    <div
      data-testid={`cover-comparator-image-${cover.id}`}
      className={`flex w-[240px] flex-col gap-2 rounded-card border p-space-snug ${
        isAdopted
          ? 'border-charcoal bg-cream'
          : 'border-border-warm bg-cream-light'
      }`}
    >
      <span className="text-button-sm font-medium text-charcoal-82">
        {m.comparator.candidateLabel(index + 1)}
      </span>

      {/* Image with comment overlay */}
      <div
        className="relative cursor-crosshair"
        data-testid={`cover-comment-overlay-${cover.id}`}
      >
        <div
          className="flex h-[300px] w-full items-center justify-center border border-border-warm bg-cream text-button-sm text-muted"
          onClick={handleImageClick}
          role="button"
          tabIndex={0}
          aria-label={m.comment.overlayHint}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              const region = clickToImageRegion(
                rect.width / 2,
                rect.height / 2,
                rect.width,
                rect.height,
              );
              setClickAnchor({ image_region: region });
            }
          }}
        >
          {m.card.coverPlaceholder}
        </div>

        {/* Existing comment badges at their image_region positions */}
        {pendingComments.map((c) => {
          const region = getImageRegion(c.range_json);
          if (!region) return null;
          return (
            <div
              key={c.id}
              data-testid={`cover-region-badge-${c.id}`}
              className="absolute"
              style={{
                left: `${region.x * 100}%`,
                top: `${region.y * 100}%`,
                width: `${region.w * 100}%`,
                height: `${region.h * 100}%`,
              }}
            >
              <div className="absolute inset-0 rounded border-2 border-dashed border-charcoal-40 bg-charcoal/5" />
              <div className="absolute -right-1 -top-1">
                <CommentBadge
                  pending={1}
                  must={c.priority === 'must' ? 1 : 0}
                  className="scale-75"
                />
              </div>
            </div>
          );
        })}

        {/* CommentAffordance icon */}
        <CommentAffordance
          bookId={bookId}
          targetKind="cover"
          targetId={cover.id}
          anchorJson={clickAnchor}
          existingComments={comments.map(toExistingComment)}
          onCommentChange={onCommentChange}
        />
      </div>

      {/* Meta */}
      <div className="flex flex-col gap-1 text-button-sm text-muted">
        {cost !== null && (
          <span>
            {m.comparator.costLabel}: &yen;{Math.round(cost)}
          </span>
        )}
        {model && (
          <span>
            {m.comparator.modelLabel}: {model}
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <span
          data-testid={`cover-comparator-error-${cover.id}`}
          className="text-button-sm text-destructive"
        >
          {error}
        </span>
      )}

      {/* Adopt button */}
      {isAdopted ? (
        <span className="text-center text-button-sm font-medium text-charcoal">
          {m.comparator.adopted}
        </span>
      ) : (
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={pending || !canAdopt}
          onClick={handleAdopt}
          data-testid={`cover-comparator-adopt-${cover.id}`}
        >
          {m.comparator.adoptButton}
        </Button>
      )}
    </div>
  );
}
