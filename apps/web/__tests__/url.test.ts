/**
 * safeCallbackUrl のユニットテスト (T-01-09 review fix)
 *
 * 受け入れ基準:
 *   - 相対パス `/dashboard` はそのまま許可
 *   - `https://evil.com` 等の外部 URL はブロックして fallback
 *   - protocol-relative `//evil.com` もブロック
 *   - クエリ中に URL を埋め込んでも path 部分が安全なら許可
 *   - 許可 origin と一致する絶対 URL は path+search+hash のみ返す
 */
import { describe, expect, it } from 'vitest';
import { safeCallbackUrl } from '../lib/url';

describe('safeCallbackUrl', () => {
  it('正常な相対パスはそのまま返す', () => {
    expect(safeCallbackUrl('/dashboard')).toBe('/dashboard');
    expect(safeCallbackUrl('/books/123')).toBe('/books/123');
    expect(safeCallbackUrl('/')).toBe('/');
  });

  it('外部 URL はブロックして fallback', () => {
    expect(safeCallbackUrl('https://evil.com')).toBe('/');
    expect(safeCallbackUrl('http://evil.com/path')).toBe('/');
  });

  it('protocol-relative URL はブロック', () => {
    expect(safeCallbackUrl('//evil.com')).toBe('/');
    expect(safeCallbackUrl('//evil.com/dashboard')).toBe('/');
  });

  it('backslash protocol-relative もブロック', () => {
    // 一部ブラウザで `/\evil.com` は protocol-relative 扱いになるためブロック
    expect(safeCallbackUrl('/\\evil.com')).toBe('/');
  });

  it('クエリ中の URL は path が安全なら許可（リダイレクト先で再度サニタイズすべき領分）', () => {
    expect(safeCallbackUrl('/redirect?next=https://evil.com')).toBe(
      '/redirect?next=https://evil.com',
    );
  });

  it('空文字 / 非文字列は fallback', () => {
    expect(safeCallbackUrl('')).toBe('/');
    expect(safeCallbackUrl(null)).toBe('/');
    expect(safeCallbackUrl(undefined)).toBe('/');
    expect(safeCallbackUrl(123)).toBe('/');
    expect(safeCallbackUrl({})).toBe('/');
  });

  it('JS スキームはブロック', () => {
    expect(safeCallbackUrl('javascript:alert(1)')).toBe('/');
    expect(safeCallbackUrl('data:text/html,<script>')).toBe('/');
  });

  it('許可 origin と一致する絶対 URL は path+search+hash を返す', () => {
    expect(
      safeCallbackUrl('https://a2p.example.com/dashboard?tab=draft#top', {
        allowedOrigin: 'https://a2p.example.com',
      }),
    ).toBe('/dashboard?tab=draft#top');
  });

  it('許可 origin と一致しない絶対 URL はブロック', () => {
    expect(
      safeCallbackUrl('https://evil.com/dashboard', {
        allowedOrigin: 'https://a2p.example.com',
      }),
    ).toBe('/');
  });

  it('fallback を上書き可能', () => {
    expect(safeCallbackUrl('https://evil.com', { fallback: '/login' })).toBe('/login');
  });
});
