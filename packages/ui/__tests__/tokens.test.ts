/**
 * Locks the §6.3 design-token contract.
 *
 * 値が docs/04 §6.3 と一致していることをスポットチェックし、誤ったリファクタや
 * 単発の hex 差し替えで warm-parchment テーマが崩れるのを早期検出する。
 */
import { describe, it, expect } from 'vitest';
import { tokens, colors, borderRadius, boxShadow, fontSize, spacing } from '../src/tokens.js';

describe('A2P design tokens (docs/04 §6.3)', () => {
  it('exposes the cream/charcoal/border-warm base palette', () => {
    expect(colors.cream).toBe('#f7f4ed');
    expect(colors['cream-light']).toBe('#fcfbf8');
    expect(colors.charcoal).toBe('#1c1c1c');
    expect(colors['border-warm']).toBe('#eceae4');
    expect(colors.muted).toBe('#5f5f5d');
  });

  it('derives gray scale from charcoal opacity (no extra hex codes)', () => {
    expect(colors['charcoal-82']).toBe('rgba(28, 28, 28, 0.82)');
    expect(colors['charcoal-40']).toBe('rgba(28, 28, 28, 0.40)');
    expect(colors['charcoal-04']).toBe('rgba(28, 28, 28, 0.04)');
  });

  it('uses the 700-series semantic colors specified in §6.3.1', () => {
    expect(colors.destructive).toBe('#b91c1c');
    expect(colors.warning).toBe('#b45309');
    expect(colors.success).toBe('#15803d');
    expect(colors.accent).toBe('#1d4ed8');
  });

  it('exposes radius-card 12px for L1 Bordered containers', () => {
    expect(borderRadius.card).toBe('12px');
    expect(borderRadius.default).toBe('6px');
    expect(borderRadius.pill).toBe('9999px');
  });

  it('exposes L2 Inset shadow for primary dark buttons', () => {
    expect(boxShadow['l2-inset']).toContain('inset');
    expect(boxShadow['l2-inset']).toContain('rgba(255,255,255,0.20)');
    expect(boxShadow['l3-focus']).toBe('0 4px 12px rgba(0,0,0,0.10)');
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
