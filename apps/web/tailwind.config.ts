/**
 * Tailwind v3 config — extends `packages/ui/tokens.ts` (docs/04 §6.3, docs/03 §K UI-01).
 *
 * - `colors`, `spacing`, `borderRadius`, `boxShadow`, `fontFamily`, `fontSize`,
 *   `letterSpacing` are merged via `theme.extend` so Tailwind defaults remain
 *   intact (we add semantic A2P tokens on top, never overriding numeric ones).
 * - `content` globs cover `apps/web` + `packages/ui` so component class names
 *   in the shared package are scanned during PurgeCSS.
 */
import type { Config } from 'tailwindcss';
import typography from '@tailwindcss/typography';
import { tokens } from '@a2p/ui/tokens';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        ...tokens.colors,
        // shadcn semantic aliases mapped to A2P tokens
        background: tokens.colors.cream,
        foreground: tokens.colors.charcoal,
        border: tokens.colors['border-warm'],
        input: tokens.colors['border-warm'],
        ring: tokens.colors['ring-blue'],
        primary: {
          DEFAULT: tokens.colors.charcoal,
          foreground: tokens.colors['cream-light'],
        },
        secondary: {
          DEFAULT: tokens.colors.cream,
          foreground: tokens.colors.charcoal,
        },
        // shadcn `destructive` namespace uses `.destructive` and `.destructive-foreground`
        'destructive-foreground': tokens.colors['cream-light'],
      },
      spacing: tokens.spacing,
      borderRadius: tokens.borderRadius,
      boxShadow: tokens.boxShadow,
      fontFamily: tokens.fontFamily,
      fontSize: tokens.fontSize,
      letterSpacing: tokens.letterSpacing,
    },
  },
  plugins: [typography],
};

export default config;
