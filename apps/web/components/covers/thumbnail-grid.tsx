'use client';

/**
 * S-012 ThumbnailGrid (T-05-10, F-019).
 *
 * Bulk grid view: each card = one book with its cover candidates (up to 3).
 *
 * data-testid:
 *  - covers-grid
 *  - covers-select-all
 *  - cover-book-card-{book.id}
 *  - cover-book-checkbox-{book.id}
 *  - cover-image-{cover.id}
 */
import { CommentBadge } from '@/components/comments/comment-badge';
import { messages } from '@/lib/messages';
import {
  extractCoverCost,
  formatGenre,
  type BookCoverGroup,
  type CoverRowSerialized,
} from '@/lib/covers-view';

const m = messages.covers;

interface ThumbnailGridProps {
  groups: readonly BookCoverGroup[];
  selectedBookIds: ReadonlySet<string>;
  onToggle: (bookId: string) => void;
  onToggleAll: (selectAll: boolean) => void;
  onOpenSingle: (bookId: string) => void;
}

export function ThumbnailGrid({
  groups,
  selectedBookIds,
  onToggle,
  onToggleAll,
  onOpenSingle,
}: ThumbnailGridProps) {
  const eligibleGroups = groups.filter((g) =>
    g.covers.some((c) => c.status === 'generated'),
  );
  const allSelected =
    eligibleGroups.length > 0 &&
    eligibleGroups.every((g) => selectedBookIds.has(g.book.id));

  return (
    <section data-testid="covers-grid" className="flex flex-col gap-space-snug">
      <div className="flex items-center justify-between border-b border-border-warm pb-space-snug">
        <label className="flex items-center gap-2 text-button-sm text-charcoal-82">
          <input
            type="checkbox"
            checked={allSelected}
            disabled={eligibleGroups.length === 0}
            onChange={(e) => onToggleAll(e.currentTarget.checked)}
            data-testid="covers-select-all"
            aria-label={m.bulk.selectAll}
          />
          <span>{m.bulk.selectAll}</span>
        </label>
        <span className="text-button-sm text-muted">
          {m.summary.pending(eligibleGroups.length)}
        </span>
      </div>

      <div className="flex flex-col gap-space-snug">
        {groups.map((group) => (
          <BookCoverCard
            key={group.book.id}
            group={group}
            checked={selectedBookIds.has(group.book.id)}
            onToggle={onToggle}
            onOpenSingle={onOpenSingle}
          />
        ))}
      </div>
    </section>
  );
}

interface BookCoverCardProps {
  group: BookCoverGroup;
  checked: boolean;
  onToggle: (bookId: string) => void;
  onOpenSingle: (bookId: string) => void;
}

function BookCoverCard({
  group,
  checked,
  onToggle,
  onOpenSingle,
}: BookCoverCardProps) {
  const { book, covers, comments } = group;
  const hasGenerated = covers.some((c) => c.status === 'generated');
  const failedCount = covers.filter(
    (c) => c.status !== 'generated' && c.status !== 'adopted' && c.status !== 'rejected',
  ).length;
  const genreLabel = formatGenre(book.genre);

  const pendingComments = comments.filter((c) => c.status === 'pending');
  const mustComments = pendingComments.filter((c) => c.priority === 'must').length;

  return (
    <article
      data-testid={`cover-book-card-${book.id}`}
      data-selected={checked ? 'true' : 'false'}
      className={`flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed ${
        checked ? 'ring-2 ring-charcoal-40' : ''
      }`}
    >
      <header className="flex items-start gap-space-snug">
        <input
          type="checkbox"
          className="mt-1"
          checked={checked}
          disabled={!hasGenerated}
          onChange={() => onToggle(book.id)}
          aria-label={m.card.selectLabel}
          data-testid={`cover-book-checkbox-${book.id}`}
        />
        <div className="flex-1">
          <h2 className="text-card-title font-medium text-charcoal">
            {book.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-space-snug text-button-sm text-muted">
            {genreLabel && <span>{genreLabel}</span>}
            <span>
              {m.card.coverCandidatesLabel}: {covers.length}
            </span>
            {failedCount > 0 && (
              <span className="text-destructive">
                {m.card.errorBadge(failedCount)}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {pendingComments.length > 0 && (
            <span data-testid={`cover-book-comment-badge-${book.id}`}>
              <CommentBadge
                pending={pendingComments.length}
                must={mustComments}
              />
            </span>
          )}
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => onOpenSingle(book.id)}
              className="text-button-sm text-foreground underline hover:no-underline"
              data-testid={`cover-compare-${book.id}`}
            >
              {m.card.compareSingle}
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap gap-space-snug">
        {covers.map((cover) => (
          <CoverThumbnail key={cover.id} cover={cover} />
        ))}
      </div>
    </article>
  );
}

interface CoverThumbnailProps {
  cover: CoverRowSerialized;
}

function CoverThumbnail({ cover }: CoverThumbnailProps) {
  const cost = extractCoverCost(cover.generation_meta_json);
  const statusLabel =
    cover.status === 'generated'
      ? m.card.generatedStatus
      : cover.status === 'adopted'
        ? m.card.adoptedStatus
        : m.card.rejectedStatus;

  return (
    <div
      data-testid={`cover-image-${cover.id}`}
      className={`relative flex w-[140px] flex-col gap-1 rounded-default border p-2 ${
        cover.status === 'adopted'
          ? 'border-charcoal bg-cream'
          : 'border-border-warm bg-cream-light'
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- R2 署名 URL への 302 リダイレクトを Cookie 付きで取得するため素の img を使う (next/image 最適化は Cookie 非送出で middleware に弾かれる) */}
      <img
        src={`/api/covers/${cover.id}/image`}
        alt={statusLabel}
        loading="lazy"
        className="h-[180px] w-full rounded-default border border-border-warm bg-cream object-cover"
      />
      <span
        className={`text-center text-button-sm ${
          cover.status === 'adopted'
            ? 'font-medium text-charcoal'
            : 'text-muted'
        }`}
      >
        {statusLabel}
      </span>
      {cost !== null && (
        <span className="text-center text-button-sm text-muted">
          {`¥${Math.round(cost)}`}
        </span>
      )}
    </div>
  );
}
