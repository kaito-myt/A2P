/**
 * accounts-core.ts のユニットテスト (T-01-11 / F-044)。
 *
 * 検証:
 *  - createAccount/updateAccount/archiveAccount の zod 検証
 *  - 各 SA で audit_log INSERT が走る (actor / action / target / before / after)
 *  - kdp_credentials が与えられた時のみ encrypt が呼ばれる
 *  - 暗号化失敗 (KDP_CRED_KEY 未設定) で ValidationError → fail
 *  - 存在しない account へ update / archive で not_found
 *  - audit_log の after_json に kdp_credentials_enc 実値が含まれない (機密 redact)
 */
import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@a2p/db';
import { ConfigError, isFail, isOk } from '@a2p/contracts';
import {
  archiveAccountCore,
  createAccountCore,
  updateAccountCore,
  type AccountsDeps,
} from '../../lib/accounts-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FROZEN_NOW = new Date('2026-05-22T10:00:00.000Z');

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc_1',
    pen_name: 'default',
    display_name: null,
    bio: null,
    target_reader: null,
    genre_policy_json: {
      primary_genre: 'practical',
      ratio: { practical: 0.4, business: 0.35, self_help: 0.25 },
      focus_themes: [],
    } as unknown as Account['genre_policy_json'],
    kdp_credentials_enc: null,
    kdp_2fa_secret_enc: null,
    status: 'active',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Account;
}

function makeDeps(opts: {
  existing?: Account | null;
  encrypt?: (s: string) => string;
} = {}): {
  deps: AccountsDeps;
  spies: {
    accountCreate: ReturnType<typeof vi.fn>;
    accountUpdate: ReturnType<typeof vi.fn>;
    accountFind: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
    encrypt: ReturnType<typeof vi.fn>;
  };
} {
  let current: Account | null = opts.existing ?? null;
  const accountCreate = vi.fn(async ({ data }: { data: Partial<Account> }) => {
    const next = makeAccount({ ...(data as Partial<Account>), id: 'acc_new' });
    current = next;
    return next;
  });
  const accountUpdate = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<Account> }) => {
      if (!current || current.id !== where.id) throw new Error('not found');
      current = { ...current, ...(data as Partial<Account>) } as Account;
      return current;
    },
  );
  const accountFind = vi.fn(async ({ where }: { where: { id: string } }) => {
    if (current && current.id === where.id) return { ...current };
    return null;
  });
  const auditCreate = vi.fn(async () => ({}));
  const encrypt = vi.fn(opts.encrypt ?? ((s: string) => `enc(${s})`));

  return {
    deps: {
      accountRepo: {
        create: accountCreate,
        update: accountUpdate,
        findUnique: accountFind,
      } as unknown as AccountsDeps['accountRepo'],
      auditLogRepo: { create: auditCreate } as unknown as AccountsDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
      encrypt,
      now: () => FROZEN_NOW,
    },
    spies: { accountCreate, accountUpdate, accountFind, auditCreate, encrypt },
  };
}

const VALID_GENRE = {
  primary_genre: 'practical' as const,
  ratio: { practical: 0.4, business: 0.35, self_help: 0.25 },
  focus_themes: ['副業', '時間術'],
};

// ---------------------------------------------------------------------------
// createAccount
// ---------------------------------------------------------------------------

describe('createAccountCore', () => {
  it('zod 必須項目 (pen_name) が欠ければ validation', async () => {
    const { deps } = makeDeps();
    const r = await createAccountCore({ genre_policy: VALID_GENRE }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('genre_policy が欠ければ validation', async () => {
    const { deps } = makeDeps();
    const r = await createAccountCore({ pen_name: 'A' }, deps);
    expect(isFail(r)).toBe(true);
  });

  it('pen_name が 51 文字なら validation', async () => {
    const { deps } = makeDeps();
    const r = await createAccountCore(
      { pen_name: 'a'.repeat(51), genre_policy: VALID_GENRE },
      deps,
    );
    expect(isFail(r)).toBe(true);
  });

  it('focus_themes が 21 件なら validation', async () => {
    const { deps } = makeDeps();
    const genre = { ...VALID_GENRE, focus_themes: Array.from({ length: 21 }, (_, i) => `t${i}`) };
    const r = await createAccountCore({ pen_name: 'A', genre_policy: genre }, deps);
    expect(isFail(r)).toBe(true);
  });

  it('正常入力で create + audit_log が呼ばれる', async () => {
    const { deps, spies } = makeDeps();
    const r = await createAccountCore(
      { pen_name: 'default', genre_policy: VALID_GENRE },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.id).toBe('acc_new');
    expect(spies.accountCreate).toHaveBeenCalledTimes(1);
    expect(spies.auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArg.data.actor_id).toBe('u_1');
    expect(auditArg.data.action).toBe('account.create');
    expect(auditArg.data.target_kind).toBe('account');
    expect(auditArg.data.target_id).toBe('acc_new');
  });

  it('kdp_credentials なしなら encrypt は呼ばれず enc=null', async () => {
    const { deps, spies } = makeDeps();
    const r = await createAccountCore(
      { pen_name: 'A', genre_policy: VALID_GENRE },
      deps,
    );
    expect(isOk(r)).toBe(true);
    expect(spies.encrypt).not.toHaveBeenCalled();
    const createArg = spies.accountCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createArg.data.kdp_credentials_enc).toBeNull();
  });

  it('kdp_credentials あれば encrypt(JSON.stringify({email, password, totp_secret})) を呼ぶ', async () => {
    const { deps, spies } = makeDeps();
    const r = await createAccountCore(
      {
        pen_name: 'A',
        genre_policy: VALID_GENRE,
        kdp_credentials: {
          email: 'kdp@example.com',
          password: 'secret-pw',
          totp_secret: 'TOTP123',
        },
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    expect(spies.encrypt).toHaveBeenCalledTimes(1);
    const plaintext = spies.encrypt.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(plaintext);
    expect(parsed).toEqual({
      email: 'kdp@example.com',
      password: 'secret-pw',
      totp_secret: 'TOTP123',
    });
    const createArg = spies.accountCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createArg.data.kdp_credentials_enc).toBe(`enc(${plaintext})`);
  });

  it('audit_log の after_json に kdp_credentials_enc 実値は含まれない (機密 redact)', async () => {
    const { deps, spies } = makeDeps();
    await createAccountCore(
      {
        pen_name: 'A',
        genre_policy: VALID_GENRE,
        kdp_credentials: { email: 'kdp@example.com', password: 'pw' },
      },
      deps,
    );
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as {
      data: { after_json: Record<string, unknown> };
    };
    expect(auditArg.data.after_json).toBeDefined();
    expect(auditArg.data.after_json).not.toHaveProperty('kdp_credentials_enc');
    expect(auditArg.data.after_json).not.toHaveProperty('kdp_2fa_secret_enc');
    expect(auditArg.data.after_json.kdp_credentials_set).toBe(true);
  });

  it('encrypt が ConfigError を投げると validation/config として fail', async () => {
    const { deps } = makeDeps({
      encrypt: () => {
        throw new ConfigError('no key', { userMessage: '鍵なし' });
      },
    });
    const r = await createAccountCore(
      {
        pen_name: 'A',
        genre_policy: VALID_GENRE,
        kdp_credentials: { email: 'a@b.com', password: 'p' },
      },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('config');
  });

  it('encrypt が一般例外を投げると ValidationError 経由で fail', async () => {
    const { deps } = makeDeps({
      encrypt: () => {
        throw new Error('boom');
      },
    });
    const r = await createAccountCore(
      {
        pen_name: 'A',
        genre_policy: VALID_GENRE,
        kdp_credentials: { email: 'a@b.com', password: 'p' },
      },
      deps,
    );
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// updateAccount
// ---------------------------------------------------------------------------

describe('updateAccountCore', () => {
  it('id 欠落で validation', async () => {
    const { deps } = makeDeps({ existing: makeAccount() });
    const r = await updateAccountCore({ pen_name: 'X' }, deps);
    expect(isFail(r)).toBe(true);
  });

  it('存在しない id なら not_found', async () => {
    const { deps } = makeDeps({ existing: null });
    const r = await updateAccountCore({ id: 'missing', pen_name: 'X' }, deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });

  it('部分更新 (pen_name のみ) で update + audit を呼ぶ', async () => {
    const before = makeAccount({ pen_name: 'old' });
    const { deps, spies } = makeDeps({ existing: before });
    const r = await updateAccountCore({ id: before.id, pen_name: 'new' }, deps);
    expect(isOk(r)).toBe(true);
    const updArg = spies.accountUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updArg.data).toEqual({ pen_name: 'new' });
    expect(spies.encrypt).not.toHaveBeenCalled();
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe('account.update');
    expect(auditArg.data.before_json).toBeDefined();
    expect(auditArg.data.after_json).toBeDefined();
  });

  it('kdp_credentials を渡すと encrypt 結果が enc 列に入る', async () => {
    const before = makeAccount({ pen_name: 'A' });
    const { deps, spies } = makeDeps({ existing: before });
    const r = await updateAccountCore(
      {
        id: before.id,
        kdp_credentials: { email: 'k@e.com', password: 'pw' },
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    expect(spies.encrypt).toHaveBeenCalledTimes(1);
    const updArg = spies.accountUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(typeof updArg.data.kdp_credentials_enc).toBe('string');
    expect(updArg.data.kdp_credentials_enc).toMatch(/^enc\(/);
  });

  it('kdp_credentials を渡さない場合 enc 列は更新対象外', async () => {
    const before = makeAccount({ pen_name: 'A', kdp_credentials_enc: 'existing_enc' });
    const { deps, spies } = makeDeps({ existing: before });
    await updateAccountCore({ id: before.id, pen_name: 'B' }, deps);
    const updArg = spies.accountUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updArg.data).not.toHaveProperty('kdp_credentials_enc');
  });

  it('audit_log は before/after 両方を持ち、機密 enc を含まない', async () => {
    const before = makeAccount({ pen_name: 'A', kdp_credentials_enc: 'existing_enc' });
    const { deps, spies } = makeDeps({ existing: before });
    await updateAccountCore(
      {
        id: before.id,
        kdp_credentials: { email: 'k@e.com', password: 'pw' },
      },
      deps,
    );
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as {
      data: { before_json: Record<string, unknown>; after_json: Record<string, unknown> };
    };
    expect(auditArg.data.before_json).not.toHaveProperty('kdp_credentials_enc');
    expect(auditArg.data.after_json).not.toHaveProperty('kdp_credentials_enc');
    expect(auditArg.data.before_json.kdp_credentials_set).toBe(true);
    expect(auditArg.data.after_json.kdp_credentials_set).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// archiveAccount
// ---------------------------------------------------------------------------

describe('archiveAccountCore', () => {
  it('空 id で validation', async () => {
    const { deps } = makeDeps();
    const r = await archiveAccountCore('', deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('validation');
  });

  it('存在しない id で not_found', async () => {
    const { deps } = makeDeps({ existing: null });
    const r = await archiveAccountCore('missing', deps);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.error.code).toBe('not_found');
  });

  it('正常系: status=archived に update + audit_log', async () => {
    const before = makeAccount({ status: 'active' });
    const { deps, spies } = makeDeps({ existing: before });
    const r = await archiveAccountCore(before.id, deps);
    expect(isOk(r)).toBe(true);
    const updArg = spies.accountUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updArg.data).toEqual({ status: 'archived' });
    const auditArg = spies.auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('account.archive');
    expect(auditArg.data.target_id).toBe(before.id);
  });

  it('encrypt 未注入でも kdp 操作が無ければ問題なく動く', async () => {
    const before = makeAccount({ status: 'active' });
    const deps: AccountsDeps = {
      accountRepo: {
        create: vi.fn(),
        update: vi.fn(async () => makeAccount({ status: 'archived' })),
        findUnique: vi.fn(async () => before),
      } as unknown as AccountsDeps['accountRepo'],
      auditLogRepo: { create: vi.fn() } as unknown as AccountsDeps['auditLogRepo'],
      session: { user: { id: 'u_1', username: 'operator' } },
      // encrypt 省略
    };
    const r = await archiveAccountCore(before.id, deps);
    expect(isOk(r)).toBe(true);
  });
});
