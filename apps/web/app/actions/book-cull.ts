'use server';

/**
 * 低品質本の間引き — レビュー承認 Server Actions。
 *
 * 週次 `book.cull.detect` が cull_status='candidate' を付けた本を、運営者がレビューして
 * 承認(→取り下げジョブ enqueue)または却下(残す)する。取り下げは破壊的操作なので必ずこの
 * 人間ゲートを通す。
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { fail, ok, isA2PError, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';

const KDP_BOOK_TAKEDOWN_TASK = 'kdp.book.takedown';

export interface CullCandidateView {
  book_id: string;
  title: string;
  asin: string | null;
  reason: string | null;
  detected_at: string | null;
}

export async function listCullCandidates(): Promise<CullCandidateView[]> {
  const rows = await prisma.book.findMany({
    where: { cull_status: 'candidate' },
    select: { id: true, title: true, asin: true, cull_reason: true, cull_detected_at: true },
    orderBy: { cull_detected_at: 'desc' },
    take: 500,
  });
  return rows.map((b) => ({
    book_id: b.id,
    title: b.title,
    asin: b.asin,
    reason: b.cull_reason,
    detected_at: b.cull_detected_at ? b.cull_detected_at.toISOString() : null,
  }));
}

const IdsSchema = z.object({ book_ids: z.array(z.string().min(1)).min(1).max(200) });

export async function approveCull(input: unknown): Promise<ActionResult<{ approved: number }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unauthorized', '認証が必要です');
  }
  const parsed = IdsSchema.safeParse(input);
  if (!parsed.success) return fail('validation', '対象が不正です');

  // 候補 → 承認。ASIN のある候補のみ取り下げジョブを投入する。
  const books = await prisma.book.findMany({
    where: { id: { in: parsed.data.book_ids }, cull_status: 'candidate' },
    select: { id: true, asin: true },
  });
  let approved = 0;
  for (const b of books) {
    await prisma.book.update({ where: { id: b.id }, data: { cull_status: 'approved' } });
    if (b.asin) {
      await enqueueJob(KDP_BOOK_TAKEDOWN_TASK, { book_id: b.id, mode: 'unpublish_archive' });
      approved++;
    }
  }
  revalidatePath('/books/cull');
  return ok({ approved });
}

export async function rejectCull(input: unknown): Promise<ActionResult<{ rejected: number }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unauthorized', '認証が必要です');
  }
  const parsed = IdsSchema.safeParse(input);
  if (!parsed.success) return fail('validation', '対象が不正です');

  const res = await prisma.book.updateMany({
    where: { id: { in: parsed.data.book_ids }, cull_status: 'candidate' },
    data: { cull_status: 'rejected' },
  });
  revalidatePath('/books/cull');
  return ok({ rejected: res.count });
}
