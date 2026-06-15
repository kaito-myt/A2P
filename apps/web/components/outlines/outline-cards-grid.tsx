'use client';

/**
 * S-011 OutlineCardsGrid (T-04-08, F-018).
 *
 * 1 カード = 1 outline (= 1 書籍)。
 * カード構成 (docs/04 §4 S-011 / wireframes/S-011 desktop.png):
 *  - 左上にチェックボックス + 書籍タイトル
 *  - サブ情報: Book ID / ジャンル / 想定章数 / 想定総文字数
 *  - 章リスト (chapters[]): 「第 N 章: 見出し (X 字)」+ 要旨折りたたみ表示
 *
 * data-testid:
 *  - outlines-grid (ルート)
 *  - outlines-select-all (ヘッダ全選択)
 *  - outline-row-{outline.id} (カード)
 *  - outline-checkbox-{outline.id} (個別チェックボックス)
 *  - outline-title-{outline.id}
 *  - outline-chapter-{outline.id}-{index}
 */
import { useRouter } from 'next/navigation';

import { CommentAffordance } from '@/components/comments/comment-affordance';
import { messages } from '@/lib/messages';
import type { CommentPriority, CommentStatus } from '@/lib/comment-helpers';
import {
  formatDateTime,
  formatGenre,
  type OutlineChapterPlan,
  type OutlineCommentSerialized,
  type OutlineRowSerialized,
} from '@/lib/outlines-view';

const m = messages.outlines;

interface OutlineCardsGridProps {
  rows: readonly OutlineRowSerialized[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (selectAll: boolean) => void;
  commentsMap?: Record<string, OutlineCommentSerialized[]>;
}

export function OutlineCardsGrid({
  rows,
  selectedIds,
  onToggle,
  onToggleAll,
  commentsMap = {},
}: OutlineCardsGridProps) {
  const router = useRouter();
  const eligibleRows = rows.filter((r) => r.status === 'pending_review');
  const allEligibleSelected =
    eligibleRows.length > 0 && eligibleRows.every((r) => selectedIds.has(r.id));

  return (
    <section
      data-testid="outlines-grid"
      className="flex flex-col gap-space-snug"
    >
      <div className="flex items-center justify-between border-b border-border-warm pb-space-snug">
        <label className="flex items-center gap-2 text-button-sm text-charcoal-82">
          <input
            type="checkbox"
            checked={allEligibleSelected}
            disabled={eligibleRows.length === 0}
            onChange={(e) => onToggleAll(e.currentTarget.checked)}
            data-testid="outlines-select-all"
            aria-label={m.bulk.selectAll}
          />
          <span>{m.bulk.selectAll}</span>
        </label>
        <span className="text-button-sm text-muted">
          {m.summary.pending(eligibleRows.length)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-space-snug md:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => (
          <OutlineCard
            key={row.id}
            row={row}
            checked={selectedIds.has(row.id)}
            onToggle={onToggle}
            comments={commentsMap[row.id] ?? []}
            onCommentChange={() => router.refresh()}
          />
        ))}
      </div>
    </section>
  );
}

function toExistingComment(c: OutlineCommentSerialized) {
  return {
    id: c.id,
    body: c.body,
    priority: c.priority as CommentPriority,
    status: c.status as CommentStatus,
    created_at: c.created_at,
  };
}

interface OutlineCardProps {
  row: OutlineRowSerialized;
  checked: boolean;
  onToggle: (id: string) => void;
  comments: OutlineCommentSerialized[];
  onCommentChange?: () => void;
}

function OutlineCard({ row, checked, onToggle, comments, onCommentChange }: OutlineCardProps) {
  const disabled = row.status !== 'pending_review';
  const title = row.book?.title ?? row.book_id;
  const genreLabel = formatGenre(row.book?.genre);

  return (
    <article
      data-testid={`outline-row-${row.id}`}
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
          disabled={disabled}
          onChange={() => onToggle(row.id)}
          aria-label={m.card.selectLabel}
          data-testid={`outline-checkbox-${row.id}`}
        />
        <div className="flex-1">
          <h2
            data-testid={`outline-title-${row.id}`}
            className="text-card-title font-medium text-charcoal"
          >
            {title}
          </h2>
          <dl className="mt-1 grid grid-cols-2 gap-x-space-snug gap-y-0 text-button-sm text-muted">
            <div className="flex gap-1">
              <dt>{m.card.meta.bookId}:</dt>
              <dd className="truncate font-mono text-charcoal-82">
                {row.book_id.slice(0, 12)}…
              </dd>
            </div>
            {genreLabel && (
              <div className="flex gap-1">
                <dt>{m.card.meta.genre}:</dt>
                <dd className="text-charcoal-82">{genreLabel}</dd>
              </div>
            )}
            <div className="flex gap-1">
              <dt>{m.card.meta.chaptersCount(row.chapters.length)}</dt>
            </div>
            <div className="flex gap-1">
              <dt>{m.card.meta.totalChars(row.total_target_chars)}</dt>
            </div>
            <div className="col-span-2 flex gap-1">
              <dt>{m.card.meta.createdAt}:</dt>
              <dd className="text-charcoal-82">{formatDateTime(row.created_at)}</dd>
            </div>
          </dl>
        </div>
      </header>

      <section className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <h3 className="text-button-sm font-medium text-charcoal-82">
            {m.card.chaptersHeading}
          </h3>
          <CommentAffordance
            bookId={row.book_id}
            targetKind="outline"
            targetId={row.id}
            existingComments={comments.map(toExistingComment)}
            onCommentChange={onCommentChange}
          />
        </div>
        {row.chapters.length === 0 ? (
          <p className="text-button-sm text-muted">{m.card.noChapters}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {row.chapters.map((chapter, idx) => (
              <ChapterLine
                key={`${row.id}-${idx}`}
                outlineId={row.id}
                index={idx}
                chapter={chapter}
              />
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

interface ChapterLineProps {
  outlineId: string;
  index: number;
  chapter: OutlineChapterPlan;
}

function ChapterLine({ outlineId, index, chapter }: ChapterLineProps) {
  // chapter.index が欠落していたら表示順 (1-origin) で代用
  const labelIndex =
    typeof chapter.index === 'number' && Number.isFinite(chapter.index)
      ? chapter.index
      : index + 1;

  return (
    <li
      data-testid={`outline-chapter-${outlineId}-${index}`}
      className="rounded-default border border-border-warm/60 bg-cream px-space-snug py-2"
    >
      <div className="flex items-baseline justify-between gap-space-snug">
        <p className="text-button-sm font-medium text-charcoal">
          <span className="mr-2 text-charcoal-82">
            {m.card.chapterPrefix(labelIndex)}
          </span>
          {chapter.heading}
        </p>
        {typeof chapter.target_chars === 'number' && (
          <span className="shrink-0 text-button-sm text-muted">
            {chapter.target_chars.toLocaleString('ja-JP')}
            {m.card.targetCharsSuffix}
          </span>
        )}
      </div>
      {chapter.summary && (
        <p className="mt-1 text-button-sm text-charcoal-82">
          <span className="mr-1 font-medium text-muted">
            {m.card.summarySectionLabel}:
          </span>
          {chapter.summary}
        </p>
      )}
      {chapter.subheadings && chapter.subheadings.length > 0 && (
        <p className="mt-1 text-button-sm text-muted">
          <span className="mr-1 font-medium">
            {m.card.subheadingsSectionLabel}:
          </span>
          {chapter.subheadings.join(' / ')}
        </p>
      )}
    </li>
  );
}
