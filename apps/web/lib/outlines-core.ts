/**
 * Outlines Server Action のコアロジック (T-04-07, F-018).
 *
 * `app/actions/outlines.ts` (SA ラッパ) から呼ばれる業務ロジック。
 * 依存 (prisma / enqueueJob / session / now) は全て DI で受け取り Vitest で
 * 純粋にユニットテスト可能にする (themes-core / batches-core と同パターン)。
 *
 * 仕様根拠:
 *  - docs/05 §4.3.5 `bulkApproveOutlines` / `bulkRejectOutlines` SA
 *  - docs/05 §5.3.3〜5.3.4 / §16 ADR-001 (pg_notify チャネル 'jobs') / §13 #5 冪等性
 *  - docs/05 §11 シーケンス (Marketer→Writer→Outline 承認→Chapters dispatch)
 *  - docs/02 F-018 受入基準: バルク承認/差戻し
 *  - SP-04 §4 T-04-07: 承認時 dispatch enqueue / 差戻し時 reject_note 付き Writer 再 enqueue
 *
 * フロー (bulkApproveOutlines):
 *   1. 入力 zod 検証 (outline_ids: 1..100)
 *   2. tx:
 *     a. Outline を id IN + status='pending_review' で fetch (book join, FK 整合確認)
 *     b. (per-row) Outline.status='approved' + approved_at=now() に更新
 *     c. (per-row) Book.status='running' に更新
 *     d. (per-row) Job(kind='pipeline.book.writer.chapters.dispatch', book_id, status='queued',
 *        payload_json={ book_id, job_id, outline_id }) を INSERT
 *     e. audit_log 1 件 (action='outlines.bulk_approve', target_id='bulk', after_json で詳細)
 *   3. tx 外: 各 Job について enqueueJob('pipeline.book.writer.chapters.dispatch', ...).
 *      enqueue 失敗は per-row error として収集し、successful_count / failed_items を返す
 *      (部分成功許容)。
 *
 * フロー (bulkRejectOutlines):
 *   1. 入力 zod 検証 (items[].outline_id + reject_note 必須, 1..100)
 *   2. tx:
 *     a. Outline を id IN + status='pending_review' で fetch
 *     b. (per-row) Outline.status='rejected' + reject_note 設定
 *     c. (per-row) Job(kind='pipeline.book.writer.outline', book_id, status='queued',
 *        payload_json={ book_id, job_id, reject_note }) を INSERT
 *     d. audit_log 1 件 (action='outlines.bulk_reject')
 *   3. tx 外: enqueueJob('pipeline.book.writer.outline', ...) per row, per-row error 収集.
 *
 * Hard Rule #3 (schema 整合性):
 *   - Outline schema (packages/db/schema.prisma) には `rejected_at` 列が存在しない。
 *     差戻しは `reject_note` の保存のみ (decided_at 相当は updated_at に任せる)。
 *     タスク指示中の「rejectedAt」は schema 不整合のため採用しない (docs/05 §3 準拠)。
 *   - Book.status は SP-04 §4 T-04-07 で「running」と明記。schema enum
 *     (queued|running|editing|judging|thumbnail|exporting|done|...) に存在する値。
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
import { Prisma, type Job, type Outline } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// タスク名定数 (apps/worker 側と同値、循環依存を避けるためここで再定義)
// ---------------------------------------------------------------------------

/** docs/05 §5.3.4 / SP-04 T-04-05: 章 N 件を p-limit 並列 enqueue する親タスク。 */
export const PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME =
  'pipeline.book.writer.chapters.dispatch';

/** docs/05 §5.3.3: 差戻し時に reject_note を渡して Outline を再生成。 */
export const PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME = 'pipeline.book.writer.outline';

// ---------------------------------------------------------------------------
// zod schemas (docs/05 §4.3.5)
// ---------------------------------------------------------------------------

/** docs/05 §4.3.5: `{ outline_ids: z.array(z.string()).min(1) }`. */
export const BulkApproveOutlinesInputSchema = z.object({
  outline_ids: z.array(z.string().min(1)).min(1).max(100),
});
export type BulkApproveOutlinesInput = z.infer<typeof BulkApproveOutlinesInputSchema>;

/**
 * docs/05 §4.3.5: `items: [{ outline_id, reject_note }]`.
 * reject_note 必須 (min(1)) — UI BulkRejectModal でコメント入力を強制 (SP-04 T-04-08)。
 */
export const BulkRejectOutlinesInputSchema = z.object({
  items: z
    .array(
      z.object({
        outline_id: z.string().min(1),
        reject_note: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(100),
});
export type BulkRejectOutlinesInput = z.infer<typeof BulkRejectOutlinesInputSchema>;

// ---------------------------------------------------------------------------
// DI 境界
// ---------------------------------------------------------------------------

/** prisma.outline の最小サブセット。 */
export interface OutlineRepo {
  findMany(args: {
    where: {
      id: { in: string[] };
      status?: string;
    };
    select: {
      id: true;
      book_id: true;
      status: true;
    };
  }): Promise<Array<Pick<Outline, 'id' | 'book_id' | 'status'>>>;
  update(args: {
    where: { id: string };
    data: {
      status?: string;
      approved_at?: Date | null;
      reject_note?: string | null;
    };
  }): Promise<Pick<Outline, 'id'>>;
}

/** prisma.book の最小サブセット (status 遷移用)。 */
export interface BookRepo {
  update(args: {
    where: { id: string };
    data: { status: string };
  }): Promise<{ id: string }>;
}

/** prisma.job の最小サブセット。 */
export interface JobRepo {
  create(args: {
    data: Prisma.JobUncheckedCreateInput;
  }): Promise<Pick<Job, 'id'>>;
}

/** prisma.auditLog の最小サブセット。 */
export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

/** graphile-worker enqueue 関数。 */
export type EnqueueJobFn = (
  taskName: string,
  payload: unknown,
) => Promise<string>;

/** tx 境界。SA ラッパは `prisma.$transaction` で tx クライアントから組み立てる。 */
export type RunTransactionFn = <T>(
  fn: (txRepos: {
    outlineRepo: OutlineRepo;
    bookRepo: BookRepo;
    jobRepo: JobRepo;
    auditLogRepo: AuditLogRepo;
  }) => Promise<T>,
) => Promise<T>;

export interface OutlinesDeps {
  outlineRepo: OutlineRepo;
  bookRepo: BookRepo;
  jobRepo: JobRepo;
  auditLogRepo: AuditLogRepo;
  runTransaction: RunTransactionFn;
  session: AuthenticatedSession;
  enqueueJob: EnqueueJobFn;
  now?: () => Date;
}

interface ResolvedDeps extends OutlinesDeps {
  now: () => Date;
}

function resolveDeps(d: OutlinesDeps): ResolvedDeps {
  return { ...d, now: d.now ?? (() => new Date()) };
}

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

// ---------------------------------------------------------------------------
// 結果型 (per-row エラー収集)
// ---------------------------------------------------------------------------

export interface BulkApproveOutlinesResult {
  approved: number;
  /** enqueue まで成功した outline_ids. */
  enqueued_outline_ids: string[];
  /** per-row 失敗 (status 不一致 or enqueue 失敗). UI で再試行ヒントを出す. */
  failed_items: Array<{
    outline_id: string;
    reason:
      | 'not_found'
      | 'status_not_pending_review'
      | 'enqueue_failed';
    message: string;
  }>;
}

export interface BulkRejectOutlinesResult {
  rejected: number;
  enqueued_outline_ids: string[];
  failed_items: Array<{
    outline_id: string;
    reason:
      | 'not_found'
      | 'status_not_pending_review'
      | 'enqueue_failed';
    message: string;
  }>;
}

// ---------------------------------------------------------------------------
// bulkApproveOutlinesCore
// ---------------------------------------------------------------------------

export async function bulkApproveOutlinesCore(
  raw: unknown,
  rawDeps: OutlinesDeps,
): Promise<ActionResult<BulkApproveOutlinesResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = BulkApproveOutlinesInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.outlines.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;
    const requestedIds = input.outline_ids;
    const now = deps.now();

    // tx 内で fetch → 状態遷移 → Job INSERT → audit。enqueue は tx 外で行う
    // (DB トランザクション中の外部 I/O 回避、enqueueJob 失敗時も DB 状態は確定する。
    //  enqueue 失敗は failed_items に収集して UI から retryJob (T-04-11) を案内する設計)。
    const txResult = await deps.runTransaction(async (tx) => {
      // 1. 対象を pending_review に絞って fetch
      const eligible = await tx.outlineRepo.findMany({
        where: { id: { in: requestedIds }, status: 'pending_review' },
        select: { id: true, book_id: true, status: true },
      });

      // 2. 全件未存在 / 全件状態不一致なら NotFound 扱い (DB は触らない)
      if (eligible.length === 0) {
        throw new NotFoundError('no eligible outlines for approval', {
          userMessage: messages.outlines.errors.noEligible,
          details: { requested: requestedIds.length },
        });
      }

      const eligibleIds = new Set(eligible.map((r) => r.id));
      const failedItems: BulkApproveOutlinesResult['failed_items'] = [];

      // 3. 要求 id のうち、eligible でないものを failed_items に記録
      //    (status_not_pending_review or not_found を区別するため一旦全 ids を fetch する手もあるが、
      //     コストを抑えるため pending_review に絞らず取得しないことで簡素化。UI 側はステータス再表示で対処)
      for (const id of requestedIds) {
        if (!eligibleIds.has(id)) {
          failedItems.push({
            outline_id: id,
            reason: 'status_not_pending_review',
            message: messages.outlines.errors.notPendingReview,
          });
        }
      }

      // 4. per-row state transition + Job INSERT
      const createdJobs: Array<{
        outline_id: string;
        book_id: string;
        job_id: string;
      }> = [];

      for (const row of eligible) {
        await tx.outlineRepo.update({
          where: { id: row.id },
          data: { status: 'approved', approved_at: now },
        });
        await tx.bookRepo.update({
          where: { id: row.book_id },
          data: { status: 'running' },
        });
        const job = await tx.jobRepo.create({
          data: {
            kind: PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
            book_id: row.book_id,
            status: 'queued',
            payload_json: {
              book_id: row.book_id,
              outline_id: row.id,
              // job_id は INSERT 後に自身の id で埋める設計だが、create で id を取得した後の
              // payload_json 後追い update を避けるため、enqueue 直前に payload を再構築する
              // (createdJobs に job_id を控え、tx 外で payload を組み立てる)。
            } as unknown as Prisma.InputJsonValue,
          },
        });
        createdJobs.push({
          outline_id: row.id,
          book_id: row.book_id,
          job_id: job.id,
        });
      }

      // 5. audit_log (1 件、bulk)
      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'outlines.bulk_approve',
          target_kind: 'outline',
          target_id: 'bulk',
          before_json: {
            outline_ids: requestedIds,
            previous_status: 'pending_review',
          } as unknown as Prisma.InputJsonValue,
          after_json: {
            outline_ids: eligible.map((r) => r.id),
            approved_count: eligible.length,
            failed_items: failedItems,
            jobs: createdJobs.map((j) => ({
              outline_id: j.outline_id,
              book_id: j.book_id,
              job_id: j.job_id,
              kind: PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
            })),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return { createdJobs, failedItems };
    });

    // 6. tx 外で enqueue (per-row エラー収集)
    const enqueuedOutlineIds: string[] = [];
    const failedItems = [...txResult.failedItems];

    for (const j of txResult.createdJobs) {
      try {
        await deps.enqueueJob(PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME, {
          book_id: j.book_id,
          job_id: j.job_id,
          outline_id: j.outline_id,
        });
        enqueuedOutlineIds.push(j.outline_id);
      } catch (err) {
        failedItems.push({
          outline_id: j.outline_id,
          reason: 'enqueue_failed',
          message:
            err instanceof Error ? err.message : messages.outlines.errors.enqueueFailed,
        });
      }
    }

    return ok({
      approved: txResult.createdJobs.length,
      enqueued_outline_ids: enqueuedOutlineIds,
      failed_items: failedItems,
    });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.outlines.errors.bulkApproveUnknown);
  }
}

// ---------------------------------------------------------------------------
// bulkRejectOutlinesCore
// ---------------------------------------------------------------------------

export async function bulkRejectOutlinesCore(
  raw: unknown,
  rawDeps: OutlinesDeps,
): Promise<ActionResult<BulkRejectOutlinesResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = BulkRejectOutlinesInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.outlines.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;
    const requestedIds = input.items.map((i) => i.outline_id);
    const noteByOutlineId = new Map(
      input.items.map((i) => [i.outline_id, i.reject_note] as const),
    );

    // 重複 outline_id を弾く (1 outline = 1 reject_note の前提を SA で保証)
    if (noteByOutlineId.size !== input.items.length) {
      throw new ValidationError('duplicated outline_id in items', {
        userMessage: messages.outlines.errors.duplicatedItem,
        details: { count: input.items.length, unique: noteByOutlineId.size },
      });
    }

    const txResult = await deps.runTransaction(async (tx) => {
      const eligible = await tx.outlineRepo.findMany({
        where: { id: { in: requestedIds }, status: 'pending_review' },
        select: { id: true, book_id: true, status: true },
      });

      if (eligible.length === 0) {
        throw new NotFoundError('no eligible outlines for reject', {
          userMessage: messages.outlines.errors.noEligible,
          details: { requested: requestedIds.length },
        });
      }

      const eligibleIds = new Set(eligible.map((r) => r.id));
      const failedItems: BulkRejectOutlinesResult['failed_items'] = [];

      for (const id of requestedIds) {
        if (!eligibleIds.has(id)) {
          failedItems.push({
            outline_id: id,
            reason: 'status_not_pending_review',
            message: messages.outlines.errors.notPendingReview,
          });
        }
      }

      const createdJobs: Array<{
        outline_id: string;
        book_id: string;
        job_id: string;
        reject_note: string;
      }> = [];

      for (const row of eligible) {
        const note = noteByOutlineId.get(row.id);
        // map から取れない (= zod 検証後の不変条件違反) は内部不整合
        if (note === undefined) {
          throw new ValidationError('reject_note missing after validation', {
            userMessage: messages.outlines.errors.bulkRejectUnknown,
            details: { outline_id: row.id },
          });
        }
        await tx.outlineRepo.update({
          where: { id: row.id },
          data: { status: 'rejected', reject_note: note },
        });
        const job = await tx.jobRepo.create({
          data: {
            kind: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
            book_id: row.book_id,
            status: 'queued',
            payload_json: {
              book_id: row.book_id,
              reject_note: note,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        createdJobs.push({
          outline_id: row.id,
          book_id: row.book_id,
          job_id: job.id,
          reject_note: note,
        });
      }

      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'outlines.bulk_reject',
          target_kind: 'outline',
          target_id: 'bulk',
          before_json: {
            outline_ids: requestedIds,
            previous_status: 'pending_review',
          } as unknown as Prisma.InputJsonValue,
          after_json: {
            outline_ids: eligible.map((r) => r.id),
            rejected_count: eligible.length,
            failed_items: failedItems,
            jobs: createdJobs.map((j) => ({
              outline_id: j.outline_id,
              book_id: j.book_id,
              job_id: j.job_id,
              kind: PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
              // reject_note は監査用に hash 等の保護はせず素のまま (Phase 1 シングルユーザー前提)
              reject_note_length: j.reject_note.length,
            })),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return { createdJobs, failedItems };
    });

    const enqueuedOutlineIds: string[] = [];
    const failedItems = [...txResult.failedItems];

    for (const j of txResult.createdJobs) {
      try {
        await deps.enqueueJob(PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME, {
          book_id: j.book_id,
          job_id: j.job_id,
          reject_note: j.reject_note,
        });
        enqueuedOutlineIds.push(j.outline_id);
      } catch (err) {
        failedItems.push({
          outline_id: j.outline_id,
          reason: 'enqueue_failed',
          message:
            err instanceof Error ? err.message : messages.outlines.errors.enqueueFailed,
        });
      }
    }

    return ok({
      rejected: txResult.createdJobs.length,
      enqueued_outline_ids: enqueuedOutlineIds,
      failed_items: failedItems,
    });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.outlines.errors.bulkRejectUnknown);
  }
}
