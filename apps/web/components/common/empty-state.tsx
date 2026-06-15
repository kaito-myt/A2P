/**
 * EmptyState — 全画面共通の空状態テンプレ (docs/04 §5)。
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface EmptyStateProps {
  title?: string;
  message: string;
  action?: ReactNode;
  className?: string;
  /** 小さいセクション内で使う場合 padding を縮める */
  compact?: boolean;
}

export function EmptyState({ title, message, action, className, compact = false }: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-space-snug text-center text-muted',
        compact ? 'py-space-loose' : 'py-space-section-sm',
        className,
      )}
    >
      {title && <div className="text-card-title text-charcoal-83">{title}</div>}
      <p className="max-w-md text-body">{message}</p>
      {action}
    </div>
  );
}
