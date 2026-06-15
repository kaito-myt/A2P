/**
 * Button — shadcn/ui style API, A2P warm-parchment theme (docs/04 §6.4.1).
 *
 * Variants:
 *   - default  Primary Dark + L2 Inset shadow (主要 CTA)
 *   - outline  Ghost / Outline (2 次アクション)
 *   - secondary Cream Surface (3 次アクション)
 *   - ghost    透明背景 (ナビ/inline)
 *   - destructive 削除・却下系
 *   - link     リンク様式
 *
 * NOTE: `pill` variant is reserved for icon/toggle buttons per §6.5 (don't
 * apply `radius-pill` to rectangular buttons). Use `<IconButton>` separately
 * when required (added in a later sprint).
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-default text-button font-normal transition-opacity focus-visible:outline-none focus-visible:shadow-l3-focus focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-charcoal text-cream-light shadow-l2-inset hover:opacity-80 active:opacity-80',
        outline:
          'border border-charcoal-40 bg-transparent text-charcoal hover:opacity-80 active:opacity-80',
        secondary:
          'bg-cream text-charcoal hover:opacity-80 active:opacity-80',
        ghost:
          'bg-transparent text-charcoal hover:bg-charcoal-04',
        destructive:
          'bg-destructive text-cream-light shadow-l2-inset hover:opacity-80 active:opacity-80',
        link:
          'bg-transparent text-charcoal underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 px-3 text-button-sm',
        lg: 'h-11 px-6',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
