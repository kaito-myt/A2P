'use client';

/**
 * S-010 章本文タブ (T-04-09 / T-04-10).
 *
 * 章がある場合は ChapterMarkdownViewer で Markdown レンダリング。
 * 章がない場合は空状態メッセージ。
 */
import { normalizeChapters } from '@a2p/contracts/book/chapter-title';

import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import type { BookChapterSerialized, BookStatus, RevisionCommentSerialized } from '@/lib/books-view';

import { ChapterMarkdownViewer } from './chapter-markdown-viewer';

const m = messages.books.chapters;

function chapterStatusVariant(status: string): 'success' | 'must' | 'neutral' {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'must';
    default:
      return 'neutral';
  }
}

interface ChaptersTabProps {
  chapters: BookChapterSerialized[];
  bookStatus: BookStatus;
  bookId?: string;
  comments?: RevisionCommentSerialized[];
}

export function ChaptersTab({ chapters, bookStatus, bookId, comments = [] }: ChaptersTabProps) {
  if (chapters.length === 0) {
    const isInProgress =
      bookStatus === 'running' || bookStatus === 'queued';
    return (
      <div
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        data-testid="chapters-tab-empty"
      >
        <p className="text-body text-muted">
          {isInProgress ? m.writerInProgress : m.noChapters}
        </p>
      </div>
    );
  }

  const hasDoneChapters = chapters.some((ch) => ch.status === 'done' && ch.body_md);

  // 章タイトルを正規化 (二重番号・前書き/後書きの番号付けを解消)。表示順=index 昇順。
  const sorted = [...chapters].sort((a, b) => a.index - b.index);
  const titleByIndex = new Map(
    normalizeChapters(sorted.map((c) => ({ index: c.index, heading: c.heading }))).map((n) => [
      n.index,
      n.titleLine,
    ]),
  );

  return (
    <div className="flex flex-col gap-space-snug" data-testid="chapters-tab">
      {/* Chapter metadata summary */}
      <div className="flex flex-col gap-space-snug">
        {sorted.map((ch) => (
          <div
            key={ch.id}
            className="flex items-baseline justify-between gap-2 text-caption"
            data-testid={`chapter-summary-${ch.index}`}
          >
            <span className="text-card-title">{titleByIndex.get(ch.index) ?? ch.heading}</span>
            <Badge variant={chapterStatusVariant(ch.status)}>{ch.status}</Badge>
          </div>
        ))}
      </div>

      {/* Markdown viewer */}
      {hasDoneChapters ? (
        <ChapterMarkdownViewer
          chapters={chapters.filter((ch) => ch.body_md)}
          bookId={bookId}
          comments={comments}
        />
      ) : (
        <div className="rounded-card border border-border-warm bg-cream-light p-space-snug text-center">
          <p className="text-body text-muted">{m.writerInProgress}</p>
        </div>
      )}
    </div>
  );
}
