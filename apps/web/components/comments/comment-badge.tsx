/**
 * CommentBadge — shows comment count with must-count emphasis (docs/04 §5).
 *
 * Overlays on existing elements to indicate pending comment counts.
 * Used in S-009 book rows, S-010 book detail, and the header.
 */
import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';

const m = messages.comments.badge;

interface CommentBadgeProps {
  pending: number;
  must: number;
  className?: string;
  onClick?: () => void;
}

export function CommentBadge({ pending, must, className, onClick }: CommentBadgeProps) {
  if (pending === 0) return null;

  const variant = must > 0 ? 'must' : 'neutral';

  return (
    <Badge
      variant={variant}
      className={className}
      aria-label={`${m.ariaLabel} ${pending}${m.countSuffix}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <span>{pending}</span>
      {must > 0 && (
        <span className="ml-0.5 font-medium">
          ({m.mustLabel}: {must})
        </span>
      )}
    </Badge>
  );
}
