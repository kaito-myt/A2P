'use server';

/**
 * 販促プラン生成 Server Action (F-051)。
 *
 * 書籍に対し pipeline.book.promotion.generate を enqueue する。既に実行中/待機中の
 * ジョブがあればそれを返す (二重起動防止)。
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isA2PError, fail, ok, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';

const PROMOTION_GENERATE_TASK = 'pipeline.book.promotion.generate';

const GeneratePromotionSchema = z.object({ book_id: z.string().min(1) });

export async function generateBookPromotion(
  input: unknown,
): Promise<ActionResult<{ book_id: string; job_id: string }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.promotion.errors.generate);
  }

  const parsed = GeneratePromotionSchema.safeParse(input);
  if (!parsed.success) return fail('validation', messages.promotion.errors.generate);
  const { book_id } = parsed.data;

  try {
    const book = await prisma.book.findUnique({ where: { id: book_id }, select: { id: true } });
    if (!book) return fail('not_found', messages.promotion.errors.generate);

    const existing = await prisma.job.findFirst({
      where: { book_id, kind: PROMOTION_GENERATE_TASK, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    let jobId = existing?.id ?? null;
    if (!jobId) {
      const job = await prisma.job.create({
        data: { kind: PROMOTION_GENERATE_TASK, book_id, status: 'queued', payload_json: { book_id } },
      });
      jobId = job.id;
      await enqueueJob(PROMOTION_GENERATE_TASK, { book_id, job_id: jobId });
    }

    revalidatePath('/promotion');
    revalidatePath(`/promotion/${book_id}`);
    return ok({ book_id, job_id: jobId });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.promotion.errors.generate);
  }
}
