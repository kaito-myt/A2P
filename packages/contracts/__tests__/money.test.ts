import { describe, expect, it } from 'vitest';
import {
  addJpy,
  decimalToJpy,
  formatJpy,
  jpyToDecimalString,
  sumJpy,
  toJpy,
} from '../src/money.js';

describe('toJpy()', () => {
  it('整数 number / 整数 string を受理する', () => {
    expect(toJpy(0)).toBe(0);
    expect(toJpy(1234567)).toBe(1234567);
    expect(toJpy(-100)).toBe(-100);
    expect(toJpy('  42 ')).toBe(42);
    expect(toJpy('-1000')).toBe(-1000);
  });

  it('小数入力で throw する', () => {
    expect(() => toJpy(1.5)).toThrow(RangeError);
    expect(() => toJpy(0.1)).toThrow(RangeError);
    expect(() => toJpy('100.0')).toThrow(RangeError);
    expect(() => toJpy('100.5')).toThrow(RangeError);
  });

  it('NaN / Infinity / 非数字文字列で throw する', () => {
    expect(() => toJpy(Number.NaN)).toThrow(RangeError);
    expect(() => toJpy(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toJpy('abc')).toThrow(RangeError);
    expect(() => toJpy('')).toThrow(RangeError);
    expect(() => toJpy('1e3')).toThrow(RangeError);
  });

  it('安全な整数範囲を超えると throw する', () => {
    expect(() => toJpy(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => toJpy('99999999999999999999')).toThrow(RangeError);
  });
});

describe('addJpy() / sumJpy()', () => {
  it('加算の結合性 (a+b)+c === a+(b+c) を満たす', () => {
    const a = 1234;
    const b = 5678;
    const c = 9012;
    const left = addJpy(addJpy(a, b), c);
    const right = addJpy(a, addJpy(b, c));
    expect(left).toBe(right);
    expect(left).toBe(a + b + c);
  });

  it('sumJpy は空配列で 0 を返す', () => {
    expect(sumJpy([])).toBe(0);
  });

  it('sumJpy は混在型の配列を集計する', () => {
    expect(sumJpy([100, '200', 300, '400'])).toBe(1000);
  });

  it('sumJpy は不正値を含むと throw する', () => {
    expect(() => sumJpy([100, '1.5'])).toThrow(RangeError);
  });
});

describe('formatJpy()', () => {
  it('1234567 を ¥1,234,567 にフォーマットする', () => {
    expect(formatJpy(1234567)).toBe('¥1,234,567');
  });

  it('0 と小桁数を正しく扱う', () => {
    expect(formatJpy(0)).toBe('¥0');
    expect(formatJpy(7)).toBe('¥7');
    expect(formatJpy(999)).toBe('¥999');
    expect(formatJpy(1000)).toBe('¥1,000');
  });

  it('負値は -¥ 接頭辞', () => {
    expect(formatJpy(-1234567)).toBe('-¥1,234,567');
  });

  it('string 入力も受理する', () => {
    expect(formatJpy('1000000')).toBe('¥1,000,000');
  });
});

describe('decimalToJpy() — Prisma.Decimal 形状からの変換', () => {
  it('toString() が整数文字列の Decimal をそのまま整数化する', () => {
    const d = { toString: () => '1500' };
    expect(decimalToJpy(d)).toBe(1500);
  });

  it('小数部は切り捨てる (Decimal(10,2) → 整数 JPY)', () => {
    expect(decimalToJpy({ toString: () => '1234.56' })).toBe(1234);
    expect(decimalToJpy({ toString: () => '0.99' })).toBe(0);
    expect(decimalToJpy({ toString: () => '-7.5' })).toBe(-7);
  });

  it('不正な toString() で throw する', () => {
    expect(() => decimalToJpy({ toString: () => 'NaN' })).toThrow(RangeError);
    expect(() => decimalToJpy({ toString: () => '' })).toThrow(RangeError);
    expect(() => decimalToJpy({ toString: () => 'abc' })).toThrow(RangeError);
    expect(() => decimalToJpy({ toString: () => '1e10' })).toThrow(RangeError);
  });
});

describe('jpyToDecimalString()', () => {
  it('整数 JPY を Prisma Decimal 受け入れ可能な文字列に変換する', () => {
    expect(jpyToDecimalString(0)).toBe('0');
    expect(jpyToDecimalString(1234567)).toBe('1234567');
    expect(jpyToDecimalString(-42)).toBe('-42');
    expect(jpyToDecimalString('500')).toBe('500');
  });

  it('小数入力は throw する', () => {
    expect(() => jpyToDecimalString(1.5)).toThrow(RangeError);
  });
});
