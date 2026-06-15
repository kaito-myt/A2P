'use client';

/**
 * Book status badge for S-009 / S-010 (T-05-11).
 */
import { Badge } from '@/components/ui/badge';
import { formatBookStatus, type BookStatus } from '@/lib/books-view';

interface BookStatusBadgeProps {
  status: BookStatus;
}

function statusVariant(status: BookStatus): 'success' | 'must' | 'neutral' {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
    case 'cancelled':
    case 'paused_cost':
    case 'needs_human_review':
      return 'must';
    default:
      return 'neutral';
  }
}

export function BookStatusBadge({ status }: BookStatusBadgeProps) {
  return (
    <Badge variant={statusVariant(status)} data-testid={`book-status-badge-${status}`}>
      {formatBookStatus(status)}
    </Badge>
  );
}
