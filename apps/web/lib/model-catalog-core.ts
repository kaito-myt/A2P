/**
 * Model Catalog Server Action のコアロジック (T-02-10, F-024/F-025)。
 *
 * `app/actions/model-catalog.ts` (SA ラッパ) から呼ばれる業務ロジック。
 * 依存 (graphile enqueue / prisma / session / now) は全て DI で受け取り、
 * Vitest で純粋にユニットテスト可能にする (api-credentials-core.ts と同パターン)。
 *
 * 仕様根拠: docs/05 §4.3.10 (zod schema), docs/04 S-020 (UI ハンドオフ),
 *           docs/02 F-024/F-025 (受入条件).
 *
 * `editCatalogEntry` の入力は docs/05 §4.3.10 に従い provider+model 複合キー。
 * `is_current=true` の現行行を更新し、source を `manual_edit_v1` に書き換える。
 */
import { z } from 'zod';

import {
  NotFoundError,
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import { Prisma, type ModelCatalog } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schemas — docs/05 §4.3.10 完全準拠
// ---------------------------------------------------------------------------

export const editCatalogEntryInput = z.object({
  provider: z.string().min(1).max(32),
  model: z.string().min(1).max(128),
  input_price_per_mtok_usd: z.number().nonnegative().optional(),
  output_price_per_mtok_usd: z.number().nonnegative().optional(),
  image_price_per_image_usd: z.number().nonnegative().optional(),
});

export type EditCatalogEntryInput = z.infer<typeof editCatalogEntryInput>;

export const refreshModelCatalogInput = z
  .object({
    trigger: z.literal('manual').optional(),
  })
  .optional();

// ---------------------------------------------------------------------------
// DI 境界
// ---------------------------------------------------------------------------

/** prisma.modelCatalog の最小サブセット。 */
export interface ModelCatalogRepo {
  findFirst(args: {
    where: { provider: string; model: string; is_current: boolean };
  }): Promise<ModelCatalog | null>;
  update(args: {
    where: { id: string };
    data: Prisma.ModelCatalogUncheckedUpdateInput;
  }): Promise<ModelCatalog>;
}

/** prisma.auditLog.create の最小サブセット。 */
export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

/** graphile-worker enqueue 関数。本番では `enqueueJob` を注入。 */
export type EnqueueJobFn = (taskName: string, payload: unknown) => Promise<string>;

export interface ModelCatalogDeps {
  modelCatalogRepo: ModelCatalogRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  enqueueJob: EnqueueJobFn;
  now?: () => Date;
}

interface ResolvedDeps {
  modelCatalogRepo: ModelCatalogRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  enqueueJob: EnqueueJobFn;
  now: () => Date;
}

function resolveDeps(d: ModelCatalogDeps): ResolvedDeps {
  return {
    modelCatalogRepo: d.modelCatalogRepo,
    auditLogRepo: d.auditLogRepo,
    session: d.session,
    enqueueJob: d.enqueueJob,
    now: d.now ?? (() => new Date()),
  };
}

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

/** audit_log 用 snapshot (Decimal は文字列化、Date は ISO 化)。 */
function snapshot(c: ModelCatalog | null): Record<string, unknown> | null {
  if (!c) return null;
  return {
    id: c.id,
    provider: c.provider,
    model: c.model,
    input_price_per_mtok_usd: c.input_price_per_mtok_usd.toString(),
    output_price_per_mtok_usd: c.output_price_per_mtok_usd.toString(),
    image_price_per_image_usd:
      c.image_price_per_image_usd != null ? c.image_price_per_image_usd.toString() : null,
    fx_rate_usd_jpy: c.fx_rate_usd_jpy.toString(),
    source: c.source,
    fetched_at: c.fetched_at instanceof Date ? c.fetched_at.toISOString() : c.fetched_at,
    is_current: c.is_current,
  };
}

// ---------------------------------------------------------------------------
// refreshModelCatalog
// ---------------------------------------------------------------------------

export async function refreshModelCatalogCore(
  raw: unknown,
  rawDeps: ModelCatalogDeps,
): Promise<ActionResult<{ job_id: string }>> {
  const deps = resolveDeps(rawDeps);
  const parsed = refreshModelCatalogInput.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.modelCatalog.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const jobId = await deps.enqueueJob('catalog.fetch', { trigger: 'manual' });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'model_catalog.refresh',
        target_kind: 'model_catalog',
        target_id: jobId,
        before_json: Prisma.JsonNull,
        after_json: { trigger: 'manual', job_id: jobId } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ job_id: jobId });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.modelCatalog.errors.enqueueFailed);
  }
}

// ---------------------------------------------------------------------------
// editCatalogEntry
// ---------------------------------------------------------------------------

const MANUAL_EDIT_SOURCE = 'manual_edit_v1';

export async function editCatalogEntryCore(
  raw: unknown,
  rawDeps: ModelCatalogDeps,
): Promise<ActionResult<{ id: string }>> {
  const deps = resolveDeps(rawDeps);
  const parsed = editCatalogEntryInput.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.modelCatalog.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;
    const before = await deps.modelCatalogRepo.findFirst({
      where: { provider: input.provider, model: input.model, is_current: true },
    });
    if (!before) {
      throw new NotFoundError('ModelCatalog row not found', {
        userMessage: messages.modelCatalog.errors.notFound,
      });
    }

    const data: Prisma.ModelCatalogUncheckedUpdateInput = {
      source: MANUAL_EDIT_SOURCE,
      fetched_at: deps.now(),
    };
    if (input.input_price_per_mtok_usd !== undefined) {
      data.input_price_per_mtok_usd = new Prisma.Decimal(input.input_price_per_mtok_usd);
    }
    if (input.output_price_per_mtok_usd !== undefined) {
      data.output_price_per_mtok_usd = new Prisma.Decimal(input.output_price_per_mtok_usd);
    }
    if (input.image_price_per_image_usd !== undefined) {
      data.image_price_per_image_usd = new Prisma.Decimal(input.image_price_per_image_usd);
    }

    const after = await deps.modelCatalogRepo.update({
      where: { id: before.id },
      data,
    });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'model_catalog.edit',
        target_kind: 'model_catalog',
        target_id: before.id,
        before_json: snapshot(before) as unknown as Prisma.InputJsonValue,
        after_json: snapshot(after) as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ id: after.id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.modelCatalog.errors.unknown);
  }
}
