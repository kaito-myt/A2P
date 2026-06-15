'use client';

/**
 * ChecklistPageShell — S-015 KDP 入稿チェックリスト クライアントシェル (T-08-03).
 *
 * 書籍タブ選択状態を管理し、選択中の書籍の詳細を表示する。
 */
import { useState, useCallback } from 'react';

import { messages } from '@/lib/messages';
import type { ChecklistPageData, ChecklistBookView } from '@/lib/kdp-checklist-view';
import { computeOverallCompletion } from '@/lib/kdp-checklist-view';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';

import { BookInfoHeader } from './book-info-header';
import { BlockReasonBanner } from './block-reason-banner';
import { SubmissionChecklistTable } from './submission-checklist-table';
import { ChecklistActionBar } from './checklist-action-bar';
import { SubmitToKdpButton } from './submit-to-kdp-button';

interface ChecklistPageShellProps {
  data: ChecklistPageData;
}

const m = messages.kdpChecklist;

export function ChecklistPageShell({ data }: ChecklistPageShellProps) {
  const { books } = data;
  const [activeBookId, setActiveBookId] = useState<string>(books[0]?.id ?? '');
  const [localBooks, setLocalBooks] = useState<ChecklistBookView[]>(books);

  const activeBook = localBooks.find((b) => b.id === activeBookId) ?? localBooks[0];
  const overall = computeOverallCompletion(localBooks);

  const handleFieldUpdate = useCallback(
    (bookId: string, field: string, patch: { copied?: boolean; checked?: boolean }) => {
      setLocalBooks((prev) =>
        prev.map((book) => {
          if (book.id !== bookId) return book;
          const updatedFields = book.fields.map((f) => {
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
          return { ...book, fields: updatedFields, checkedCount };
        }),
      );
    },
    [],
  );

  const handleNextBook = useCallback(() => {
    const currentIndex = localBooks.findIndex((b) => b.id === activeBookId);
    const next = localBooks[currentIndex + 1];
    if (next) setActiveBookId(next.id);
  }, [activeBookId, localBooks]);

  if (!activeBook) return null;

  return (
    <div className="flex flex-col gap-space-loose pb-24" data-testid="checklist-page-shell">
      {/* Book tabs */}
      <Tabs value={activeBookId} onValueChange={setActiveBookId}>
        <div className="overflow-x-auto">
          <TabsList className="flex-nowrap" aria-label="書籍タブ">
            {localBooks.map((book) => (
              <TabsTrigger
                key={book.id}
                value={book.id}
                data-testid={`book-tab-${book.id}`}
                className="max-w-[200px] shrink-0"
              >
                <span className="truncate">{book.title}</span>
                {book.hasBlockingComments ? (
                  <Badge variant="must" className="ml-1.5 shrink-0">
                    {m.tabBlockedBadge(book.mustCommentCount)}
                  </Badge>
                ) : (
                  <Badge variant="success" className="ml-1.5 shrink-0">
                    {m.tabReadyBadge}
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {localBooks.map((book) => (
          <TabsContent key={book.id} value={book.id}>
            <div className="flex flex-col gap-space-loose">
              {/* Book info header */}
              <BookInfoHeader book={book} />

              {/* Block reason banner */}
              {book.hasBlockingComments && (
                <BlockReasonBanner
                  mustCommentCount={book.mustCommentCount}
                  mustComments={book.mustComments}
                />
              )}

              {/* Checklist table (shows metadata missing state internally) */}
              <SubmissionChecklistTable
                book={book}
                onFieldUpdate={handleFieldUpdate}
              />

              {/* Per-book submit button */}
              <div className="flex justify-end">
                <SubmitToKdpButton disabled />
              </div>
            </div>
          </TabsContent>
        ))}
      </Tabs>

      {/* Action bar (fixed bottom) */}
      <ChecklistActionBar
        overall={overall}
        totalBooks={localBooks.length}
        activeBook={activeBook}
        lastSavedAt={activeBook.lastSavedAt}
        onNextBook={handleNextBook}
        hasNextBook={localBooks.findIndex((b) => b.id === activeBookId) < localBooks.length - 1}
      />
    </div>
  );
}
