import { describe, it, expect } from 'vitest';

import { kanaToRomaji } from '../src/lib/kana-to-romaji.js';

describe('kanaToRomaji', () => {
  it('converts basic katakana', () => {
    expect(kanaToRomaji('カイト')).toBe('kaito');
    expect(kanaToRomaji('ミヤタ')).toBe('miyata');
  });

  it('handles digraphs (拗音)', () => {
    expect(kanaToRomaji('トウキョウ')).toBe('toukyou');
    expect(kanaToRomaji('シャシン')).toBe('shashin');
    expect(kanaToRomaji('ジュク')).toBe('juku');
  });

  it('handles sokuon (促音 ッ)', () => {
    expect(kanaToRomaji('ガッコウ')).toBe('gakkou');
    expect(kanaToRomaji('イッショ')).toBe('issho');
    expect(kanaToRomaji('マッチャ')).toBe('matcha');
  });

  it('handles long vowel mark ー', () => {
    expect(kanaToRomaji('ラーメン')).toBe('raamen');
    expect(kanaToRomaji('コーヒー')).toBe('koohii');
  });

  it('converts hiragana too', () => {
    expect(kanaToRomaji('かいと')).toBe('kaito');
  });

  it('passes through non-kana and empty', () => {
    expect(kanaToRomaji('')).toBe('');
    expect(kanaToRomaji('AI')).toBe('AI');
  });
});
