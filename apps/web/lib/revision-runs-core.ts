/**
 * RevisionRun Server Action core logic (T-06-07, F-050).
 *
 * `app/actions/revision-runs.ts` (SA wrapper) から呼ばれる業務ロジック。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする
 * (outlines-core / comments-core / jobs-core と同パターン)。
 *
 * 仕様根拠:
 *  - docs/05 §4.3.8 createRevisionRun SA
 *  - docs/02 F-050 受入基準: 一括反映
 *  - SP-06 §4 T-06-07
 *
 * フロー (createRevisionRun):
 *   1. 入力 zod 検証 (comment_ids, scope, selected_book_ids)
 *   2. pending コメントを取得
 *   3. scope=all_pending_in_selected_books の場合、selected_book_ids の全 pending を追加取得
 *   4. book_ids 抽出 (unique)
 *   5. BookLock 検査: expires_at > now() のロックがある書籍は blocked_books に追加
 *   6. ブロック書籍のコメントを除外
 *   7. 推定コスト計算: コメント数 x 80 円、推定時間: コメント数 x 30 秒
 *   8. RevisionRun INSERT (status=queued)
 *   9. 対象コメントの run_id を設定
 *  10. 書籍ごとに revision.book.apply を enqueue
 *  11. audit_log 記録
 *  12. 戻り値: { run_id, blocked_books, estimated_cost_jpy, estimated_minutes }
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
// Task name constant (apps/worker side uses same value)
// ---------------------------------------------------------------------------

export const REVISION_BOOK_APPLY_TASK_NAME = 'revision.book.apply';

// ---------------------------------------------------------------------------
// Cost estimation constants (Phase 1 simplified)
// ---------------------------------------------------------------------------

/** Phase 1: fixed cost per comment (JPY). */
export const COST_PER_COMMENT_JPY = 80;

/** Phase 1: estimated seconds per comment. */
export const SECONDS_PER_COMMENT = 30;

// ---------------------------------------------------------------------------
// zod schemas (docs/05 §4.3.8)
// ---------------------------------------------------------------------------

export const CreateRevisionRunInputSchema = z.object({
  comment_ids: z.array(z.string().min(1)).min(1).max(500),
  scope: z.enum(['selected', 'all_pending_in_selected_books']).default('selected'),
  selected_book_ids: z.array(z.string().min(1)).optional(),
});
export type CreateRevisionRunInput = z.infer<typeof CreateRevisionRunInputSchema>;

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface CommentRow {
  id: string;
  book_id: string;
  status: string;
}

export interface CommentRepo {
  findMany(args: {
    where: {
      id?: { in: string[] };
      book_id?: { in: string[] };
      status?: string;
    };
    select: {
      id: true;
      book_id: true;
      status: true;
    };
  }): Promise<CommentRow[]>;
  updateMany(args: {
    where: { id: { in: string[] } };
    data: { run_id: string };
  }): Promise<{ count: number }>;
}

export interface BookLockRow {
  book_id: string;
  holder: string;
  expires_at: Date;
}

export interface BookLockRepo {
  findMany(args: {
    where: {
      book_id: { in: string[] };
      expires_at: { gt: Date };
    };
    select: {
      book_id: true;
      holder: true;
      expires_at: true;
    };
  }): Promise<BookLockRow[]>;
}

export interface RevisionRunRepo {
  create(args: {
    data: {
      triggered_by: string;
      status: string;
      book_ids_json: Prisma.InputJsonValue;
      comment_ids_json: Prisma.InputJsonValue;
      result_summary_json: Prisma.InputJsonValue;
    };
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
    commentRepo: CommentRepo;
    revisionRunRepo: RevisionRunRepo;
    auditLogRepo: AuditLogRepo;
  }) => Promise<T>,
) => Promise<T>;

export interface RevisionRunsDeps {
  commentRepo: CommentRepo;
  bookLockRepo: BookLockRepo;
  revisionRunRepo: RevisionRunRepo;
  auditLogRepo: AuditLogRepo;
  runTransaction: RunTransactionFn;
  session: AuthenticatedSession;
  enqueueJob: EnqueueJobFn;
  now?: () => Date;
}

interface ResolvedDeps extends RevisionRunsDeps {
  now: () => Date;
}

function resolveDeps(d: RevisionRunsDeps): ResolvedDeps {
  return { ...d, now: d.now ?? (() => new Date()) };
}

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface CreateRevisionRunResult {
  run_id: string;
  blocked_books: string[];
  estimated_cost_jpy: number;
  estimated_minutes: number;
}

// ---------------------------------------------------------------------------
// createRevisionRunCore
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// rollbackRevisionRun — zod schema & types (docs/05 §4.3.8)
// ---------------------------------------------------------------------------

export const RollbackRevisionRunInputSchema = z.object({
  revision_run_id: z.string().min(1),
  comment_ids: z.array(z.string().min(1)).optional(),
});
export type RollbackRevisionRunInput = z.infer<typeof RollbackRevisionRunInputSchema>;

export interface RollbackRevisionRunResult {
  restored: number;
}

// ---------------------------------------------------------------------------
// Rollback DI boundary
// ---------------------------------------------------------------------------

export interface RollbackCommentRow {
  id: string;
  book_id: string;
  target_kind: string;
  target_id: string;
  status: string;
  priority: string;
}

export interface RollbackCommentRepo {
  findMany(args: {
    where: {
      run_id: string;
      id?: { in: string[] };
      status: string;
    };
    select: {
      id: true;
      book_id: true;
      target_kind: true;
      target_id: true;
      status: true;
      priority: true;
    };
  }): Promise<RollbackCommentRow[]>;
  updateMany(args: {
    where: { id: { in: string[] } };
    data: { status: string; applied_at: null };
  }): Promise<{ count: number }>;
  count(args: {
    where: { book_id: string; status: string; priority?: string };
  }): Promise<number>;
}

export interface ChapterRevisionRow {
  id: string;
  chapter_id: string;
  version: number;
  body_md: string;
}

export interface ChapterRevisionRepo {
  findFirst(args: {
    where: { chapter_id: string; version: { lt: number } };
    orderBy: { version: 'desc' };
    select: { id: true; chapter_id: true; version: true; body_md: true };
  }): Promise<ChapterRevisionRow | null>;
  create(args: {
    data: {
      chapter_id: string;
      book_id: string;
      version: number;
      body_md: string;
      reason: string;
    };
  }): Promise<{ id: string }>;
}

export interface ChapterRow {
  id: string;
  book_id: string;
  version: number;
  body_md: string;
}

export interface ChapterRepo {
  findUnique(args: {
    where: { id: string };
    select: { id: true; book_id: true; version: true; body_md: true };
  }): Promise<ChapterRow | null>;
  update(args: {
    where: { id: string };
    data: { body_md: string; version: number; char_count: number };
  }): Promise<{ id: string }>;
}

export interface RollbackBookRepo {
  update(args: {
    where: { id: string };
    data: { has_pending_comments: boolean; has_blocking_comments: boolean };
  }): Promise<{ id: string }>;
}

export type RollbackRunTransactionFn = <T>(
  fn: (txRepos: {
    commentRepo: RollbackCommentRepo;
    chapterRevisionRepo: ChapterRevisionRepo;
    chapterRepo: ChapterRepo;
    bookRepo: RollbackBookRepo;
    auditLogRepo: AuditLogRepo;
  }) => Promise<T>,
) => Promise<T>;

export interface RollbackRevisionRunDeps {
  commentRepo: RollbackCommentRepo;
  chapterRevisionRepo: ChapterRevisionRepo;
  chapterRepo: ChapterRepo;
  bookRepo: RollbackBookRepo;
  auditLogRepo: AuditLogRepo;
  runTransaction: RollbackRunTransactionFn;
  session: AuthenticatedSession;
  now?: () => Date;
}

interface RollbackResolvedDeps extends RollbackRevisionRunDeps {
  now: () => Date;
}

function resolveRollbackDeps(d: RollbackRevisionRunDeps): RollbackResolvedDeps {
  return { ...d, now: d.now ?? (() => new Date()) };
}

// ---------------------------------------------------------------------------
// rollbackRevisionRunCore
// ---------------------------------------------------------------------------

export async function rollbackRevisionRunCore(
  raw: unknown,
  rawDeps: RollbackRevisionRunDeps,
): Promise<ActionResult<RollbackRevisionRunResult>> {
  const deps = resolveRollbackDeps(rawDeps);
  const parsed = RollbackRevisionRunInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.revisionRuns.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;

    // 1. Fetch applied comments for this run (not_applicable are not rollback targets)
    const whereClause: {
      run_id: string;
      id?: { in: string[] };
      status: string;
    } = {
      run_id: input.revision_run_id,
      status: 'applied',
    };
    if (input.comment_ids && input.comment_ids.length > 0) {
      whereClause.id = { in: input.comment_ids };
    }

    const appliedComments = await deps.commentRepo.findMany({
      where: whereClause,
      select: {
        id: true,
        book_id: true,
        target_kind: true,
        target_id: true,
        status: true,
        priority: true,
      },
    });

    if (appliedComments.length === 0) {
      throw new NotFoundError('no applied comments found for rollback', {
        userMessage: messages.revisionRuns.rollback.noAppliedComments,
        details: { revision_run_id: input.revision_run_id },
      });
    }

    // 2. Group by target_kind for processing
    const chapterComments = appliedComments.filter((c) => c.target_kind === 'chapter');
    const nonChapterComments = appliedComments.filter((c) => c.target_kind !== 'chapter');

    // 3. Transaction: rollback chapters + reset comments + recalc flags + audit
    const txResult = await deps.runTransaction(async (tx) => {
      let restoredCount = 0;

      // 3a. Chapter rollback: restore body_md from previous ChapterRevision
      const chapterTargetIds = [...new Set(chapterComments.map((c) => c.target_id))];
      for (const chapterId of chapterTargetIds) {
        const chapter = await tx.chapterRepo.findUnique({
          where: { id: chapterId },
          select: { id: true, book_id: true, version: true, body_md: true },
        });
        if (!chapter) continue;

        const previousRevision = await tx.chapterRevisionRepo.findFirst({
          where: { chapter_id: chapterId, version: { lt: chapter.version } },
          orderBy: { version: 'desc' },
          select: { id: true, chapter_id: true, version: true, body_md: true },
        });
        if (!previousRevision) continue;

        const newVersion = chapter.version + 1;

        // Save current state as revision before overwriting
        await tx.chapterRevisionRepo.create({
          data: {
            chapter_id: chapterId,
            book_id: chapter.book_id,
            version: chapter.version,
            body_md: chapter.body_md,
            reason: `rollback:${input.revision_run_id}`,
          },
        });

        // Restore chapter to previous revision's body
        await tx.chapterRepo.update({
          where: { id: chapterId },
          data: {
            body_md: previousRevision.body_md,
            version: newVersion,
            char_count: previousRevision.body_md.length,
          },
        });

        restoredCount++;
      }

      // 3b. Non-chapter kinds: Phase 1 placeholder (just reset comment status)
      // cover, cover_text, metadata, theme, outline
      // No data restoration needed in Phase 1

      // 3c. Reset all target comments to pending
      const allCommentIds = appliedComments.map((c) => c.id);
      await tx.commentRepo.updateMany({
        where: { id: { in: allCommentIds } },
        data: { status: 'pending', applied_at: null },
      });

      restoredCount += nonChapterComments.length;

      // 3d. Recalculate book flags for affected books
      const affectedBookIds = [...new Set(appliedComments.map((c) => c.book_id))];
      for (const bookId of affectedBookIds) {
        const pendingCount = await tx.commentRepo.count({
          where: { book_id: bookId, status: 'pending' },
        });
        const mustPendingCount = await tx.commentRepo.count({
          where: { book_id: bookId, status: 'pending', priority: 'must' },
        });
        await tx.bookRepo.update({
          where: { id: bookId },
          data: {
            has_pending_comments: pendingCount > 0,
            has_blocking_comments: mustPendingCount > 0,
          },
        });
      }

      // 3e. Audit log
      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'revision_run.rollback',
          target_kind: 'revision_run',
          target_id: input.revision_run_id,
          before_json: Prisma.JsonNull,
          after_json: {
            revision_run_id: input.revision_run_id,
            comment_ids: allCommentIds,
            chapter_ids_restored: chapterTargetIds,
            restored_count: restoredCount,
            partial: !!input.comment_ids,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return { restored: restoredCount };
    });

    return ok(txResult);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.revisionRuns.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// createRevisionRunCore
// ---------------------------------------------------------------------------

export async function createRevisionRunCore(
  raw: unknown,
  rawDeps: RevisionRunsDeps,
): Promise<ActionResult<CreateRevisionRunResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = CreateRevisionRunInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.revisionRuns.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;
    const now = deps.now();

    // 1. Fetch pending comments by specified IDs
    const specifiedComments = await deps.commentRepo.findMany({
      where: { id: { in: input.comment_ids }, status: 'pending' },
      select: { id: true, book_id: true, status: true },
    });

    if (specifiedComments.length === 0) {
      throw new NotFoundError('no pending comments found', {
        userMessage: messages.revisionRuns.errors.noEligible,
        details: { requested: input.comment_ids.length },
      });
    }

    // 2. If scope=all_pending_in_selected_books, get all pending for those books
    let allTargetComments = specifiedComments;

    if (input.scope === 'all_pending_in_selected_books') {
      const bookIds = input.selected_book_ids && input.selected_book_ids.length > 0
        ? input.selected_book_ids
        : [...new Set(specifiedComments.map((c) => c.book_id))];

      const allPendingInBooks = await deps.commentRepo.findMany({
        where: { book_id: { in: bookIds }, status: 'pending' },
        select: { id: true, book_id: true, status: true },
      });

      // Merge: use all pending comments from target books (dedup by ID)
      const seenIds = new Set<string>();
      const merged: CommentRow[] = [];
      for (const c of allPendingInBooks) {
        if (!seenIds.has(c.id)) {
          seenIds.add(c.id);
          merged.push(c);
        }
      }
      allTargetComments = merged;
    }

    // 3. Extract unique book_ids
    const allBookIds = [...new Set(allTargetComments.map((c) => c.book_id))];

    // 4. BookLock check: find active locks
    const activeLocks = await deps.bookLockRepo.findMany({
      where: {
        book_id: { in: allBookIds },
        expires_at: { gt: now },
      },
      select: { book_id: true, holder: true, expires_at: true },
    });

    const lockedBookIds = new Set(activeLocks.map((l) => l.book_id));
    const blockedBooks = [...lockedBookIds];

    // 5. Filter out comments for blocked books
    const eligibleComments = allTargetComments.filter(
      (c) => !lockedBookIds.has(c.book_id),
    );

    if (eligibleComments.length === 0) {
      throw new ValidationError('all target books are locked', {
        userMessage: messages.revisionRuns.errors.allBooksLocked,
        details: { blocked_books: blockedBooks },
      });
    }

    const eligibleBookIds = [...new Set(eligibleComments.map((c) => c.book_id))];
    const eligibleCommentIds = eligibleComments.map((c) => c.id);

    // 6. Estimate cost and time
    const estimatedCostJpy = eligibleComments.length * COST_PER_COMMENT_JPY;
    const estimatedMinutes = Math.max(
      1,
      Math.ceil((eligibleComments.length * SECONDS_PER_COMMENT) / 60),
    );

    // 7. Transaction: RevisionRun INSERT + comment run_id update + audit_log
    const txResult = await deps.runTransaction(async (tx) => {
      const run = await tx.revisionRunRepo.create({
        data: {
          triggered_by: deps.session.user.id,
          status: 'queued',
          book_ids_json: eligibleBookIds as unknown as Prisma.InputJsonValue,
          comment_ids_json: eligibleCommentIds as unknown as Prisma.InputJsonValue,
          result_summary_json: {
            applied: 0,
            not_applicable: 0,
            failed: 0,
            cost_jpy: 0,
            blocked_books: blockedBooks,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.commentRepo.updateMany({
        where: { id: { in: eligibleCommentIds } },
        data: { run_id: run.id },
      });

      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'revision_run.kick',
          target_kind: 'revision_run',
          target_id: run.id,
          before_json: Prisma.JsonNull,
          after_json: {
            run_id: run.id,
            comment_count: eligibleCommentIds.length,
            book_ids: eligibleBookIds,
            blocked_books: blockedBooks,
            estimated_cost_jpy: estimatedCostJpy,
            estimated_minutes: estimatedMinutes,
            scope: input.scope,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return { runId: run.id };
    });

    // 8. Enqueue revision.book.apply per book (outside tx)
    const commentsByBook = new Map<string, string[]>();
    for (const c of eligibleComments) {
      const existing = commentsByBook.get(c.book_id);
      if (existing) {
        existing.push(c.id);
      } else {
        commentsByBook.set(c.book_id, [c.id]);
      }
    }

    for (const [bookId, commentIds] of commentsByBook) {
      await deps.enqueueJob(REVISION_BOOK_APPLY_TASK_NAME, {
        revision_run_id: txResult.runId,
        book_id: bookId,
        comment_ids: commentIds,
      });
    }

    return ok({
      run_id: txResult.runId,
      blocked_books: blockedBooks,
      estimated_cost_jpy: estimatedCostJpy,
      estimated_minutes: estimatedMinutes,
    });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.revisionRuns.errors.unknown);
  }
}
