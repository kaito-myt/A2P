/**
 * Locks the §6.3 design-token contract.
 *
 * 値が docs/04 §6.3 と一致していることをスポットチェックし、誤ったリファクタや
 * 単発の hex 差し替えで warm-parchment テーマが崩れるのを早期検出する。
 */
import { describe, it, expect } from 'vitest';
import { tokens, colors, borderRadius, boxShadow, fontSize, spacing } from '../src/tokens.js';

describe('A2P design tokens (docs/04 §6.3)', () => {
  it('exposes the cool-neutral SaaS base palette', () => {
    expect(colors.cream).toBe('#f6f7f9');
    expect(colors['cream-light']).toBe('#ffffff');
    expect(colors.charcoal).toBe('#101828');
    expect(colors['border-warm']).toBe('#e6e8ec');
    expect(colors.muted).toBe('#667085');
  });

  it('derives gray scale from ink opacity (no extra hex codes)', () => {
    expect(colors['charcoal-82']).toBe('rgba(16, 24, 40, 0.72)');
    expect(colors['charcoal-40']).toBe('rgba(16, 24, 40, 0.40)');
    expect(colors['charcoal-04']).toBe('rgba(16, 24, 40, 0.04)');
  });

  it('uses crisp SaaS semantic colors with an indigo accent', () => {
    expect(colors.destructive).toBe('#d92d20');
    expect(colors.warning).toBe('#b54708');
    expect(colors.success).toBe('#067647');
    expect(colors.accent).toBe('#4f46e5');
  });

  it('exposes radius-card for L1 Bordered containers', () => {
    expect(borderRadius.card).toBe('10px');
    expect(borderRadius.default).toBe('6px');
    expect(borderRadius.pill).toBe('9999px');
  });

  it('exposes L2 Inset shadow for primary dark buttons', () => {
    expect(boxShadow['l2-inset']).toContain('inset');
    expect(boxShadow['l2-inset']).toContain('rgba(255,255,255,0.08)');
    expect(boxShadow['l3-focus']).toContain('rgba(16,24,40');
  });

  it('keeps 8-step semantic spacing scale', () => {
    expect(spacing['space-tight']).toBe('8px');
    expect(spacing['space-loose']).toBe('24px');
    expect(spacing['space-display']).toBe('208px');
  });

  it('limits font weights to 400/480/600 (no bold)', () => {
    const weights = new Set(Object.values(fontSize).map(([, meta]) => meta.fontWeight));
    expect(weights).toEqual(new Set(['400', '480', '600']));
  });

  it('aggregates all token groups under default `tokens` export', () => {
    expect(tokens.colors).toBe(colors);
    expect(tokens.spacing).toBe(spacing);
    expect(tokens.borderRadius).toBe(borderRadius);
    expect(tokens.boxShadow).toBe(boxShadow);
  });
});
