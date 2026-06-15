/**
 * Account Server Action のコアロジック (T-01-11, F-044)。
 *
 * Server Actions (`app/actions/accounts.ts`) は薄いラッパに留め、
 * 業務ロジック (zod 検証 / KDP credentials 暗号化 / audit_log INSERT) を
 * このモジュールに切り出すことで Vitest からテスト可能にする。
 *
 * 依存 (prisma / encrypt / session) はすべて DI 経由で受け取り、
 * テストでは mock を渡す。
 *
 * 仕様根拠: docs/05 §4.3.1 (zod schema) / docs/02 F-044 / docs/03 §KDP-04。
 */
import { z } from 'zod';
import {
  ConfigError,
  NotFoundError,
  ValidationError,
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import { Prisma, type Account } from '@a2p/db';
import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schemas — docs/05 §4.3.1 完全準拠
// ---------------------------------------------------------------------------

/**
 * KDP 認証情報。Phase 1 では空可。Phase 3 で必須化される。
 * UI からは「再入力」モード時のみ送信される。
 */
const kdpCredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp_secret: z.string().optional(),
});

const genrePolicySchema = z.object({
  primary_genre: z.enum(['practical', 'business', 'self_help']),
  ratio: z.record(z.string(), z.number().min(0).max(1)),
  focus_themes: z.array(z.string()).max(20),
});

export const createAccountInput = z.object({
  pen_name: z.string().min(1).max(50),
  display_name: z.string().max(50).optional(),
  bio: z.string().max(1000).optional(),
  target_reader: z.string().max(500).optional(),
  genre_policy: genrePolicySchema,
  kdp_credentials: kdpCredentialsSchema.optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountInput>;

export const updateAccountInput = createAccountInput.partial().extend({
  id: z.string().min(1),
});

export type UpdateAccountInput = z.infer<typeof updateAccountInput>;

// ---------------------------------------------------------------------------
// DI 境界
// ---------------------------------------------------------------------------

/** prisma.account 互換の最小サブセット (テスト容易化のため interface 化)。 */
export interface AccountRepo {
  create(args: { data: Prisma.AccountUncheckedCreateInput }): Promise<Account>;
  update(args: {
    where: { id: string };
    data: Prisma.AccountUncheckedUpdateInput;
  }): Promise<Account>;
  findUnique(args: { where: { id: string } }): Promise<Account | null>;
}

/** prisma.auditLog.create の最小サブセット。 */
export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export interface AccountsDeps {
  accountRepo: AccountRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  /**
   * KDP 平文 (JSON 化済 string) を暗号化して base64 暗号文を返す。
   * 本番では `@a2p/crypto` の `encryptKdpCredentials` を注入する。
   */
  encrypt?: (plaintext: string) => string;
  now?: () => Date;
}

interface ResolvedDeps {
  accountRepo: AccountRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  encrypt: (plaintext: string) => string;
  now: () => Date;
}

function resolveDeps(d: AccountsDeps): ResolvedDeps {
  return {
    accountRepo: d.accountRepo,
    auditLogRepo: d.auditLogRepo,
    session: d.session,
    encrypt:
      d.encrypt ??
      (() => {
        throw new ConfigError('encrypt dep must be injected at runtime', {
          userMessage: messages.accounts.detail.errors.kdpKeyMissing,
        });
      }),
    now: d.now ?? (() => new Date()),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * KDP 認証情報を JSON 化して暗号化する。undefined は null を返す。
 * encrypt 関数の失敗 (KDP_CRED_KEY 未設定 etc.) は ValidationError として再 throw。
 */
function encryptCredentialsIfPresent(
  creds: CreateAccountInput['kdp_credentials'] | undefined,
  encrypt: (s: string) => string,
): string | null {
  if (!creds) return null;
  try {
    const plaintext = JSON.stringify({
      login: creds.email,
      password: creds.password,
      ...(creds.totp_secret !== undefined ? { totp_secret: creds.totp_secret } : {}),
    });
    return encrypt(plaintext);
  } catch (err) {
    if (isA2PError(err)) throw err;
    throw new ValidationError('KDP credentials encryption failed', {
      userMessage: messages.accounts.detail.errors.encryption,
      cause: err,
    });
  }
}

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

/**
 * 監査ログ用に Account 行から機密 (kdp_credentials_enc / kdp_2fa_secret_enc) を
 * 取り除いた diff 用スナップショットを返す。
 */
function redactedSnapshot(a: Account | null): Record<string, unknown> | null {
  if (!a) return null;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (k === 'kdp_credentials_enc' || k === 'kdp_2fa_secret_enc') continue;
    rest[k] = v instanceof Date ? v.toISOString() : v;
  }
  rest.kdp_credentials_set = a.kdp_credentials_enc != null;
  rest.kdp_2fa_secret_set = a.kdp_2fa_secret_enc != null;
  return rest;
}

// ---------------------------------------------------------------------------
// createAccount
// ---------------------------------------------------------------------------

export async function createAccountCore(
  raw: unknown,
  rawDeps: AccountsDeps,
): Promise<ActionResult<{ id: string }>> {
  const deps = resolveDeps(rawDeps);
  const parsed = createAccountInput.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.accounts.detail.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;
    const enc = encryptCredentialsIfPresent(input.kdp_credentials, deps.encrypt);

    const created = await deps.accountRepo.create({
      data: {
        pen_name: input.pen_name,
        display_name: input.display_name ?? null,
        bio: input.bio ?? null,
        target_reader: input.target_reader ?? null,
        genre_policy_json: input.genre_policy as unknown as Prisma.InputJsonValue,
        kdp_credentials_enc: enc,
        kdp_2fa_secret_enc: null,
        status: 'active',
      },
    });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'account.create',
        target_kind: 'account',
        target_id: created.id,
        before_json: Prisma.JsonNull,
        after_json: redactedSnapshot(created) as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ id: created.id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.accounts.detail.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// updateAccount
// ---------------------------------------------------------------------------

export async function updateAccountCore(
  raw: unknown,
  rawDeps: AccountsDeps,
): Promise<ActionResult<void>> {
  const deps = resolveDeps(rawDeps);
  const parsed = updateAccountInput.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.accounts.detail.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;
    const before = await deps.accountRepo.findUnique({ where: { id: input.id } });
    if (!before) {
      throw new NotFoundError('Account not found', {
        userMessage: messages.accounts.detail.errors.notFound,
      });
    }

    const data: Prisma.AccountUncheckedUpdateInput = {};
    if (input.pen_name !== undefined) data.pen_name = input.pen_name;
    if (input.display_name !== undefined) data.display_name = input.display_name ?? null;
    if (input.bio !== undefined) data.bio = input.bio ?? null;
    if (input.target_reader !== undefined) data.target_reader = input.target_reader ?? null;
    if (input.genre_policy !== undefined)
      data.genre_policy_json = input.genre_policy as unknown as Prisma.InputJsonValue;
    if (input.kdp_credentials !== undefined) {
      data.kdp_credentials_enc = encryptCredentialsIfPresent(
        input.kdp_credentials,
        deps.encrypt,
      );
    }

    const after = await deps.accountRepo.update({ where: { id: input.id }, data });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'account.update',
        target_kind: 'account',
        target_id: input.id,
        before_json: redactedSnapshot(before) as unknown as Prisma.InputJsonValue,
        after_json: redactedSnapshot(after) as unknown as Prisma.InputJsonValue,
      },
    });

    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.accounts.detail.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// archiveAccount
// ---------------------------------------------------------------------------

export async function archiveAccountCore(
  id: string,
  rawDeps: AccountsDeps,
): Promise<ActionResult<void>> {
  const deps = resolveDeps(rawDeps);

  if (typeof id !== 'string' || id.length === 0) {
    return fail('validation', messages.accounts.detail.errors.validation, {
      issues: [{ path: 'id', message: 'id is required' }],
    });
  }

  try {
    const before = await deps.accountRepo.findUnique({ where: { id } });
    if (!before) {
      throw new NotFoundError('Account not found', {
        userMessage: messages.accounts.detail.errors.notFound,
      });
    }

    const after = await deps.accountRepo.update({
      where: { id },
      data: { status: 'archived' },
    });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'account.archive',
        target_kind: 'account',
        target_id: id,
        before_json: redactedSnapshot(before) as unknown as Prisma.InputJsonValue,
        after_json: redactedSnapshot(after) as unknown as Prisma.InputJsonValue,
      },
    });

    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.accounts.detail.errors.unknown);
  }
}
