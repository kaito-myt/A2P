/**
 * Model Assignment Server Action のコアロジック (T-02-11 / F-022・F-023).
 *
 * UI (S-019) から呼ばれる `upsertModelAssignment` / `revertModelAssignment` の
 * 業務ロジック。SA ラッパ (`app/actions/model-assignments.ts`) からは prisma /
 * session / 現在時刻を DI として渡し、Vitest からは mock で純粋にテスト可能にする
 * (model-catalog-core.ts と同パターン)。
 *
 * 切替フロー (docs/05 §4.3.9 / docs/02 F-022・F-023):
 *   1. 同 (role, genre) で active な行を 1 件取得 (= before)
 *   2. before があれば status='archived', archived_at=now()
 *   3. 新行を status='active', activated_at=now(), created_by=session.user.id で INSERT
 *   4. audit_log に before/after を残す
 *   5. 進行中ジョブは旧モデルのまま (book_id 単位の model_assignment_snapshot 列で
 *      Book 作成時に固定されているため、本 SA は影響しない)
 *
 * Revert (履歴復元):
 *   1. id 指定の行を fetch — status='archived' でなければ ValidationError
 *   2. 同 (role, genre) の現 active を archived 化
 *   3. 指定行を active に戻す (status='active', activated_at=now(), archived_at=null)
 *   4. audit_log に from/to を残す
 *
 * 直列 2 段 update + 1 INSERT は 1 トランザクションで実行する。SA 側は
 * `prisma.$transaction` で tx クライアントを生成して deps.modelAssignmentRepo /
 * deps.auditLogRepo に注入することで、core 側はトランザクション境界を意識しない。
 */
import { z } from 'zod';

import {
  NotFoundError,
  ValidationError,
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import { Prisma, type ModelAssignment, type ModelCatalog } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schemas — docs/05 §4.3.9 完全準拠
// ---------------------------------------------------------------------------

export const ROLES = [
  'marketer',
  'writer',
  'editor',
  'judge',
  'thumbnail_text',
  'thumbnail_image',
  'optimizer',
] as const;

export const GENRES = ['practical', 'business', 'self_help'] as const;

export const PROVIDERS = ['anthropic', 'openai', 'google'] as const;

export const upsertModelAssignmentInput = z.object({
  role: z.enum(ROLES),
  // null は「全ジャンル既定」。z.nullable() で許容する。
  genre: z.enum(GENRES).nullable(),
  provider: z.enum(PROVIDERS),
  model: z.string().min(1).max(128),
});

export type UpsertModelAssignmentInput = z.infer<typeof upsertModelAssignmentInput>;

export const revertModelAssignmentInput = z.object({
  id: z.string().min(1),
});

export type RevertModelAssignmentInput = z.infer<typeof revertModelAssignmentInput>;

// ---------------------------------------------------------------------------
// DI 境界
// ---------------------------------------------------------------------------

/** prisma.modelAssignment の最小サブセット。 */
export interface ModelAssignmentRepo {
  findFirst(args: {
    where: { role: string; genre: string | null; status: string };
  }): Promise<ModelAssignment | null>;
  findUnique(args: { where: { id: string } }): Promise<ModelAssignment | null>;
  create(args: {
    data: Prisma.ModelAssignmentUncheckedCreateInput;
  }): Promise<ModelAssignment>;
  update(args: {
    where: { id: string };
    data: Prisma.ModelAssignmentUncheckedUpdateInput;
  }): Promise<ModelAssignment>;
}

/** prisma.modelCatalog の最小サブセット — provider/model 妥当性チェック用。 */
export interface ModelCatalogReadRepo {
  findFirst(args: {
    where: { provider: string; model: string; is_current: boolean };
  }): Promise<ModelCatalog | null>;
}

/** prisma.auditLog.create の最小サブセット。 */
export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

/**
 * トランザクション境界。SA ラッパは `prisma.$transaction(async (tx) => fn({
 * modelAssignmentRepo: tx.modelAssignment, auditLogRepo: tx.auditLog }))` で
 * tx クライアントを注入する。テストでは即時実行 (in-memory state) でよい。
 */
export type RunTransactionFn = <T>(
  fn: (txRepos: {
    modelAssignmentRepo: ModelAssignmentRepo;
    auditLogRepo: AuditLogRepo;
  }) => Promise<T>,
) => Promise<T>;

export interface ModelAssignmentsDeps {
  modelAssignmentRepo: ModelAssignmentRepo;
  modelCatalogRepo: ModelCatalogReadRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  runTransaction: RunTransactionFn;
  now?: () => Date;
}

interface ResolvedDeps {
  modelAssignmentRepo: ModelAssignmentRepo;
  modelCatalogRepo: ModelCatalogReadRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  runTransaction: RunTransactionFn;
  now: () => Date;
}

function resolveDeps(d: ModelAssignmentsDeps): ResolvedDeps {
  return {
    modelAssignmentRepo: d.modelAssignmentRepo,
    modelCatalogRepo: d.modelCatalogRepo,
    auditLogRepo: d.auditLogRepo,
    session: d.session,
    runTransaction: d.runTransaction,
    now: d.now ?? (() => new Date()),
  };
}

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

/** audit_log 用 snapshot (Date は ISO 化)。 */
function snapshot(a: ModelAssignment | null): Record<string, unknown> | null {
  if (!a) return null;
  return {
    id: a.id,
    role: a.role,
    genre: a.genre,
    provider: a.provider,
    model: a.model,
    status: a.status,
    activated_at: a.activated_at instanceof Date ? a.activated_at.toISOString() : a.activated_at,
    archived_at:
      a.archived_at instanceof Date ? a.archived_at.toISOString() : a.archived_at,
    created_by: a.created_by,
  };
}

/** target_id 等で使う key string. */
function targetKey(role: string, genre: string | null): string {
  return `${role}/${genre ?? 'default'}`;
}

// ---------------------------------------------------------------------------
// upsertModelAssignment
// ---------------------------------------------------------------------------

export async function upsertModelAssignmentCore(
  raw: unknown,
  rawDeps: ModelAssignmentsDeps,
): Promise<ActionResult<{ id: string }>> {
  const deps = resolveDeps(rawDeps);
  const parsed = upsertModelAssignmentInput.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.modelAssignments.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;

    // ModelCatalog にこの (provider, model) が存在することを事前に検証する。
    // タイポや旧モデル名指定で runtime 失敗するのを防ぐ運用安全策。
    const catalogRow = await deps.modelCatalogRepo.findFirst({
      where: { provider: input.provider, model: input.model, is_current: true },
    });
    if (!catalogRow) {
      throw new ValidationError('model not in current catalog', {
        userMessage: messages.modelAssignments.errors.modelNotInCatalog,
        details: { provider: input.provider, model: input.model },
      });
    }

    const result = await deps.runTransaction(async (tx) => {
      const before = await tx.modelAssignmentRepo.findFirst({
        where: { role: input.role, genre: input.genre, status: 'active' },
      });

      // 同一 provider/model なら何もしない。UI 側のうっかり保存を防ぐ。
      if (before && before.provider === input.provider && before.model === input.model) {
        throw new ValidationError('assignment unchanged', {
          userMessage: messages.modelAssignments.errors.noChange,
        });
      }

      const now = deps.now();

      if (before) {
        await tx.modelAssignmentRepo.update({
          where: { id: before.id },
          data: { status: 'archived', archived_at: now },
        });
      }

      const created = await tx.modelAssignmentRepo.create({
        data: {
          role: input.role,
          genre: input.genre,
          provider: input.provider,
          model: input.model,
          status: 'active',
          activated_at: now,
          created_by: deps.session.user.id,
        },
      });

      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'model_assignment.upsert',
          target_kind: 'model_assignment',
          target_id: targetKey(input.role, input.genre),
          before_json: (snapshot(before) ??
            Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
          after_json: snapshot(created) as unknown as Prisma.InputJsonValue,
        },
      });

      return created;
    });

    return ok({ id: result.id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.modelAssignments.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// revertModelAssignment
// ---------------------------------------------------------------------------

export async function revertModelAssignmentCore(
  raw: unknown,
  rawDeps: ModelAssignmentsDeps,
): Promise<ActionResult<{ id: string }>> {
  const deps = resolveDeps(rawDeps);
  const parsed = revertModelAssignmentInput.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.modelAssignments.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;

    const result = await deps.runTransaction(async (tx) => {
      const target = await tx.modelAssignmentRepo.findUnique({ where: { id: input.id } });
      if (!target) {
        throw new NotFoundError('ModelAssignment row not found', {
          userMessage: messages.modelAssignments.errors.notFound,
          details: { id: input.id },
        });
      }
      if (target.status !== 'archived') {
        throw new ValidationError('ModelAssignment row is not archived', {
          userMessage: messages.modelAssignments.errors.alreadyActive,
          details: { id: input.id, status: target.status },
        });
      }

      const now = deps.now();

      // 同 (role, genre) の現 active を archived 化 (存在する前提だが念のため optional)
      const currentActive = await tx.modelAssignmentRepo.findFirst({
        where: { role: target.role, genre: target.genre, status: 'active' },
      });
      if (currentActive) {
        await tx.modelAssignmentRepo.update({
          where: { id: currentActive.id },
          data: { status: 'archived', archived_at: now },
        });
      }

      const revived = await tx.modelAssignmentRepo.update({
        where: { id: target.id },
        data: { status: 'active', activated_at: now, archived_at: null },
      });

      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'model_assignment.revert',
          target_kind: 'model_assignment',
          target_id: targetKey(target.role, target.genre),
          before_json: (snapshot(currentActive) ??
            Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
          after_json: snapshot(revived) as unknown as Prisma.InputJsonValue,
        },
      });

      return revived;
    });

    return ok({ id: result.id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.modelAssignments.errors.unknown);
  }
}
