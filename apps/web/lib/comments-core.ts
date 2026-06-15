/**
 * Comments Server Action core logic (T-06-01, F-049).
 *
 * `app/actions/comments.ts` (SA wrapper) から呼ばれる業務ロジック。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする
 * (outlines-core / covers-core / jobs-core と同パターン)。
 *
 * 仕様根拠:
 *  - docs/05 §4.3.7 createComment / updateComment / deleteComment / bulkChangePriority SA
 *  - docs/02 F-049 受入基準: コメント CRUD + Book フラグ連動
 *  - SP-06 §4 T-06-01
 *
 * Book フラグ再計算ロジック:
 *   has_pending_comments = (pending コメント数 > 0)
 *   has_blocking_comments = (pending + must コメント数 > 0)
 */
import { z } from 'zod';

import {
  NotFoundError,
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import { Prisma } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schemas (docs/05 §4.3.7)
// ---------------------------------------------------------------------------

export const CreateCommentInputSchema = z.object({
  book_id: z.string().min(1),
  target_kind: z.enum(['chapter', 'outline', 'cover', 'cover_text', 'metadata', 'theme']),
  target_id: z.string().min(1),
  range: z.union([
    z.object({ paragraph_range: z.tuple([z.number().int(), z.number().int()]) }),
    z.object({ line_range: z.tuple([z.number().int(), z.number().int()]) }),
    z.object({ image_region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }) }),
    z.null(),
  ]).optional().default(null),
  body: z.string().min(1).max(2000),
  priority: z.enum(['must', 'should', 'may']),
});
export type CreateCommentInput = z.infer<typeof CreateCommentInputSchema>;

export const UpdateCommentInputSchema = z.object({
  comment_id: z.string().min(1),
  body: z.string().min(1).max(2000).optional(),
  priority: z.enum(['must', 'should', 'may']).optional(),
});
export type UpdateCommentInput = z.infer<typeof UpdateCommentInputSchema>;

export const DeleteCommentInputSchema = z.object({
  comment_id: z.string().min(1),
});
export type DeleteCommentInput = z.infer<typeof DeleteCommentInputSchema>;

export const BulkChangePriorityInputSchema = z.object({
  comment_ids: z.array(z.string().min(1)).min(1),
  priority: z.enum(['must', 'should', 'may']),
});
export type BulkChangePriorityInput = z.infer<typeof BulkChangePriorityInputSchema>;

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface CommentRow {
  id: string;
  book_id: string;
  status: string;
  priority: string;
}

export interface RevisionCommentRepo {
  create(args: {
    data: Prisma.RevisionCommentUncheckedCreateInput;
  }): Promise<{ id: string }>;
  findUnique(args: {
    where: { id: string };
    select: { id: true; book_id: true; status: true; priority: true };
  }): Promise<CommentRow | null>;
  findMany(args: {
    where: {
      id?: { in: string[] };
      book_id?: string;
      status?: string;
    };
    select: { id: true; book_id: true; status: true; priority: true };
  }): Promise<CommentRow[]>;
  update(args: {
    where: { id: string };
    data: { body?: string; priority?: string; status?: string };
  }): Promise<{ id: string }>;
  updateMany(args: {
    where: { id: { in: string[] } };
    data: { priority: string };
  }): Promise<{ count: number }>;
  count(args: {
    where: { book_id: string; status: string; priority?: string };
  }): Promise<number>;
}

export interface BookRepo {
  findUnique(args: {
    where: { id: string };
    select: { id: true };
  }): Promise<{ id: string } | null>;
  update(args: {
    where: { id: string };
    data: { has_pending_comments: boolean; has_blocking_comments: boolean };
  }): Promise<{ id: string }>;
}

export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export type RunTransactionFn = <T>(
  fn: (txRepos: {
    commentRepo: RevisionCommentRepo;
    bookRepo: BookRepo;
    auditLogRepo: AuditLogRepo;
  }) => Promise<T>,
) => Promise<T>;

export interface CommentsDeps {
  commentRepo: RevisionCommentRepo;
  bookRepo: BookRepo;
  auditLogRepo: AuditLogRepo;
  runTransaction: RunTransactionFn;
  session: AuthenticatedSession;
  now?: () => Date;
}

interface ResolvedDeps extends CommentsDeps {
  now: () => Date;
}

function resolveDeps(d: CommentsDeps): ResolvedDeps {
  return { ...d, now: d.now ?? (() => new Date()) };
}

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

// ---------------------------------------------------------------------------
// Book flag recalculation helper
// ---------------------------------------------------------------------------

async function recalcBookFlags(
  bookId: string,
  commentRepo: RevisionCommentRepo,
  bookRepo: BookRepo,
): Promise<void> {
  const pendingCount = await commentRepo.count({
    where: { book_id: bookId, status: 'pending' },
  });
  const mustPendingCount = await commentRepo.count({
    where: { book_id: bookId, status: 'pending', priority: 'must' },
  });
  await bookRepo.update({
    where: { id: bookId },
    data: {
      has_pending_comments: pendingCount > 0,
      has_blocking_comments: mustPendingCount > 0,
    },
  });
}

// ---------------------------------------------------------------------------
// createCommentCore
// ---------------------------------------------------------------------------

export interface CreateCommentResult {
  comment_id: string;
}

export async function createCommentCore(
  raw: unknown,
  rawDeps: CommentsDeps,
): Promise<ActionResult<CreateCommentResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = CreateCommentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.comments.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;

    const commentId = await deps.runTransaction(async (tx) => {
      // Verify book exists
      const book = await tx.bookRepo.findUnique({
        where: { id: input.book_id },
        select: { id: true },
      });
      if (!book) {
        throw new NotFoundError('Book not found', {
          userMessage: messages.comments.errors.bookNotFound,
          details: { book_id: input.book_id },
        });
      }

      // Insert comment
      const comment = await tx.commentRepo.create({
        data: {
          book_id: input.book_id,
          target_kind: input.target_kind,
          target_id: input.target_id,
          range_json: (input.range ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          body: input.body,
          priority: input.priority,
          status: 'pending',
          created_by: deps.session.user.id,
          created_at: deps.now(),
        },
      });

      // Update book flags directly (within tx, no need to recount for create)
      await tx.bookRepo.update({
        where: { id: input.book_id },
        data: {
          has_pending_comments: true,
          has_blocking_comments: input.priority === 'must' ? true : (
            (await tx.commentRepo.count({
              where: { book_id: input.book_id, status: 'pending', priority: 'must' },
            })) > 0
          ),
        },
      });

      // audit_log
      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'comment.create',
          target_kind: 'revision_comment',
          target_id: comment.id,
          before_json: Prisma.JsonNull as unknown as Prisma.InputJsonValue,
          after_json: {
            book_id: input.book_id,
            target_kind: input.target_kind,
            target_id: input.target_id,
            priority: input.priority,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return comment.id;
    });

    return ok({ comment_id: commentId });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.comments.errors.createUnknown);
  }
}

// ---------------------------------------------------------------------------
// updateCommentCore
// ---------------------------------------------------------------------------

export async function updateCommentCore(
  raw: unknown,
  rawDeps: CommentsDeps,
): Promise<ActionResult<void>> {
  const deps = resolveDeps(rawDeps);
  const parsed = UpdateCommentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.comments.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;

    await deps.runTransaction(async (tx) => {
      const existing = await tx.commentRepo.findUnique({
        where: { id: input.comment_id },
        select: { id: true, book_id: true, status: true, priority: true },
      });
      if (!existing) {
        throw new NotFoundError('Comment not found', {
          userMessage: messages.comments.errors.notFound,
          details: { comment_id: input.comment_id },
        });
      }

      const updateData: { body?: string; priority?: string } = {};
      if (input.body !== undefined) updateData.body = input.body;
      if (input.priority !== undefined) updateData.priority = input.priority;

      await tx.commentRepo.update({
        where: { id: input.comment_id },
        data: updateData,
      });

      // Recalc book flags if priority changed
      if (input.priority !== undefined && input.priority !== existing.priority) {
        await recalcBookFlags(existing.book_id, tx.commentRepo, tx.bookRepo);
      }

      // audit_log
      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'comment.update',
          target_kind: 'revision_comment',
          target_id: input.comment_id,
          before_json: {
            priority: existing.priority,
          } as unknown as Prisma.InputJsonValue,
          after_json: {
            ...updateData,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });

    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.comments.errors.updateUnknown);
  }
}

// ---------------------------------------------------------------------------
// deleteCommentCore
// ---------------------------------------------------------------------------

export async function deleteCommentCore(
  raw: unknown,
  rawDeps: CommentsDeps,
): Promise<ActionResult<void>> {
  const deps = resolveDeps(rawDeps);
  const parsed = DeleteCommentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.comments.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const { comment_id: commentId } = parsed.data;

    await deps.runTransaction(async (tx) => {
      const existing = await tx.commentRepo.findUnique({
        where: { id: commentId },
        select: { id: true, book_id: true, status: true, priority: true },
      });
      if (!existing) {
        throw new NotFoundError('Comment not found', {
          userMessage: messages.comments.errors.notFound,
          details: { comment_id: commentId },
        });
      }

      // Soft delete: set status to 'superseded'
      await tx.commentRepo.update({
        where: { id: commentId },
        data: { status: 'superseded' },
      });

      // Recalc book flags
      await recalcBookFlags(existing.book_id, tx.commentRepo, tx.bookRepo);

      // audit_log
      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'comment.delete',
          target_kind: 'revision_comment',
          target_id: commentId,
          before_json: {
            status: existing.status,
            priority: existing.priority,
          } as unknown as Prisma.InputJsonValue,
          after_json: {
            status: 'superseded',
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });

    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.comments.errors.deleteUnknown);
  }
}

// ---------------------------------------------------------------------------
// bulkChangePriorityCore
// ---------------------------------------------------------------------------

export interface BulkChangePriorityResult {
  updated: number;
}

export async function bulkChangePriorityCore(
  raw: unknown,
  rawDeps: CommentsDeps,
): Promise<ActionResult<BulkChangePriorityResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = BulkChangePriorityInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.comments.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;

    const result = await deps.runTransaction(async (tx) => {
      // Fetch affected comments to determine book_ids for flag recalc
      const comments = await tx.commentRepo.findMany({
        where: { id: { in: input.comment_ids }, status: 'pending' },
        select: { id: true, book_id: true, status: true, priority: true },
      });

      if (comments.length === 0) {
        throw new NotFoundError('No pending comments found', {
          userMessage: messages.comments.errors.notFound,
          details: { comment_ids: input.comment_ids },
        });
      }

      const pendingIds = comments.map((c) => c.id);

      // Bulk update priority
      const { count } = await tx.commentRepo.updateMany({
        where: { id: { in: pendingIds } },
        data: { priority: input.priority },
      });

      // Recalc book flags for each affected book
      const bookIds = new Set(comments.map((c) => c.book_id));
      for (const bookId of bookIds) {
        await recalcBookFlags(bookId, tx.commentRepo, tx.bookRepo);
      }

      // audit_log
      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'comment.bulk_change_priority',
          target_kind: 'revision_comment',
          target_id: 'bulk',
          before_json: {
            comment_ids: input.comment_ids,
            found_pending_ids: pendingIds,
          } as unknown as Prisma.InputJsonValue,
          after_json: {
            priority: input.priority,
            updated: count,
            book_ids: Array.from(bookIds),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return { updated: count };
    });

    return ok(result);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.comments.errors.bulkChangePriorityUnknown);
  }
}
