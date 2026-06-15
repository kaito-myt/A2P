/**
 * API キー管理 Server Action のコアロジック (T-02-13, F-051/F-052).
 *
 * `app/actions/api-credentials.ts` は薄いラッパに留め、業務ロジック
 * (zod 検証 / 暗号化 / DB upsert / audit_log INSERT) をこのモジュールに
 * 切り出すことで Vitest からテスト可能にする。
 *
 * 仕様根拠: docs/05 §4.3.X / docs/02 F-051 F-052.
 *
 * UI 本体は SP-07 T-07-XX で実装するが、SA + DB 基盤を SP-02 で先行整備。
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
import { Prisma, type ApiCredential } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schemas
// ---------------------------------------------------------------------------

const providerSchema = z.enum(['anthropic', 'openai', 'google']);
export type ApiProvider = z.infer<typeof providerSchema>;

export const setApiCredentialInput = z.object({
  provider: providerSchema,
  key: z.string().min(1).max(2048),
});

export type SetApiCredentialInput = z.infer<typeof setApiCredentialInput>;

export const providerOnlyInput = z.object({ provider: providerSchema });

// ---------------------------------------------------------------------------
// DI 境界
// ---------------------------------------------------------------------------

export interface ApiCredentialRepo {
  findUnique(args: { where: { provider: string } }): Promise<ApiCredential | null>;
  upsert(args: {
    where: { provider: string };
    create: Prisma.ApiCredentialUncheckedCreateInput;
    update: Prisma.ApiCredentialUncheckedUpdateInput;
  }): Promise<ApiCredential>;
  update(args: {
    where: { provider: string };
    data: Prisma.ApiCredentialUncheckedUpdateInput;
  }): Promise<ApiCredential>;
  delete(args: { where: { provider: string } }): Promise<ApiCredential>;
}

export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

/** プロバイダの "models.list" 相当を叩いて疎通確認するクライアント。 */
export type ProviderTestClient = (
  provider: ApiProvider,
  plaintextKey: string,
) => Promise<{ ok: boolean; message: string; http_status?: number; latency_ms?: number }>;

export interface ApiCredentialsDeps {
  apiCredentialRepo: ApiCredentialRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  encrypt?: (plain: string) => string;
  decrypt?: (enc: string) => string;
  mask?: (plain: string) => string;
  invalidateCache?: (provider: ApiProvider) => void;
  testClient?: ProviderTestClient;
  now?: () => Date;
}

interface ResolvedDeps {
  apiCredentialRepo: ApiCredentialRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  encrypt: (plain: string) => string;
  decrypt: (enc: string) => string;
  mask: (plain: string) => string;
  invalidateCache: (provider: ApiProvider) => void;
  testClient: ProviderTestClient;
  now: () => Date;
}

function resolveDeps(d: ApiCredentialsDeps): ResolvedDeps {
  return {
    apiCredentialRepo: d.apiCredentialRepo,
    auditLogRepo: d.auditLogRepo,
    session: d.session,
    encrypt:
      d.encrypt ??
      (() => {
        throw new ConfigError('encrypt dep must be injected at runtime', {
          userMessage: messages.apiCredentials.errors.keyMissing,
        });
      }),
    decrypt:
      d.decrypt ??
      (() => {
        throw new ConfigError('decrypt dep must be injected at runtime', {
          userMessage: messages.apiCredentials.errors.keyMissing,
        });
      }),
    mask: d.mask ?? ((s) => s),
    invalidateCache: d.invalidateCache ?? (() => undefined),
    testClient:
      d.testClient ??
      (async () => ({
        ok: false,
        message: 'no provider test client injected',
      })),
    now: d.now ?? (() => new Date()),
  };
}

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

function maskSnapshot(c: ApiCredential | null): Record<string, unknown> | null {
  if (!c) return null;
  return {
    id: c.id,
    provider: c.provider,
    key_mask: c.key_mask,
    set_at: c.set_at instanceof Date ? c.set_at.toISOString() : c.set_at,
    set_by: c.set_by,
    last_tested_at:
      c.last_tested_at instanceof Date ? c.last_tested_at.toISOString() : c.last_tested_at,
    last_test_result_json: c.last_test_result_json,
  };
}

// ---------------------------------------------------------------------------
// setApiCredential
// ---------------------------------------------------------------------------

export async function setApiCredentialCore(
  raw: unknown,
  rawDeps: ApiCredentialsDeps,
): Promise<ActionResult<{ provider: ApiProvider; key_mask: string }>> {
  const deps = resolveDeps(rawDeps);
  const parsed = setApiCredentialInput.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.apiCredentials.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;
    const before = await deps.apiCredentialRepo.findUnique({
      where: { provider: input.provider },
    });

    let enc: string;
    let mask: string;
    try {
      enc = deps.encrypt(input.key);
      mask = deps.mask(input.key);
    } catch (err) {
      if (isA2PError(err)) throw err;
      throw new ValidationError('API key encryption failed', {
        userMessage: messages.apiCredentials.errors.encryption,
        cause: err,
      });
    }

    const now = deps.now();
    const after = await deps.apiCredentialRepo.upsert({
      where: { provider: input.provider },
      create: {
        provider: input.provider,
        key_enc: enc,
        key_mask: mask,
        set_at: now,
        set_by: deps.session.user.id,
        last_tested_at: null,
        last_test_result_json: Prisma.JsonNull,
      },
      update: {
        key_enc: enc,
        key_mask: mask,
        set_at: now,
        set_by: deps.session.user.id,
        // テスト履歴はキー入れ替えで無効化する
        last_tested_at: null,
        last_test_result_json: Prisma.JsonNull,
      },
    });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'api_credential.set',
        target_kind: 'api_credential',
        target_id: after.id,
        before_json: (maskSnapshot(before) ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        after_json: maskSnapshot(after) as unknown as Prisma.InputJsonValue,
      },
    });

    deps.invalidateCache(input.provider);

    return ok({ provider: input.provider, key_mask: after.key_mask });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.apiCredentials.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// revokeApiCredential
// ---------------------------------------------------------------------------

export async function revokeApiCredentialCore(
  raw: unknown,
  rawDeps: ApiCredentialsDeps,
): Promise<ActionResult<void>> {
  const deps = resolveDeps(rawDeps);
  const parsed = providerOnlyInput.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.apiCredentials.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const { provider } = parsed.data;
    const before = await deps.apiCredentialRepo.findUnique({ where: { provider } });
    if (!before) {
      throw new NotFoundError('ApiCredential not found', {
        userMessage: messages.apiCredentials.errors.notFound,
      });
    }
    await deps.apiCredentialRepo.delete({ where: { provider } });
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'api_credential.revoke',
        target_kind: 'api_credential',
        target_id: before.id,
        before_json: maskSnapshot(before) as unknown as Prisma.InputJsonValue,
        after_json: Prisma.JsonNull,
      },
    });
    deps.invalidateCache(provider);
    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.apiCredentials.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// testApiCredential
// ---------------------------------------------------------------------------

export async function testApiCredentialCore(
  raw: unknown,
  rawDeps: ApiCredentialsDeps,
): Promise<
  ActionResult<{
    ok: boolean;
    message: string;
    http_status?: number;
    latency_ms?: number;
  }>
> {
  const deps = resolveDeps(rawDeps);
  const parsed = providerOnlyInput.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.apiCredentials.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const { provider } = parsed.data;
    const row = await deps.apiCredentialRepo.findUnique({ where: { provider } });
    if (!row) {
      throw new NotFoundError('ApiCredential not found', {
        userMessage: messages.apiCredentials.errors.notFound,
      });
    }

    let plain: string;
    try {
      plain = deps.decrypt(row.key_enc);
    } catch (err) {
      if (isA2PError(err)) throw err;
      throw new ValidationError('API key decryption failed', {
        userMessage: messages.apiCredentials.errors.encryption,
        cause: err,
      });
    }

    const result = await deps.testClient(provider, plain);
    const now = deps.now();

    const updated = await deps.apiCredentialRepo.update({
      where: { provider },
      data: {
        last_tested_at: now,
        last_test_result_json: result as unknown as Prisma.InputJsonValue,
      },
    });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'api_credential.test',
        target_kind: 'api_credential',
        target_id: updated.id,
        before_json: maskSnapshot(row) as unknown as Prisma.InputJsonValue,
        after_json: maskSnapshot(updated) as unknown as Prisma.InputJsonValue,
      },
    });

    return ok(result);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.apiCredentials.errors.unknown);
  }
}
