'use client';

/**
 * CommentBadgeHeader -- header variant of CommentBadge with 30s polling (T-06-12).
 *
 * Fetches /api/comments/counts every 30s and displays pending + must counts.
 * Clicking navigates to /comments (S-013).
 *
 * Unlike the inline CommentBadge (which hides at 0), the header variant always
 * renders so the operator always has visibility into comment status.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { messages } from '@/lib/messages';
import { Badge } from '@/components/ui/badge';

const POLL_INTERVAL_MS = 30_000;

const m = messages.header;

interface CommentCounts {
  pending: number;
  must: number;
}

export function CommentBadgeHeader() {
  const router = useRouter();
  const [counts, setCounts] = useState<CommentCounts>({ pending: 0, must: 0 });

  const fetchCounts = useCallback(async () => {
    try {
      const res = await fetch('/api/comments/counts');
      if (!res.ok) return;
      const data: CommentCounts = await res.json();
      setCounts(data);
    } catch {
      // silently ignore network errors during polling
    }
  }, []);

  useEffect(() => {
    fetchCounts();
    const id = setInterval(fetchCounts, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchCounts]);

  const handleClick = useCallback(() => {
    router.push('/comments');
  }, [router]);

  const variant = counts.must > 0 ? 'must' : 'neutral';

  return (
    <Badge
      variant={variant}
      aria-label={m.commentBadgeLabel}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      style={{ cursor: 'pointer' }}
    >
      <span>{m.commentBadgeLabel}</span>
      <span className="ml-1 font-medium">{counts.pending}</span>
      <span className="ml-1 text-charcoal-40">
        ({m.commentMustLabel}: {counts.must})
      </span>
    </Badge>
  );
}
