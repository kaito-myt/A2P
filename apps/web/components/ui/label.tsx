/**
 * Label — minimal form label (docs/04 §6.4.3).
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>;

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('text-button-sm font-normal text-charcoal-83', className)}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

export { Label };
