/**
 * Badge — pill-shaped status indicator (docs/04 §6.4 / §6.3.6).
 *
 * Variants reflect comment priority + generic state badges:
 *   - must     (destructive)
 *   - should   (warning)
 *   - may      (accent)
 *   - success
 *   - neutral
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-button-sm font-normal',
  {
    variants: {
      variant: {
        must: 'bg-destructive-bg text-destructive',
        should: 'bg-warning-bg text-warning',
        may: 'bg-accent-bg text-accent',
        success: 'bg-success-bg text-success',
        neutral: 'bg-charcoal-04 text-charcoal-82',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { badgeVariants };
