'use client';

/**
 * ChecklistDetailShell — 1 冊分の KDP 入稿チェックリスト詳細 (S-015 詳細).
 *
 * 一覧 (/kdp/checklist) から書籍を選んで遷移する詳細ページ用。
 * 旧 ChecklistPageShell のタブを廃し、単一書籍の編集に専念する。
 */
import { useState, useCallback, useTransition } from 'react';
import Link from 'next/link';

import { messages } from '@/lib/messages';
import type { ChecklistBookView } from '@/lib/kdp-checklist-view';
import { PublishStatusControl } from '@/components/books/publish-status-control';
import { generateBookReadings } from '@/app/actions/books';

import { BookInfoHeader } from './book-info-header';
import { BlockReasonBanner } from './block-reason-banner';
import { SubmissionChecklistTable } from './submission-checklist-table';
import { SubmitToKdpButton } from './submit-to-kdp-button';

const m = messages.kdpChecklist;

export function ChecklistDetailShell({ book: initialBook }: { book: ChecklistBookView }) {
  const [book, setBook] = useState<ChecklistBookView>(initialBook);
  const [readingsPending, startReadings] = useTransition();
  const [readingsInfo, setReadingsInfo] = useState<string | null>(null);

  function handleGenerateReadings() {
    setReadingsInfo(null);
    startReadings(async () => {
      const res = await generateBookReadings({ book_id: book.id });
      setReadingsInfo(
        res.ok ? messages.kdpChecklist.readings.started : res.error?.message ?? messages.kdpChecklist.readings.error,
      );
    });
  }

  const handleFieldUpdate = useCallback(
    (_bookId: string, field: string, patch: { copied?: boolean; checked?: boolean }) => {
      setBook((prev) => {
        const updatedFields = prev.fields.map((f) => {
          if (f.field !== field) return f;
          const nextCopied = patch.copied !== undefined ? patch.copied : f.copied;
          const nextChecked = patch.checked !== undefined ? patch.checked : f.checked;
          return {
            ...f,
            copied: nextCopied,
            checked: nextChecked,
            checked_at: nextChecked ? (f.checked_at ?? new Date().toISOString()) : undefined,
          };
        });
        const checkedCount = updatedFields.filter((f) => f.checked).length;
        return { ...prev, fields: updatedFields, checkedCount };
      });
    },
    [],
  );

  return (
    <div className="flex flex-col gap-space-loose pb-12" data-testid="checklist-detail-shell">
      <Link
        href="/kdp/checklist"
        className="text-button-sm text-foreground underline underline-offset-4 hover:no-underline"
        data-testid="checklist-back-to-list"
      >
        ← {m.backToList}
      </Link>

      <BookInfoHeader book={book} />

      {book.hasBlockingComments && (
        <BlockReasonBanner
          mustCommentCount={book.mustCommentCount}
          mustComments={book.mustComments}
        />
      )}

      {!book.metadataMissing && (
        <div className="flex flex-wrap items-center gap-space-snug">
          <button
            type="button"
            onClick={handleGenerateReadings}
            disabled={readingsPending}
            className="inline-flex items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            data-testid="generate-readings-btn"
          >
            {readingsPending
              ? messages.kdpChecklist.readings.generating
              : messages.kdpChecklist.readings.generateButton}
          </button>
          {book.readingsMissing && (
            <span className="text-button-sm text-warning">
              {messages.kdpChecklist.readings.notGenerated}
            </span>
          )}
          {readingsInfo && <span className="text-button-sm text-success">{readingsInfo}</span>}
        </div>
      )}

      <SubmissionChecklistTable book={book} onFieldUpdate={handleFieldUpdate} />

      {/* Footer: completion + status + bundle DL + submit */}
      <div className="flex flex-wrap items-center justify-between gap-space-snug border-t border-border-warm pt-space-snug">
        <div className="flex items-center gap-space-snug">
          <span className="text-button-sm text-muted">
            {m.completionRate(book.checkedCount, book.totalFieldCount)}
          </span>
          <span className="text-button-sm text-muted">{messages.books.publish.label}</span>
          <PublishStatusControl bookId={book.id} value={book.publishStatus} />
        </div>
        <div className="flex items-center gap-space-snug">
          <a
            href={`/api/books/${book.id}/bundle`}
            className="inline-flex items-center gap-1.5 rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            data-testid={`checklist-bundle-download-${book.id}`}
          >
            {messages.books.header.bundleDownload}
          </a>
          <SubmitToKdpButton disabled />
        </div>
      </div>
    </div>
  );
}
