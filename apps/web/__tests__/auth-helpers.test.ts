/**
 * auth-helpers.ts のユニットテスト (docs/05 §13 #8)
 *
 * - session が null → AuthError
 * - user.id / username が欠落 → AuthError
 * - 正しい session → { user: { id, username } } を返す
 */
import { describe, expect, it } from 'vitest';
import { AuthError } from '@a2p/contracts';
import { assertAuthenticatedSession } from '../lib/auth-helpers';

describe('assertAuthenticatedSession', () => {
  it('session が null なら AuthError', () => {
    expect(() => assertAuthenticatedSession(null)).toThrow(AuthError);
  });

  it('session が undefined なら AuthError', () => {
    expect(() => assertAuthenticatedSession(undefined)).toThrow(AuthError);
  });

  it('user が無ければ AuthError', () => {
    expect(() => assertAuthenticatedSession({})).toThrow(AuthError);
  });

  it('user.id が無ければ AuthError', () => {
    expect(() => assertAuthenticatedSession({ user: { username: 'operator' } })).toThrow(
      AuthError,
    );
  });

  it('user.username が無ければ AuthError', () => {
    expect(() => assertAuthenticatedSession({ user: { id: 'u_1' } })).toThrow(AuthError);
  });

  it('id / username が空文字なら AuthError', () => {
    expect(() => assertAuthenticatedSession({ user: { id: '', username: 'op' } })).toThrow(
      AuthError,
    );
    expect(() => assertAuthenticatedSession({ user: { id: 'u_1', username: '' } })).toThrow(
      AuthError,
    );
  });

  it('id / username が文字列でなければ AuthError', () => {
    expect(() => assertAuthenticatedSession({ user: { id: 123, username: 'op' } })).toThrow(
      AuthError,
    );
  });

  it('正しい session は { user: { id, username } } を返す', () => {
    const result = assertAuthenticatedSession({
      user: { id: 'u_1', username: 'operator' },
      expires: '2026-06-22T00:00:00.000Z',
    });
    expect(result).toEqual({
      user: { id: 'u_1', username: 'operator' },
      expires: '2026-06-22T00:00:00.000Z',
    });
  });

  it('AuthError は userMessage を持つ', () => {
    try {
      assertAuthenticatedSession(null);
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).userMessage).toBeDefined();
      expect((err as AuthError).httpStatus).toBe(401);
    }
  });
});
