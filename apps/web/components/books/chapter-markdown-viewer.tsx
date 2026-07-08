'use client';

/**
 * S-010 章 Markdown ビューア (T-04-10 / T-06-03).
 *
 * 章セレクタ + react-markdown でレンダリング。
 * 段落ごとに CommentAffordance を配置し、既存コメントがあれば CommentBadge 表示。
 * anchor_json = { paragraph_range: [N, N] } で段落番号をタプルとして記録。
 */
import { useState, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useRouter } from 'next/navigation';

import { normalizeChapters } from '@a2p/contracts/book/chapter-title';

import { messages } from '@/lib/messages';
import type { BookChapterSerialized, RevisionCommentSerialized } from '@/lib/books-view';
import type { CommentPriority, CommentStatus } from '@/lib/comment-helpers';
import { groupCommentsByParagraph } from '@/lib/comment-helpers';
import { CommentAffordance } from '@/components/comments/comment-affordance';

const m = messages.books.chapters;

interface ChapterMarkdownViewerProps {
  chapters: BookChapterSerialized[];
  bookId?: string;
  comments?: RevisionCommentSerialized[];
}

/**
 * Convert RevisionCommentSerialized to ExistingComment for CommentDrawer.
 */
function toExistingComment(c: RevisionCommentSerialized) {
  return {
    id: c.id,
    body: c.body,
    priority: c.priority as CommentPriority,
    status: c.status as CommentStatus,
    created_at: c.created_at,
  };
}

export function ChapterMarkdownViewer({
  chapters,
  bookId,
  comments = [],
}: ChapterMarkdownViewerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const current = chapters[selectedIndex];
  const paragraphCounter = useRef(0);
  const router = useRouter();

  const handleCommentChange = useCallback(() => {
    router.refresh();
  }, [router]);

  if (!current) return null;

  // 章タイトルを正規化 (二重番号・前書き/後書きの番号付け解消)。index で引く。
  const titleByIndex = new Map(
    normalizeChapters(
      [...chapters]
        .sort((a, b) => a.index - b.index)
        .map((c) => ({ index: c.index, heading: c.heading })),
    ).map((n) => [n.index, n.titleLine]),
  );

  const chapterComments = groupCommentsByParagraph(comments, current.id);

  paragraphCounter.current = 0;

  return (
    <div className="flex flex-col gap-space-snug" data-testid="chapter-markdown-viewer">
      {/* Chapter selector */}
      <div className="flex items-center gap-space-snug">
        <label htmlFor="chapter-select" className="text-button-sm text-muted">
          {m.selectorLabel}
        </label>
        <select
          id="chapter-select"
          value={selectedIndex}
          onChange={(e) => setSelectedIndex(Number(e.target.value))}
          className="rounded-card border border-border-warm bg-cream px-2 py-1 text-body"
          data-testid="chapter-selector"
        >
          {chapters.map((ch, i) => (
            <option key={ch.id} value={i}>
              {titleByIndex.get(ch.index) ?? ch.heading}
            </option>
          ))}
        </select>
      </div>

      {/* Chapter metadata */}
      <div className="flex flex-wrap gap-x-space-relaxed gap-y-0.5 text-caption text-muted">
        <span>
          {current.char_count.toLocaleString('ja-JP')} {m.charCountSuffix}
        </span>
        <span>
          {m.versionPrefix}{current.version}
        </span>
      </div>

      {/* Markdown body with comment affordance anchors */}
      <div
        className="prose prose-sm max-w-none rounded-card border border-border-warm bg-cream-light p-space-snug"
        data-testid="chapter-markdown-body"
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children, ...props }) => {
              const pIdx = paragraphCounter.current++;
              const pComments = chapterComments.get(pIdx) ?? [];
              const pendingComments = pComments.filter((c) => c.status === 'pending');

              return (
                <div
                  className="group relative"
                  data-paragraph-index={pIdx}
                  data-testid={`paragraph-${pIdx}`}
                >
                  <p {...props}>{children}</p>
                  {bookId && (
                    <CommentAffordance
                      bookId={bookId}
                      targetKind="chapter"
                      targetId={current.id}
                      anchorJson={{ paragraph_range: [pIdx, pIdx] }}
                      existingComments={pComments.map(toExistingComment)}
                      onCommentChange={handleCommentChange}
                    />
                  )}
                  {!bookId && pendingComments.length === 0 && (
                    <button
                      type="button"
                      className="absolute -right-6 top-0 hidden text-muted opacity-60 hover:opacity-100 group-hover:inline-block"
                      data-testid="comment-affordance"
                      title={m.commentAnchorTitle}
                      tabIndex={-1}
                      disabled
                    >
                      +
                    </button>
                  )}
                </div>
              );
            },
          }}
        >
          {current.body_md}
        </ReactMarkdown>
      </div>
    </div>
  );
}
