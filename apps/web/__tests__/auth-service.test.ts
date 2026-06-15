/**
 * auth-service.ts のユニットテスト (T-01-09 / F-043 受け入れ基準)
 *
 * 検証内容:
 *  - パスワード正解 → ok + 失敗カウンタリセット
 *  - パスワード不正 1〜4 回 → invalid_credentials + failed_count 増加
 *  - パスワード不正 5 回目 → locked + locked_until セット
 *  - ロック中はパスワード正解でも `locked` を返す
 *  - missing_fields の検知
 *  - 不存在ユーザーは invalid_credentials (列挙攻撃対策)
 */
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@a2p/db';
import {
  LOCK_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
  verifyCredentialsAndUpdateCounters,
} from '../lib/auth-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FROZEN_NOW = new Date('2026-05-22T10:00:00.000Z');

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u_1',
    username: 'operator',
    password_hash: '$2b$12$hashedPasswordPlaceholder',
    failed_count: 0,
    locked_until: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as User;
}

function makeRepo(user: User | null) {
  // ローカル可変状態で update を反映
  let current = user;
  const findUnique = vi.fn(async () => (current ? { ...current } : null));
  const update = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<User> }) => {
      if (!current || current.id !== where.id) {
        throw new Error('mock: user not found');
      }
      current = { ...current, ...data } as User;
      return { ...current };
    },
  );
  return {
    repo: { findUnique, update },
    getCurrent: () => (current ? { ...current } : null),
  };
}

// ---------------------------------------------------------------------------
// missing_fields
// ---------------------------------------------------------------------------

describe('verifyCredentialsAndUpdateCounters — missing_fields', () => {
  it('username が空なら missing_fields', async () => {
    const { repo } = makeRepo(makeUser());
    const result = await verifyCredentialsAndUpdateCounters(
      { username: '', password: 'whatever' },
      { userRepo: repo, compare: async () => true, now: () => FROZEN_NOW },
    );
    expect(result).toEqual({ kind: 'missing_fields' });
    expect(repo.findUnique).not.toHaveBeenCalled();
  });

  it('password が空なら missing_fields', async () => {
    const { repo } = makeRepo(makeUser());
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 'operator', password: '' },
      { userRepo: repo, compare: async () => true, now: () => FROZEN_NOW },
    );
    expect(result).toEqual({ kind: 'missing_fields' });
  });

  it('username が文字列でない場合も missing_fields', async () => {
    const { repo } = makeRepo(makeUser());
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 123, password: 'p' },
      { userRepo: repo, compare: async () => true, now: () => FROZEN_NOW },
    );
    expect(result).toEqual({ kind: 'missing_fields' });
  });
});

// ---------------------------------------------------------------------------
// 不存在ユーザー
// ---------------------------------------------------------------------------

describe('verifyCredentialsAndUpdateCounters — 不存在ユーザー', () => {
  it('invalid_credentials を返し、DB 更新は発生しない (列挙攻撃対策)', async () => {
    const { repo } = makeRepo(null);
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 'ghost', password: 'x' },
      { userRepo: repo, compare: async () => false, now: () => FROZEN_NOW },
    );
    expect(result.kind).toBe('invalid_credentials');
    expect(repo.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 成功
// ---------------------------------------------------------------------------

describe('verifyCredentialsAndUpdateCounters — 成功', () => {
  it('パスワード一致で ok を返す (failed_count=0 のまま)', async () => {
    const { repo, getCurrent } = makeRepo(makeUser());
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 'operator', password: 'correct' },
      { userRepo: repo, compare: async () => true, now: () => FROZEN_NOW },
    );
    expect(result).toEqual({ kind: 'ok', user: { id: 'u_1', username: 'operator' } });
    // failed_count が既に 0 なら update を呼ばない (無駄 IO 削減)
    expect(repo.update).not.toHaveBeenCalled();
    expect(getCurrent()?.failed_count).toBe(0);
  });

  it('カウンタが立っていればリセットされる', async () => {
    const { repo, getCurrent } = makeRepo(makeUser({ failed_count: 3 }));
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 'operator', password: 'correct' },
      { userRepo: repo, compare: async () => true, now: () => FROZEN_NOW },
    );
    expect(result.kind).toBe('ok');
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(getCurrent()?.failed_count).toBe(0);
    expect(getCurrent()?.locked_until).toBeNull();
  });

  it('過去にロックされていた場合、解除後の成功で locked_until=null になる', async () => {
    const expired = new Date(FROZEN_NOW.getTime() - 60_000);
    const { repo, getCurrent } = makeRepo(
      makeUser({ failed_count: 5, locked_until: expired }),
    );
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 'operator', password: 'correct' },
      { userRepo: repo, compare: async () => true, now: () => FROZEN_NOW },
    );
    expect(result.kind).toBe('ok');
    expect(getCurrent()?.failed_count).toBe(0);
    expect(getCurrent()?.locked_until).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 失敗カウンタ
// ---------------------------------------------------------------------------

describe('verifyCredentialsAndUpdateCounters — 失敗カウンタ', () => {
  it('1 回目の失敗で failed_count=1 / remaining=4', async () => {
    const { repo, getCurrent } = makeRepo(makeUser());
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 'operator', password: 'bad' },
      { userRepo: repo, compare: async () => false, now: () => FROZEN_NOW },
    );
    expect(result).toEqual({ kind: 'invalid_credentials', remaining: 4 });
    expect(getCurrent()?.failed_count).toBe(1);
    expect(getCurrent()?.locked_until).toBeNull();
  });

  it('4 回目までは invalid_credentials で remaining が減る', async () => {
    const { repo, getCurrent } = makeRepo(makeUser({ failed_count: 3 }));
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 'operator', password: 'bad' },
      { userRepo: repo, compare: async () => false, now: () => FROZEN_NOW },
    );
    expect(result).toEqual({ kind: 'invalid_credentials', remaining: 1 });
    expect(getCurrent()?.failed_count).toBe(4);
    expect(getCurrent()?.locked_until).toBeNull();
  });

  it('5 回目の失敗で locked + locked_until = now + 15min', async () => {
    const { repo, getCurrent } = makeRepo(makeUser({ failed_count: 4 }));
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 'operator', password: 'bad' },
      { userRepo: repo, compare: async () => false, now: () => FROZEN_NOW },
    );
    expect(result.kind).toBe('locked');
    if (result.kind !== 'locked') return;
    expect(result.unlockAt.getTime()).toBe(FROZEN_NOW.getTime() + LOCK_DURATION_MS);
    expect(getCurrent()?.failed_count).toBe(MAX_FAILED_ATTEMPTS);
    expect(getCurrent()?.locked_until?.getTime()).toBe(
      FROZEN_NOW.getTime() + LOCK_DURATION_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// ロック中の挙動
// ---------------------------------------------------------------------------

describe('verifyCredentialsAndUpdateCounters — ロック中', () => {
  it('ロック中はパスワードが正しくても locked', async () => {
    const lockedUntil = new Date(FROZEN_NOW.getTime() + 5 * 60 * 1000);
    const { repo, getCurrent } = makeRepo(
      makeUser({ failed_count: 5, locked_until: lockedUntil }),
    );
    const compare = vi.fn(async () => true);
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 'operator', password: 'correct' },
      { userRepo: repo, compare, now: () => FROZEN_NOW },
    );
    expect(result).toEqual({ kind: 'locked', unlockAt: lockedUntil });
    // ロック中は bcrypt を呼ばないこと (CPU 節約 + サイドチャネル削減)
    expect(compare).not.toHaveBeenCalled();
    // 失敗カウンタを増やさない
    expect(getCurrent()?.failed_count).toBe(5);
  });

  it('ロック解除直後 (locked_until <= now) は通常の検証に進む', async () => {
    const justExpired = new Date(FROZEN_NOW.getTime() - 1);
    const { repo } = makeRepo(
      makeUser({ failed_count: 5, locked_until: justExpired }),
    );
    const result = await verifyCredentialsAndUpdateCounters(
      { username: 'operator', password: 'correct' },
      { userRepo: repo, compare: async () => true, now: () => FROZEN_NOW },
    );
    expect(result.kind).toBe('ok');
  });
});
