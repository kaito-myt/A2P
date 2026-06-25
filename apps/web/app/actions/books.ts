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
import { messages } from '@/lib/messages';

const UpdatePublishStatusSchema = z.object({
  book_id: z.string().min(1),
  publish_status: z.enum(['unlisted', 'published']),
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
