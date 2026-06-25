'use server';

/**
 * Book Server Actions.
 *
 * - updateBookPublishStatus: 書籍ライブラリ上で Amazon KDP 出版ステータス
 *   (unlisted=未対応 / published=出版済み) を運営者が手動更新する。
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isA2PError, fail, ok, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';

const THUMBNAIL_TEXT_TASK = 'pipeline.book.thumbnail.text';

const UpdatePublishStatusSchema = z.object({
  book_id: z.string().min(1),
  publish_status: z.enum(['unlisted', 'submitted', 'published']),
});

export async function updateBookPublishStatus(
  input: unknown,
): Promise<ActionResult<{ book_id: string; publish_status: string }>> {
  let actorId: string;
  try {
    const session = await getSessionOrThrow();
    actorId = session.user.id;
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.books.publish.updateError);
  }

  const parsed = UpdatePublishStatusSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', messages.books.publish.updateError);
  }
  const { book_id, publish_status } = parsed.data;

  try {
    const existing = await prisma.book.findUnique({
      where: { id: book_id },
      select: { id: true, publish_status: true },
    });
    if (!existing) {
      return fail('not_found', messages.books.publish.updateError);
    }

    await prisma.book.update({
      where: { id: book_id },
      data: { publish_status },
    });

    await prisma.auditLog.create({
      data: {
        actor_id: actorId,
        action: 'book.publish_status.update',
        target_kind: 'book',
        target_id: book_id,
        before_json: { publish_status: existing.publish_status },
        after_json: { publish_status },
      },
    });

    revalidatePath('/books');
    revalidatePath(`/books/${book_id}`);
    return ok({ book_id, publish_status });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.books.publish.updateError);
  }
}

// ---------------------------------------------------------------------------
// 本文承認ゲート: content_review の書籍を承認し、サムネ生成 (thumbnail.text) を起動する
// ---------------------------------------------------------------------------

const ApproveContentSchema = z.object({ book_id: z.string().min(1) });

export async function approveBookContent(
  input: unknown,
): Promise<ActionResult<{ book_id: string }>> {
  let actorId: string;
  try {
    const session = await getSessionOrThrow();
    actorId = session.user.id;
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.books.contentApproval.error);
  }

  const parsed = ApproveContentSchema.safeParse(input);
  if (!parsed.success) return fail('validation', messages.books.contentApproval.error);
  const { book_id } = parsed.data;

  try {
    const book = await prisma.book.findUnique({
      where: { id: book_id },
      select: { id: true, status: true },
    });
    if (!book) return fail('not_found', messages.books.contentApproval.error);
    if (book.status !== 'content_review') {
      return fail('conflict', messages.books.contentApproval.notReviewable);
    }

    // 既に thumbnail.text が走っていないか確認 (二重起動防止)
    const existing = await prisma.job.findFirst({
      where: {
        book_id,
        kind: THUMBNAIL_TEXT_TASK,
        status: { in: ['queued', 'running', 'done'] },
      },
      select: { id: true },
    });

    let jobId = existing?.id ?? null;
    if (!jobId) {
      const job = await prisma.job.create({
        data: {
          kind: THUMBNAIL_TEXT_TASK,
          book_id,
          status: 'queued',
          payload_json: { book_id },
        },
      });
      jobId = job.id;
      await enqueueJob(THUMBNAIL_TEXT_TASK, { book_id, job_id: jobId });
    }

    // 承認したら本文承認待ちを抜ける (サムネ生成中)。thumbnail.text/image が以降の status を管理。
    await prisma.book.update({
      where: { id: book_id },
      data: { status: 'running' },
    });

    await prisma.auditLog.create({
      data: {
        actor_id: actorId,
        action: 'book.content.approve',
        target_kind: 'book',
        target_id: book_id,
        before_json: { status: 'content_review' },
        after_json: { status: 'running', thumbnail_text_job_id: jobId },
      },
    });

    revalidatePath('/books');
    revalidatePath(`/books/${book_id}`);
    return ok({ book_id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.books.contentApproval.error);
  }
}
