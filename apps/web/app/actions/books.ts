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
import { createComment } from '@/app/actions/comments';
import { createRevisionRun } from '@/app/actions/revision-runs';

const THUMBNAIL_TEXT_TASK = 'pipeline.book.thumbnail.text';
const READINGS_GENERATE_TASK = 'pipeline.book.readings.generate';
const PROMOTION_GENERATE_TASK = 'pipeline.book.promotion.generate';

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

    // F-052: 「未出版 → published」への遷移で、設定が ON なら販促プランを自動立案。
    // プラン生成タスクが成功すると promotion.posts.generate を連鎖起動し、投稿キューが自動生成される。
    if (
      publish_status === 'published' &&
      existing.publish_status !== 'published'
    ) {
      try {
        const settings = await prisma.appSettings.findUnique({
          where: { id: 'singleton' },
          select: { promo_auto_on_publish_enabled: true },
        });
        if (settings?.promo_auto_on_publish_enabled) {
          const inFlight = await prisma.job.findFirst({
            where: { book_id, kind: PROMOTION_GENERATE_TASK, status: { in: ['queued', 'running'] } },
            select: { id: true },
          });
          if (!inFlight) {
            const job = await prisma.job.create({
              data: {
                kind: PROMOTION_GENERATE_TASK,
                book_id,
                status: 'queued',
                payload_json: { book_id },
              },
            });
            await enqueueJob(PROMOTION_GENERATE_TASK, { book_id, job_id: job.id });
          }
        }
      } catch {
        // ベストエフォート: 販促自動立案の失敗は publish_status 更新の成否に影響させない。
      }
    }

    revalidatePath('/books');
    revalidatePath(`/books/${book_id}`);
    return ok({ book_id, publish_status });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.books.publish.updateError);
  }
}

// ---------------------------------------------------------------------------
// 読み (フリガナ/ローマ字) 生成: KDP 入稿用にタイトル/サブタイトル/著者名の
// カタカナ読みを AI 生成しローマ字へ変換して KdpMetadata に保存する (F-020b)。
// ---------------------------------------------------------------------------

const GenerateReadingsSchema = z.object({ book_id: z.string().min(1) });

export async function generateBookReadings(
  input: unknown,
): Promise<ActionResult<{ book_id: string; job_id: string }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.kdpChecklist.readings.error);
  }

  const parsed = GenerateReadingsSchema.safeParse(input);
  if (!parsed.success) return fail('validation', messages.kdpChecklist.readings.error);
  const { book_id } = parsed.data;

  try {
    const book = await prisma.book.findUnique({
      where: { id: book_id },
      select: { id: true, kdpMetadata: { select: { id: true } } },
    });
    if (!book) return fail('not_found', messages.kdpChecklist.readings.error);
    if (!book.kdpMetadata) return fail('conflict', messages.kdpChecklist.readings.noMetadata);

    const existing = await prisma.job.findFirst({
      where: { book_id, kind: READINGS_GENERATE_TASK, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    let jobId = existing?.id ?? null;
    if (!jobId) {
      const job = await prisma.job.create({
        data: { kind: READINGS_GENERATE_TASK, book_id, status: 'queued', payload_json: { book_id } },
      });
      jobId = job.id;
      await enqueueJob(READINGS_GENERATE_TASK, { book_id, job_id: jobId });
    }

    revalidatePath('/kdp/checklist');
    revalidatePath(`/kdp/checklist/${book_id}`);
    return ok({ book_id, job_id: jobId });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.kdpChecklist.readings.error);
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

// ---------------------------------------------------------------------------
// 本文承認ゲート: 承認せず「修正を依頼」— 運営者の指示を must コメント化し、
// その書籍の保留コメントで修正ラン (revision.book.apply) を起動する。
// ---------------------------------------------------------------------------

const RequestRevisionSchema = z.object({
  book_id: z.string().min(1),
  note: z.string().trim().min(1).max(2000),
});

export async function requestContentRevision(
  input: unknown,
): Promise<ActionResult<{ book_id: string }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.books.contentApproval.error);
  }

  const parsed = RequestRevisionSchema.safeParse(input);
  if (!parsed.success) return fail('validation', messages.books.contentApproval.revisionInvalid);
  const { book_id, note } = parsed.data;

  try {
    const book = await prisma.book.findUnique({
      where: { id: book_id },
      select: { id: true, status: true, outline: { select: { id: true } } },
    });
    if (!book) return fail('not_found', messages.books.contentApproval.error);
    if (!book.outline) return fail('conflict', messages.books.contentApproval.revisionNoOutline);

    // 1. 運営者の指示を outline 対象の must コメントとして登録 (章立て修正の起点)。
    const commentRes = await createComment({
      book_id,
      target_kind: 'outline',
      target_id: book.outline.id,
      range: null,
      body: note,
      priority: 'must',
    });
    if (!commentRes.ok) return commentRes;

    // 2. この書籍の pending コメントを集めて修正ランを起動。
    const pending = await prisma.revisionComment.findMany({
      where: { book_id, status: 'pending' },
      select: { id: true },
    });
    const commentIds = pending.map((c) => c.id);
    if (commentIds.length === 0) {
      return fail('conflict', messages.books.contentApproval.revisionInvalid);
    }

    const runRes = await createRevisionRun({
      comment_ids: commentIds,
      scope: 'all_pending_in_selected_books',
      selected_book_ids: [book_id],
    });
    if (!runRes.ok) return runRes;

    revalidatePath('/content-review');
    revalidatePath(`/books/${book_id}`);
    return ok({ book_id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.books.contentApproval.error);
  }
}
