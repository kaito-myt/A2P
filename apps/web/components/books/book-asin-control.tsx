'use client';

/**
 * BookAsinControl — 書籍詳細で Amazon の ASIN を記録/編集する。
 * ASIN を保存すると、販促プランがある本は投稿が作り直され購入リンクが反映される
 * (updateBookPublishStatus 側で promotion.posts.generate を再起動)。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { updateBookPublishStatus } from '@/app/actions/books';
import { messages } from '@/lib/messages';
import type { PublishStatus } from '@/lib/books-view';

const m = messages.books.publish;

export function BookAsinControl({
  bookId,
  publishStatus,
  value,
}: {
  bookId: string;
  publishStatus: PublishStatus;
  value: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [asin, setAsin] = useState(value ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    const trimmed = asin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(trimmed)) {
      setError(m.asinInvalid);
      return;
    }
    setError(null);
    start(async () => {
      const res = await updateBookPublishStatus({
        book_id: bookId,
        publish_status: publishStatus,
        asin: trimmed,
      });
      if (!res.ok) {
        setError(res.error?.message ?? m.updateError);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1">
        {m.asinLabel}: {value ?? m.asinPlaceholder}
        <button
          type="button"
          onClick={() => setEditing(true)}
          data-testid={`book-asin-edit-${bookId}`}
          className="text-accent underline underline-offset-2 hover:no-underline"
        >
          {value ? m.asinEdit : m.asinSet}
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      {m.asinLabel}:
      <input
        value={asin}
        onChange={(e) => setAsin(e.target.value)}
        placeholder="B0XXXXXXXX"
        maxLength={10}
        autoComplete="off"
        data-testid={`book-asin-input-${bookId}`}
        className="w-28 rounded-default border border-border-warm bg-cream-light px-2 py-0.5 text-button-sm uppercase"
      />
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="rounded-card bg-charcoal px-2 py-0.5 text-button-sm text-cream-light hover:opacity-80 disabled:opacity-50"
      >
        {pending ? m.asinSaving : m.asinSave}
      </button>
      <button
        type="button"
        onClick={() => { setEditing(false); setAsin(value ?? ''); setError(null); }}
        className="text-muted underline underline-offset-2 hover:no-underline"
      >
        {m.asinCancel}
      </button>
      {error && <span className="text-caption text-destructive">{error}</span>}
    </span>
  );
}
