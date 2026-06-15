/**
 * AlertBadge placeholder (docs/04 §3.2 / §5).
 * SP-07 で `alerts` テーブルから件数を購読する。
 */
import { messages } from '@/lib/messages';
import { Badge } from '@/components/ui/badge';

export function AlertBadge() {
  return (
    <Badge variant="neutral" aria-label={messages.header.alertBadgeLabel}>
      <span>{messages.header.alertBadgeLabel}</span>
      <span className="ml-1 font-medium">0</span>
    </Badge>
  );
}
