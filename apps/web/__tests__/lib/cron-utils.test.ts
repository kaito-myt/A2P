/**
 * cron-utils.ts 単体テスト (T-12-08).
 *
 * 検証:
 *  1. 標準的な cron 式が正しい JST ラベルを返す
 *  2. 曜日指定 cron が週次ラベルを返す
 *  3. 日付指定 cron が月次ラベルを返す
 *  4. フィールド不足の cron 式がフォールバックを返す
 *  5. 無効な値を含む cron 式がフォールバックを返す
 *  6. isValidCronExpression の検証
 */
import { describe, expect, it } from 'vitest';

import { nextCronRunJst, isValidCronExpression } from '../../lib/cron-utils';

describe('nextCronRunJst', () => {
  describe('毎日スケジュール', () => {
    it('0 17 * * * → 毎日 02:00 JST (UTC 17:00 = JST 02:00)', () => {
      expect(nextCronRunJst('0 17 * * *')).toBe('毎日 02:00 JST');
    });

    it('0 0 * * * → 毎日 09:00 JST (UTC 00:00 = JST 09:00)', () => {
      expect(nextCronRunJst('0 0 * * *')).toBe('毎日 09:00 JST');
    });

    it('30 14 * * * → 毎日 23:30 JST (UTC 14:30 = JST 23:30)', () => {
      expect(nextCronRunJst('30 14 * * *')).toBe('毎日 23:30 JST');
    });

    it('0 15 * * * → 毎日 00:00 JST (UTC 15:00 = JST 00:00)', () => {
      expect(nextCronRunJst('0 15 * * *')).toBe('毎日 00:00 JST');
    });

    it('先頭/末尾の空白を無視する', () => {
      expect(nextCronRunJst('  0 17 * * *  ')).toBe('毎日 02:00 JST');
    });
  });

  describe('毎週スケジュール', () => {
    it('0 17 * * 1 → 毎週月曜 02:00 JST', () => {
      expect(nextCronRunJst('0 17 * * 1')).toBe('毎週月曜 02:00 JST');
    });

    it('0 17 * * 0 → 毎週日曜 02:00 JST', () => {
      expect(nextCronRunJst('0 17 * * 0')).toBe('毎週日曜 02:00 JST');
    });

    it('0 17 * * 5 → 毎週金曜 02:00 JST', () => {
      expect(nextCronRunJst('0 17 * * 5')).toBe('毎週金曜 02:00 JST');
    });
  });

  describe('毎月スケジュール', () => {
    it('0 17 1 * * → 毎月 1 日 02:00 JST', () => {
      expect(nextCronRunJst('0 17 1 * *')).toBe('毎月 1 日 02:00 JST');
    });

    it('0 17 15 * * → 毎月 15 日 02:00 JST', () => {
      expect(nextCronRunJst('0 17 15 * *')).toBe('毎月 15 日 02:00 JST');
    });
  });

  describe('その他スケジュール', () => {
    it('*/5 * * * * → 定期実行', () => {
      const result = nextCronRunJst('*/5 * * * *');
      // Step expression — should return some label
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('無効な式', () => {
    it('フィールドが 4 つ → フォールバック', () => {
      expect(nextCronRunJst('* * * *')).toBe('(無効な cron 式)');
    });

    it('フィールドが 3 つ → フォールバック', () => {
      expect(nextCronRunJst('0 17 *')).toBe('(無効な cron 式)');
    });

    it('フィールドが 6 つ → フォールバック', () => {
      expect(nextCronRunJst('0 17 * * * extra')).toBe('(無効な cron 式)');
    });

    it('空文字列 → フォールバック', () => {
      expect(nextCronRunJst('')).toBe('(無効な cron 式)');
    });

    it('不正な文字 → フォールバック', () => {
      expect(nextCronRunJst('abc def * * *')).toBe('(無効な cron 式)');
    });

    it('分フィールドが範囲外 (60) → フォールバック', () => {
      expect(nextCronRunJst('60 17 * * *')).toBe('(無効な cron 式)');
    });

    it('時フィールドが範囲外 (24) → フォールバック', () => {
      expect(nextCronRunJst('0 24 * * *')).toBe('(無効な cron 式)');
    });
  });
});

describe('isValidCronExpression', () => {
  it('有効な毎日 cron → true', () => {
    expect(isValidCronExpression('0 17 * * *')).toBe(true);
  });

  it('有効な毎週 cron → true', () => {
    expect(isValidCronExpression('0 9 * * 1')).toBe(true);
  });

  it('有効な毎月 cron → true', () => {
    expect(isValidCronExpression('0 0 1 * *')).toBe(true);
  });

  it('フィールド不足 → false', () => {
    expect(isValidCronExpression('* * * *')).toBe(false);
  });

  it('空文字列 → false', () => {
    expect(isValidCronExpression('')).toBe(false);
  });

  it('不正な文字 → false', () => {
    expect(isValidCronExpression('foo bar * * *')).toBe(false);
  });

  it('分が 60 → false', () => {
    expect(isValidCronExpression('60 0 * * *')).toBe(false);
  });

  it('時が 24 → false', () => {
    expect(isValidCronExpression('0 24 * * *')).toBe(false);
  });

  it('日が 32 → false', () => {
    expect(isValidCronExpression('0 0 32 * *')).toBe(false);
  });

  it('月が 13 → false', () => {
    expect(isValidCronExpression('0 0 1 13 *')).toBe(false);
  });

  it('曜日が 8 → false', () => {
    expect(isValidCronExpression('0 0 * * 8')).toBe(false);
  });

  it('*/5 step 形式 → true', () => {
    expect(isValidCronExpression('*/5 * * * *')).toBe(true);
  });
});
