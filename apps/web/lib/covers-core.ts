/**
 * Covers Server Action core logic (T-05-09, F-019).
 *
 * `app/actions/covers.ts` (SA wrapper) から呼ばれる業務ロジック。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする
 * (outlines-core / jobs-core と同パターン)。
 *
 * 仕様根拠:
 *  - docs/05 §4.3.6 bulkAdoptCovers / regenerateCover / regenerateCoverText SA
 *  - docs/02 F-019 受入基準: バルク採用 / 再生成
 *  - SP-05 §4 T-05-09
 *
 * フロー (bulkAdoptCovers):
 *   1. 入力 zod 検証 (cover_ids: 1..100)
 *   2. tx:
 *     a. Cover を id IN + status='generated' で fetch
 *     b. (per-row) Cover.status='adopted' に更新
 *     c. 同一 book_id の他 Cover を status='rejected' に updateMany
 *     d. (per-book) Job(kind='pipeline.book.export') INSERT
 *     e. audit_log 1 件
 *   3. tx 外: 各 Job について enqueueJob('pipeline.book.export', ...)
 *
 * フロー (regenerateCover):
 *   1. 入力 zod 検証 (book_id, count?, style_tweak?)
 *   2. Job(kind='pipeline.book.thumbnail.image') INSERT + enqueue
 *   3. audit_log 1 件
 *
 * フロー (regenerateCoverText):
 *   1. 入力 zod 検証 (book_id)
 *   2. Job(kind='pipeline.book.thumbnail.text') INSERT + enqueue
 *   3. audit_log 1 件
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
import { Prisma } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// タスク名定数
// ---------------------------------------------------------------------------

export const PIPELINE_BOOK_EXPORT_TASK_NAME = 'pipeline.book.export';
export const PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME = 'pipeline.book.thumbnail.image';
export const PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME = 'pipeline.book.thumbnail.text';

// ---------------------------------------------------------------------------
// zod schemas (docs/05 §4.3.6)
// ---------------------------------------------------------------------------

export const BulkAdoptCoversInputSchema = z.object({
  cover_ids: z.array(z.string().min(1)).min(1).max(100),
});
export type BulkAdoptCoversInput = z.infer<typeof BulkAdoptCoversInputSchema>;

export const RegenerateCoverInputSchema = z.object({
  book_id: z.string().min(1),
  count: z.number().int().min(1).max(5).default(3),
  style_tweak: z.string().optional(),
});
export type RegenerateCoverInput = z.infer<typeof RegenerateCoverInputSchema>;

export const RegenerateCoverTextInputSchema = z.object({
  book_id: z.string().min(1),
});
export type RegenerateCoverTextInput = z.infer<typeof RegenerateCoverTextInputSchema>;

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface CoverRow {
  id: string;
  book_id: string;
  status: string;
}

export interface CoverRepo {
  findMany(args: {
    where: {
      id?: { in: string[] };
      book_id?: string;
      status?: string;
    };
    select: {
      id: true;
      book_id: true;
      status: true;
    };
  }): Promise<CoverRow[]>;
  update(args: {
    where: { id: string };
    data: { status: string };
  }): Promise<{ id: string }>;
  updateMany(args: {
    where: {
      book_id: string;
      id: { notIn: string[] };
      status?: { not: string };
    };
    data: { status: string };
  }): Promise<{ count: number }>;
}

export interface BookRepo {
  findUnique(args: {
    where: { id: string };
    select: { id: true };
  }): Promise<{ id: string } | null>;
}

export interface JobRepo {
  create(args: {
    data: Prisma.JobUncheckedCreateInput;
  }): Promise<{ id: string }>;
}

export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export type EnqueueJobFn = (
  taskName: string,
  payload: unknown,
) => Promise<string>;

export type RunTransactionFn = <T>(
  fn: (txRepos: {
    coverRepo: CoverRepo;
    jobRepo: JobRepo;
    auditLogRepo: AuditLogRepo;
  }) => Promise<T>,
) => Promise<T>;

export interface CoversDeps {
  coverRepo: CoverRepo;
  bookRepo: BookRepo;
  jobRepo: JobRepo;
  auditLogRepo: AuditLogRepo;
  runTransaction: RunTransactionFn;
  session: AuthenticatedSession;
  enqueueJob: EnqueueJobFn;
  now?: () => Date;
}

interface ResolvedDeps extends CoversDeps {
  now: () => Date;
}

function resolveDeps(d: CoversDeps): ResolvedDeps {
  return { ...d, now: d.now ?? (() => new Date()) };
}

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface BulkAdoptCoversResult {
  adopted: number;
  /** book_ids for which export was enqueued. */
  enqueued_book_ids: string[];
  /** per-row failures. */
  failed_items: Array<{
    cover_id: string;
    reason: 'not_found' | 'status_not_generated' | 'enqueue_failed';
    message: string;
  }>;
}

export interface RegenerateCoverResult {
  job_id: string;
}

export interface RegenerateCoverTextResult {
  job_id: string;
}

// ---------------------------------------------------------------------------
// bulkAdoptCoversCore
// ---------------------------------------------------------------------------

export async function bulkAdoptCoversCore(
  raw: unknown,
  rawDeps: CoversDeps,
): Promise<ActionResult<BulkAdoptCoversResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = BulkAdoptCoversInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.covers.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const requestedIds = parsed.data.cover_ids;

    const txResult = await deps.runTransaction(async (tx) => {
      // 1. Fetch eligible covers (status='generated')
      const eligible = await tx.coverRepo.findMany({
        where: { id: { in: requestedIds }, status: 'generated' },
        select: { id: true, book_id: true, status: true },
      });

      if (eligible.length === 0) {
        throw new NotFoundError('no eligible covers for adoption', {
          userMessage: messages.covers.errors.noEligible,
          details: { requested: requestedIds.length },
        });
      }

      const eligibleIds = new Set(eligible.map((r) => r.id));
      const failedItems: BulkAdoptCoversResult['failed_items'] = [];

      for (const id of requestedIds) {
        if (!eligibleIds.has(id)) {
          failedItems.push({
            cover_id: id,
            reason: 'status_not_generated',
            message: messages.covers.errors.notGenerated,
          });
        }
      }

      // 2. Adopt each eligible cover + reject others in same book
      const bookIds = new Set<string>();
      const adoptedCoverIds: string[] = [];

      for (const row of eligible) {
        await tx.coverRepo.update({
          where: { id: row.id },
          data: { status: 'adopted' },
        });
        adoptedCoverIds.push(row.id);
        bookIds.add(row.book_id);
      }

      // 3. Reject other covers for each affected book
      for (const bookId of bookIds) {
        const adoptedInBook = eligible
          .filter((r) => r.book_id === bookId)
          .map((r) => r.id);
        await tx.coverRepo.updateMany({
          where: {
            book_id: bookId,
            id: { notIn: adoptedInBook },
            status: { not: 'rejected' },
          },
          data: { status: 'rejected' },
        });
      }

      // 4. Create export Job per book
      const createdJobs: Array<{ book_id: string; job_id: string; cover_ids: string[] }> = [];
      for (const bookId of bookIds) {
        const coverIdsForBook = eligible
          .filter((r) => r.book_id === bookId)
          .map((r) => r.id);
        const job = await tx.jobRepo.create({
          data: {
            kind: PIPELINE_BOOK_EXPORT_TASK_NAME,
            book_id: bookId,
            status: 'queued',
            payload_json: {
              book_id: bookId,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        createdJobs.push({ book_id: bookId, job_id: job.id, cover_ids: coverIdsForBook });
      }

      // 5. audit_log
      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'covers.bulk_adopt',
          target_kind: 'cover',
          target_id: 'bulk',
          before_json: {
            cover_ids: requestedIds,
            previous_status: 'generated',
          } as unknown as Prisma.InputJsonValue,
          after_json: {
            adopted_cover_ids: adoptedCoverIds,
            adopted_count: adoptedCoverIds.length,
            book_ids: Array.from(bookIds),
            failed_items: failedItems,
            jobs: createdJobs.map((j) => ({
              book_id: j.book_id,
              job_id: j.job_id,
              kind: PIPELINE_BOOK_EXPORT_TASK_NAME,
            })),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return { createdJobs, failedItems, adoptedCount: adoptedCoverIds.length };
    });

    // 6. tx 外で enqueue
    const enqueuedBookIds: string[] = [];
    const failedItems = [...txResult.failedItems];

    for (const j of txResult.createdJobs) {
      try {
        await deps.enqueueJob(PIPELINE_BOOK_EXPORT_TASK_NAME, {
          book_id: j.book_id,
          job_id: j.job_id,
        });
        enqueuedBookIds.push(j.book_id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : messages.covers.errors.enqueueFailed;
        for (const cid of j.cover_ids) {
          failedItems.push({
            cover_id: cid,
            reason: 'enqueue_failed',
            message: msg,
          });
        }
      }
    }

    return ok({
      adopted: txResult.adoptedCount,
      enqueued_book_ids: enqueuedBookIds,
      failed_items: failedItems,
    });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.covers.errors.bulkAdoptUnknown);
  }
}

// ---------------------------------------------------------------------------
// regenerateCoverCore
// ---------------------------------------------------------------------------

export async function regenerateCoverCore(
  raw: unknown,
  rawDeps: CoversDeps,
): Promise<ActionResult<RegenerateCoverResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = RegenerateCoverInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.covers.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const { book_id: bookId, count, style_tweak: styleTweak } = parsed.data;

    // Verify book exists
    const book = await deps.bookRepo.findUnique({
      where: { id: bookId },
      select: { id: true },
    });
    if (!book) {
      throw new NotFoundError('Book not found', {
        userMessage: messages.covers.errors.bookNotFound,
        details: { book_id: bookId },
      });
    }

    // Create Job + enqueue
    const job = await deps.jobRepo.create({
      data: {
        kind: PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
        book_id: bookId,
        status: 'queued',
        payload_json: {
          book_id: bookId,
          count,
          ...(styleTweak ? { style_tweak: styleTweak } : {}),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    try {
      await deps.enqueueJob(PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME, {
        book_id: bookId,
        job_id: job.id,
        count,
        ...(styleTweak ? { style_tweak: styleTweak } : {}),
      });
    } catch (err) {
      throw new ValidationError('enqueue failed', {
        userMessage: messages.covers.errors.enqueueFailed,
        cause: err,
      });
    }

    // audit_log
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'covers.regenerate_image',
        target_kind: 'book',
        target_id: bookId,
        before_json: {} as unknown as Prisma.InputJsonValue,
        after_json: {
          job_id: job.id,
          kind: PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
          count,
          style_tweak: styleTweak ?? null,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ job_id: job.id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.covers.errors.regenerateUnknown);
  }
}

// ---------------------------------------------------------------------------
// regenerateCoverTextCore
// ---------------------------------------------------------------------------

export async function regenerateCoverTextCore(
  raw: unknown,
  rawDeps: CoversDeps,
): Promise<ActionResult<RegenerateCoverTextResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = RegenerateCoverTextInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.covers.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const { book_id: bookId } = parsed.data;

    // Verify book exists
    const book = await deps.bookRepo.findUnique({
      where: { id: bookId },
      select: { id: true },
    });
    if (!book) {
      throw new NotFoundError('Book not found', {
        userMessage: messages.covers.errors.bookNotFound,
        details: { book_id: bookId },
      });
    }

    // Create Job + enqueue
    const job = await deps.jobRepo.create({
      data: {
        kind: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
        book_id: bookId,
        status: 'queued',
        payload_json: {
          book_id: bookId,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    try {
      await deps.enqueueJob(PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME, {
        book_id: bookId,
        job_id: job.id,
      });
    } catch (err) {
      throw new ValidationError('enqueue failed', {
        userMessage: messages.covers.errors.enqueueFailed,
        cause: err,
      });
    }

    // audit_log
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'covers.regenerate_text',
        target_kind: 'book',
        target_id: bookId,
        before_json: {} as unknown as Prisma.InputJsonValue,
        after_json: {
          job_id: job.id,
          kind: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ job_id: job.id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.covers.errors.regenerateTextUnknown);
  }
}
