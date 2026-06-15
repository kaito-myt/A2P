'use client';

/**
 * テーマ候補ステータスバッジ (S-006 wireframes prompt: pending=灰 / accepted=緑 / rejected=赤).
 */
import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import type { ThemeStatus } from '@/lib/themes-view';

const m = messages.themes.status;

interface ThemeStatusBadgeProps {
  status: ThemeStatus;
  rowId: string;
}

export function ThemeStatusBadge({ status, rowId }: ThemeStatusBadgeProps) {
  const variant = status === 'accepted' ? 'success' : status === 'rejected' ? 'must' : 'neutral';
  const label = m[status];
  return (
    <Badge variant={variant} data-testid={`theme-status-${rowId}`}>
      {label}
    </Badge>
  );
}
