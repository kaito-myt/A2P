/**
 * A2P design tokens — implementation of `docs/04 §6.3` (the design-token source of truth).
 *
 * These tokens are the single source of truth for:
 *   - `apps/web/tailwind.config.ts`     (via `theme.extend`)
 *   - `apps/web/app/globals.css`        (via CSS variables in `:root`)
 *   - React components in `packages/ui/components/`
 *
 * Adding new colors / radii / shadows here is the only sanctioned way to expand
 * the palette. Hard-coded hex values elsewhere violate `docs/04 §6.5 Do/Don't`.
 */

export const colors = {
  // Base
  cream: '#f7f4ed',
  'cream-light': '#fcfbf8',
  charcoal: '#1c1c1c',
  'border-warm': '#eceae4',
  muted: '#5f5f5d',

  // Charcoal opacity scale — all grays derive from charcoal at varying alpha
  'charcoal-100': '#1c1c1c',
  'charcoal-83': 'rgba(28, 28, 28, 0.83)',
  'charcoal-82': 'rgba(28, 28, 28, 0.82)',
  'charcoal-40': 'rgba(28, 28, 28, 0.40)',
  'charcoal-04': 'rgba(28, 28, 28, 0.04)',
  'charcoal-03': 'rgba(28, 28, 28, 0.03)',

  // Semantic colors (low-saturation, warm-neutral compatible)
  destructive: '#b91c1c', // red-700
  'destructive-bg': '#fee2e2', // red-100
  warning: '#b45309', // amber-700
  'warning-bg': '#fef3c7', // amber-100
  success: '#15803d', // green-700
  'success-bg': '#dcfce7', // green-100
  accent: '#1d4ed8', // blue-700
  'accent-bg': '#dbeafe', // blue-100

  // Focus ring
  'ring-blue': 'rgba(59, 130, 246, 0.50)',
} as const;

export const spacing = {
  'space-tight': '8px',
  'space-snug': '12px',
  'space-relaxed': '16px',
  'space-loose': '24px',
  'space-section-sm': '40px',
  'space-section': '80px',
  'space-hero': '128px',
  'space-display': '208px',
} as const;

export const borderRadius = {
  micro: '4px',
  default: '6px',
  snug: '8px',
  card: '12px',
  container: '16px',
  pill: '9999px',
} as const;

export const boxShadow = {
  // L2 Inset — dark primary button signature
  'l2-inset':
    'inset 0 0.5px 0 0 rgba(255,255,255,0.20), inset 0 0 0 0.5px rgba(0,0,0,0.20), 0 1px 2px 0 rgba(0,0,0,0.05)',
  // L3 Focus — soft warm shadow for active/focus
  'l3-focus': '0 4px 12px rgba(0,0,0,0.10)',
  // Keyboard focus ring (for inputs)
  ring: '0 0 0 2px rgba(59,130,246,0.50)',
} as const;

export const fontFamily: Record<'sans' | 'jp', string[]> = {
  sans: ['var(--font-inter)', 'var(--font-noto-jp)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
  jp: ['var(--font-noto-jp)', 'var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
};

/**
 * Typography roles. Each entry returns Tailwind's `fontSize` tuple format:
 *   [size, { lineHeight, letterSpacing, fontWeight }]
 *
 * docs/04 §6.3.2 specifies role-based scale (display-hero ... button-sm).
 * Weights are 400 / 480 / 600 only — no 700 (Do/Don't).
 */
type FontSizeTuple = [string, { lineHeight: string; letterSpacing: string; fontWeight: string }];

export const fontSize: Record<string, FontSizeTuple> = {
  'display-hero': ['3.75rem', { lineHeight: '1.05', letterSpacing: '-1.5px', fontWeight: '600' }],
  'display-alt': ['3.75rem', { lineHeight: '1.00', letterSpacing: '0', fontWeight: '480' }],
  'section-heading': ['3rem', { lineHeight: '1.00', letterSpacing: '-1.2px', fontWeight: '600' }],
  'sub-heading': ['2.25rem', { lineHeight: '1.10', letterSpacing: '-0.9px', fontWeight: '600' }],
  'card-title': ['1.25rem', { lineHeight: '1.25', letterSpacing: '0', fontWeight: '400' }],
  'body-large': ['1.125rem', { lineHeight: '1.38', letterSpacing: '0', fontWeight: '400' }],
  body: ['1rem', { lineHeight: '1.50', letterSpacing: '0', fontWeight: '400' }],
  button: ['1rem', { lineHeight: '1.50', letterSpacing: '0', fontWeight: '400' }],
  'button-sm': ['0.875rem', { lineHeight: '1.50', letterSpacing: '0', fontWeight: '400' }],
  caption: ['0.875rem', { lineHeight: '1.50', letterSpacing: '0', fontWeight: '400' }],
};

export const letterSpacing = {
  tighter: '-1.5px',
  tight: '-0.9px',
  normal: '0',
  // Japanese headings: per §6.3.2, Tailwind's tracking-tight equivalent
  'jp-tight': '-0.025em',
} as const;

/**
 * Aggregated default export — Tailwind config consumes this directly.
 * Keeping a single object makes `tailwind.config.ts` a 1-line import.
 */
export const tokens = {
  colors,
  spacing,
  borderRadius,
  boxShadow,
  fontFamily,
  fontSize,
  letterSpacing,
} as const;

export type Tokens = typeof tokens;
