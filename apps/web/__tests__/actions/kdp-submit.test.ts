/**
 * kdp-submit.ts のユニットテスト (T-08-09, F-041).
 *
 * 検証:
 *  1. 不正入力 → validation fail (zod)
 *  2. 有効入力 + 認証済 → Phase 3 未有効 conflict fail (throw しない、enqueue しない)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isFail, isOk } from '@a2p/contracts';

// ---------------------------------------------------------------------------
// auth-helpers をモック — SA 内の getSessionOrThrow が呼ばれたとき認証済とみなす。
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth-helpers', () => ({
  getSessionOrThrow: vi.fn().mockResolvedValue({
    user: { id: 'u_1', username: 'operator' },
  }),
}));

// ---------------------------------------------------------------------------
// next/cache をモック — 'use server' ファイルが revalidatePath を呼んでも落ちない。
// ---------------------------------------------------------------------------

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

// モック後に動的 import する (SA は module-level で副作用がある場合の対策)
let submitToKdp: (input: unknown) => Promise<import('@a2p/contracts').ActionResult<unknown>>;

beforeEach(async () => {
  vi.clearAllMocks();
  // SA を動的 import して毎テスト前にフレッシュな状態を確保
  const mod = await import('@/app/actions/kdp-submit');
  submitToKdp = mod.submitToKdp as typeof submitToKdp;
});

// ---------------------------------------------------------------------------
// Test 1: 不正入力 → validation fail
// ---------------------------------------------------------------------------

describe('submitToKdp — validation', () => {
  it('book_ids が空配列のとき validation fail を返す', async () => {
    const result = await submitToKdp({ book_ids: [] });
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('book_ids が 21 件のとき validation fail を返す (max 20)', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `book_${i}`);
    const result = await submitToKdp({ book_ids: ids });
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('book_ids が文字列のとき validation fail を返す', async () => {
    const result = await submitToKdp({ book_ids: 'not-an-array' });
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('book_ids が未指定のとき validation fail を返す', async () => {
    const result = await submitToKdp({});
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('null 入力のとき validation fail を返す', async () => {
    const result = await submitToKdp(null);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Test 2: 有効入力 → Phase 3 未有効 conflict fail
// ---------------------------------------------------------------------------

describe('submitToKdp — Phase 3 stub', () => {
  it('有効入力でも conflict を返す (Phase 3 で有効化)', async () => {
    const result = await submitToKdp({ book_ids: ['book_1'] });
    expect(isOk(result)).toBe(false);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) {
      expect(result.error.code).toBe('conflict');
      // Phase 3 の未有効メッセージが含まれること
      expect(result.error.message).toMatch(/Phase 3/);
    }
  });

  it('複数書籍 IDs でも conflict を返す', async () => {
    const result = await submitToKdp({ book_ids: ['book_1', 'book_2', 'book_3'] });
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('conflict');
  });

  it('throw しない (スタブは例外を送出しない)', async () => {
    await expect(submitToKdp({ book_ids: ['book_x'] })).resolves.toBeDefined();
  });
});
