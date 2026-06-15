/**
 * Next.js self-hosted Google Fonts per `docs/03 §K` UI-02 / UI-03.
 *
 * - Inter: English / latin / numerics — weights 400/500/600
 * - Noto Sans JP: 日本語 — weights 400/500/600
 *
 * Both are variable fonts; `display: 'swap'` avoids FOIT for long bodies of
 * Japanese text where Noto Sans JP can take ~600 KB to download.
 *
 * The exported objects expose `.variable` (CSS variable class name) which
 * `apps/web/app/layout.tsx` applies to `<html>`.
 */
import { Inter, Noto_Sans_JP } from 'next/font/google';

export const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-inter',
  display: 'swap',
});

export const notoJp = Noto_Sans_JP({
  // Noto Sans JP requires the 'latin' subset declaration; CJK glyphs are auto-bundled.
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-noto-jp',
  display: 'swap',
});
