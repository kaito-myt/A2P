'use client';

/**
 * PublishStatusControl — 書籍ライブラリ/詳細で Amazon KDP 出版ステータスを
 * 運営者が手動切替する。unlisted=未対応 / published=出版済み。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { updateBookPublishStatus } from '@/app/actions/books';
import { messages } from '@/lib/messages';
import type { PublishStatus } from '@/lib/books-view';

const m = messages.books.publish;

export function PublishStatusControl({
  bookId,
  value,
}: {
  bookId: string;
  value: PublishStatus;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<PublishStatus>(value);
  const [pending, startTransition] = useTransition();

  function onChange(next: PublishStatus) {
    if (next === current) return;
    const prev = current;
    setCurrent(next); // 楽観更新
    startTransition(async () => {
      const res = await updateBookPublishStatus({ book_id: bookId, publish_status: next });
      if (!res.ok) {
        setCurrent(prev); // 失敗時はロールバック
        return;
      }
      router.refresh();
    });
  }

  return (
    <select
      value={current}
      disabled={pending}
      onChange={(e) => onChange(e.target.value as PublishStatus)}
      aria-label={m.label}
      data-testid={`publish-status-${bookId}`}
      className={`rounded-pill border px-2 py-0.5 text-button-sm ${
        current === 'published'
          ? 'border-success bg-success-bg/40 text-success'
          : current === 'submitted'
            ? 'border-accent bg-accent-bg/40 text-accent'
            : 'border-border-warm bg-cream text-charcoal-82'
      }`}
    >
      <option value="unlisted">{m.unlisted}</option>
      <option value="submitted">{m.submitted}</option>
      <option value="published">{m.published}</option>
    </select>
  );
}
