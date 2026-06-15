import { describe, expect, expectTypeOf, it } from 'vitest';
import { fail, isFail, isOk, ok, type ActionResult } from '../src/result.js';

describe('ok()', () => {
  it('成功結果を生成する', () => {
    const r = ok({ id: 'b_1', title: 'タイトル' });
    expect(r).toEqual({ ok: true, data: { id: 'b_1', title: 'タイトル' } });
  });

  it('data 型は呼び出し側で推論される', () => {
    const r = ok(42 as const);
    expectTypeOf(r.data).toEqualTypeOf<42>();
  });
});

describe('fail()', () => {
  it('details なしで失敗結果を生成する', () => {
    const r = fail('validation', '入力値が不正です');
    expect(r).toEqual({
      ok: false,
      error: { code: 'validation', message: '入力値が不正です' },
    });
    expect(r.error).not.toHaveProperty('details');
  });

  it('details ありで失敗結果を生成する', () => {
    const r = fail('validation', '入力値が不正です', { field: 'title' });
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'validation',
        message: '入力値が不正です',
        details: { field: 'title' },
      },
    });
  });
});

describe('isOk / isFail 型ガード', () => {
  it('成功側を絞り込む', () => {
    const r: ActionResult<{ id: string }> = ok({ id: 'x' });
    if (isOk(r)) {
      expectTypeOf(r.data).toEqualTypeOf<{ id: string }>();
      expect(r.data.id).toBe('x');
    } else {
      throw new Error('expected ok');
    }
  });

  it('失敗側を絞り込む', () => {
    const r: ActionResult<{ id: string }> = fail('not_found', '見つかりません');
    expect(isFail(r)).toBe(true);
    if (isFail(r)) {
      expect(r.error.code).toBe('not_found');
    }
  });
});
