/**
 * KDP 自動入稿キュー登録/取消 コアロジック (F-041, docs/05 §4.3.16 の実運用差替版)。
 *
 * 設計判断 (locked): Amazon KDP は入稿の都度インタラクティブな 2FA 再認証を要求するため、
 * サーバサイドから直接入稿を実行することはできない。そのため本 SA は「入稿キュー」への
 * 登録/取消のみを担当し、実際の入稿操作はローカルのアシスト出版ツール
 * (`scripts/kdp-publish.mjs`、運営者が対話的にログインしながら実行) が
 * `Book.kdp_publish_queued=true` を対象として拾って行う。
 *
 * `app/actions/kdp-submit.ts` (SA ラッパ) から呼ばれる。依存は DI で受け取り Vitest 可能にする。
 * ブロック判定は `lib/kdp-checklist-view.ts` の `hasBlockingComments` 算出方針
 * (Book.has_blocking_comments の静的フラグではなく pending な must コメントを都度集計) に揃える。
 *
 * 仕様根拠: docs/02 F-041 / docs/05 §4.3.16 (SA シグネチャ) / packages/db/schema.prisma Book.kdp_publish_queued
 */
import { z } from 'zod';

import { isA2PError, fail, ok, type ActionResult } from '@a2p/contracts';
import { Prisma } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// 入力スキーマ
// ---------------------------------------------------------------------------

export const submitToKdpInputSchema = z.object({
  /** 対象の書籍 ID リスト (1〜20 件)。 */
  book_ids: z.array(z.string().min(1)).min(1).max(20),
});

export type SubmitToKdpInput = z.infer<typeof submitToKdpInputSchema>;

// unqueue は同じ形の入力を使う (別名でエクスポートし呼び出し側の意図を明確にする)。
export const unqueueFromKdpInputSchema = submitToKdpInputSchema;
export type UnqueueFromKdpInput = z.infer<typeof unqueueFromKdpInputSchema>;

// ---------------------------------------------------------------------------
// 出力型
// ---------------------------------------------------------------------------

export interface KdpQueuedItem {
  book_id: string;
}

export interface KdpBlockedItem {
  book_id: string;
  reason: string;
}

export interface SubmitToKdpOutput {
  queued: KdpQueuedItem[];
  blocked: KdpBlockedItem[];
}

export interface UnqueueFromKdpOutput {
  unqueued: KdpQueuedItem[];
}

// ---------------------------------------------------------------------------
// 入稿可能な Book.status (docs/02 F-041 — done か要確認のみ、失敗/取消/実行中は不可)
// ---------------------------------------------------------------------------

const SUBMITTABLE_STATUSES = ['done', 'needs_human_review'];

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface KdpSubmitBookRow {
  id: string;
  status: string;
  publish_status: string;
  kdpMetadata: { id: string } | null;
}

export interface KdpSubmitBookRepo {
  findMany(args: {
    where: { id: { in: string[] } };
    select: {
      id: true;
      status: true;
      publish_status: true;
      kdpMetadata: { select: { id: true } };
    };
  }): Promise<KdpSubmitBookRow[]>;

  updateMany(args: {
    where: { id: { in: string[] } };
    data: { kdp_publish_queued: boolean; kdp_publish_queued_at: Date | null };
  }): Promise<{ count: number }>;
}

export interface KdpSubmitRevisionCommentRepo {
  findMany(args: {
    where: { book_id: { in: string[] }; priority: 'must'; status: 'pending' };
    select: { book_id: true };
  }): Promise<Array<{ book_id: string }>>;
}

export interface KdpSubmitAuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export interface KdpSubmitDeps {
  bookRepo: KdpSubmitBookRepo;
  revisionCommentRepo: KdpSubmitRevisionCommentRepo;
  auditLogRepo: KdpSubmitAuditLogRepo;
  session: AuthenticatedSession;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// submitToKdp — キューに登録する
// ---------------------------------------------------------------------------

export async function submitToKdpCore(
  raw: unknown,
  deps: KdpSubmitDeps,
): Promise<ActionResult<SubmitToKdpOutput>> {
  const parsed = submitToKdpInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      'validation',
      messages.kdpSubmit.errors.validation,
      parsed.error.flatten().fieldErrors,
    );
  }
  const { book_ids } = parsed.data;
  const now = (deps.now ?? (() => new Date()))();

  try {
    const books = await deps.bookRepo.findMany({
      where: { id: { in: book_ids } },
      select: {
        id: true,
        status: true,
        publish_status: true,
        kdpMetadata: { select: { id: true } },
      },
    });
    const bookMap = new Map(books.map((b) => [b.id, b]));

    // ブロック状態は「未消化 (pending) の must コメントが存在するか」を都度算出する
    // (kdp-checklist-view.ts と同じ方針。Book.has_blocking_comments の静的フラグは使わない)。
    const blockingRows = await deps.revisionCommentRepo.findMany({
      where: { book_id: { in: book_ids }, priority: 'must', status: 'pending' },
      select: { book_id: true },
    });
    const blockingSet = new Set(blockingRows.map((r) => r.book_id));

    const queued: KdpQueuedItem[] = [];
    const blocked: KdpBlockedItem[] = [];

    for (const bookId of book_ids) {
      const book = bookMap.get(bookId);
      if (!book) {
        blocked.push({ book_id: bookId, reason: messages.kdpSubmit.blockedReasons.notFound });
        continue;
      }
      if (blockingSet.has(bookId)) {
        blocked.push({
          book_id: bookId,
          reason: messages.kdpSubmit.blockedReasons.hasBlockingComments,
        });
        continue;
      }
      if (book.publish_status === 'published') {
        blocked.push({
          book_id: bookId,
          reason: messages.kdpSubmit.blockedReasons.alreadyPublished,
        });
        continue;
      }
      if (!SUBMITTABLE_STATUSES.includes(book.status)) {
        blocked.push({
          book_id: bookId,
          reason: messages.kdpSubmit.blockedReasons.notSubmittableStatus,
        });
        continue;
      }
      if (!book.kdpMetadata) {
        blocked.push({
          book_id: bookId,
          reason: messages.kdpSubmit.blockedReasons.metadataMissing,
        });
        continue;
      }
      queued.push({ book_id: bookId });
    }

    if (queued.length > 0) {
      await deps.bookRepo.updateMany({
        where: { id: { in: queued.map((q) => q.book_id) } },
        data: { kdp_publish_queued: true, kdp_publish_queued_at: now },
      });
    }

    // 操作自体が意図的 (ボタン押下) なので、全滅時も含め常に記録する。
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'kdp.queue',
        target_kind: 'book',
        target_id: queued.length === 1 && blocked.length === 0 ? queued[0]!.book_id : 'bulk',
        after_json: {
          queued: queued.map((q) => q.book_id),
          blocked: blocked.map((b) => ({ book_id: b.book_id, reason: b.reason })),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ queued, blocked });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.kdpSubmit.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// unqueueFromKdp — キューから取り消す
// ---------------------------------------------------------------------------

export async function unqueueFromKdpCore(
  raw: unknown,
  deps: KdpSubmitDeps,
): Promise<ActionResult<UnqueueFromKdpOutput>> {
  const parsed = unqueueFromKdpInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      'validation',
      messages.kdpSubmit.errors.validation,
      parsed.error.flatten().fieldErrors,
    );
  }
  const { book_ids } = parsed.data;

  try {
    await deps.bookRepo.updateMany({
      where: { id: { in: book_ids } },
      data: { kdp_publish_queued: false, kdp_publish_queued_at: null },
    });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'kdp.unqueue',
        target_kind: 'book',
        target_id: book_ids.length === 1 ? book_ids[0]! : 'bulk',
        after_json: { book_ids } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ unqueued: book_ids.map((id) => ({ book_id: id })) });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.kdpSubmit.errors.unknown);
  }
}
