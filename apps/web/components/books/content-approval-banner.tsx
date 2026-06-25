'use client';

/**
 * ContentApprovalBanner — 書籍詳細で本文承認ゲートを操作する。
 * status='content_review' の書籍にのみ表示し、承認すると thumbnail.text を起動して
 * サムネ生成へ進む (approveBookContent SA)。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { approveBookContent } from '@/app/actions/books';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';

const m = messages.books.contentApproval;

export function ContentApprovalBanner({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function approve() {
    setError(null);
    startTransition(async () => {
      const res = await approveBookContent({ book_id: bookId });
      if (!res.ok) {
        setError(res.error?.message ?? m.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
      data-testid="content-approval-banner"
    >
      <p className="text-body text-charcoal">{m.banner}</p>
      <div className="flex items-center gap-space-snug">
        <Button
          type="button"
          variant="default"
          onClick={approve}
          disabled={pending}
          data-testid="content-approve-button"
        >
          {pending ? m.submitting : m.button}
        </Button>
        {error && (
          <span className="text-button-sm text-destructive" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
