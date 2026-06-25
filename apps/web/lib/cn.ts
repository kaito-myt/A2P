/**
 * `cn()` — shadcn-standard className composer.
 * `clsx` resolves conditionals; `twMerge` resolves Tailwind conflicts.
 *
 * twMerge のデフォルト設定は Tailwind 既定スケール (text-sm / text-red-500 等) しか
 * 知らないため、A2P のカスタムトークン (`text-button` / `text-button-sm` = font-size,
 * `text-cream-light` / `text-charcoal` = text-color) を正しく分類できず、
 * `text-cream-light`(色) と `text-button-sm`(サイズ) を同一グループと誤認して
 * 片方を破棄していた（例: size="sm" variant="default" のボタンで文字色が消え、
 * 暗背景＋継承された暗文字で不可視になる回帰）。
 *
 * カスタムの font-size / text-color クラスグループを twMerge に登録し、
 * 両者を別グループとして扱わせることで、色とサイズが共存できるようにする。
 */
import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { tokens } from '@a2p/ui/tokens';

// docs/04 §6.3 のロールベース文字サイズ（text-<role>）。
const fontSizeRoles = Object.keys(tokens.fontSize);
// A2P パレットの全色（text-<color> として色グループに登録する）。
const colorNames = Object.keys(tokens.colors);

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // text-button / text-button-sm 等はフォントサイズ。互いに競合し最後勝ち。
      'font-size': [{ text: fontSizeRoles }],
      // text-cream-light / text-charcoal 等は文字色。font-size とは別グループ。
      'text-color': [{ text: colorNames }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
