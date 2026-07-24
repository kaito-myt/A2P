import { z } from 'zod';
import type { Task } from 'graphile-worker';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { decryptKdpCredentials } from '@a2p/crypto';
import { prisma as defaultPrisma } from '@a2p/db';

import type { BookshelfPort, TakedownMode } from './book-cull/bookshelf-port.js';

/**
 * `kdp.book.takedown` タスク — 承認された本を KDP から取り下げる(出版停止+アーカイブ)。
 *
 * レビュー承認式: 運営者がレビュー画面で承認(cull_status='approved')した本に対して enqueue される。
 * セッション再利用で本棚を操作 → 成功で books.status='retracted', cull_status='taken_down' に更新し、
 * 予約販促投稿を停止する。KDP は出版済み本を完全削除できないため「削除」=アーカイブ(復元可)。
 */
export const KDP_BOOK_TAKEDOWN_TASK_NAME = 'kdp.book.takedown';

export const KdpBookTakedownPayload = z.object({
  book_id: z.string().min(1),
  mode: z.enum(['unpublish', 'unpublish_archive']).default('unpublish_archive'),
});
export type KdpBookTakedownPayload = z.infer<typeof KdpBookTakedownPayload>;

export interface KdpBookTakedownDeps {
  payload: KdpBookTakedownPayload;
  browserPort: BookshelfPort;
  prisma?: typeof defaultPrisma;
  logger?: Logger;
  now?: () => Date;
}

export interface KdpBookTakedownResult {
  ok: boolean;
  bookId: string;
  finalState?: string;
  reason?: string;
}

export async function runKdpBookTakedown(deps: KdpBookTakedownDeps): Promise<KdpBookTakedownResult> {
  const { payload } = deps;
  const log = deps.logger ?? createLogger(`worker.${KDP_BOOK_TAKEDOWN_TASK_NAME}`);
  const prisma = deps.prisma ?? defaultPrisma;
  const now = deps.now ?? (() => new Date());

  const book = await prisma.book.findUnique({
    where: { id: payload.book_id },
    select: { id: true, asin: true, account: { select: { kdp_session_state_enc: true } } },
  });
  if (!book) return { ok: false, bookId: payload.book_id, reason: 'book_not_found' };
  if (!book.asin) return fail(prisma, payload.book_id, now, 'no_asin', 'ASIN 未設定の本は取り下げできません', log);
  if (!book.account?.kdp_session_state_enc) {
    return fail(prisma, payload.book_id, now, 'no_session', 'KDP セッション未設定', log);
  }

  let sessionState: string;
  try {
    sessionState = decryptKdpCredentials(book.account.kdp_session_state_enc);
  } catch {
    return fail(prisma, payload.book_id, now, 'decrypt_failed', 'セッション復号に失敗', log);
  }

  const res = await deps.browserPort.takedownBook({
    sessionState,
    asin: book.asin,
    mode: payload.mode as TakedownMode,
  });

  if (!res.ok) {
    return fail(prisma, payload.book_id, now, res.reason, res.message, log);
  }

  // 成功: 取り下げ済みに更新 + 予約販促停止。
  await prisma.book.update({
    where: { id: payload.book_id },
    data: { status: 'retracted', cull_status: 'taken_down', updated_at: now() },
  });
  await prisma.promotionPost.updateMany({
    where: { book_id: payload.book_id, status: { in: ['scheduled', 'draft'] } },
    data: { status: 'canceled', updated_at: now() },
  });

  log.info({ task: KDP_BOOK_TAKEDOWN_TASK_NAME, bookId: payload.book_id, finalState: res.finalState, steps: res.steps }, 'book taken down');
  return { ok: true, bookId: payload.book_id, finalState: res.finalState };
}

async function fail(
  prisma: typeof defaultPrisma,
  bookId: string,
  now: () => Date,
  reason: string,
  message: string,
  log: Logger,
): Promise<KdpBookTakedownResult> {
  // 失敗は cull_status を approved のまま残し、理由を記録(再試行/手動対応できるように)。
  await prisma.book
    .update({ where: { id: bookId }, data: { cull_reason: `取り下げ失敗: ${message}`, updated_at: now() } })
    .catch(() => {});
  log.warn({ bookId, reason, message }, 'book takedown failed');
  return { ok: false, bookId, reason };
}

export const kdpBookTakedownTask: Task = async (payload: unknown) => {
  const parsed = KdpBookTakedownPayload.safeParse(payload);
  if (!parsed.success) throw new Error(`Invalid kdp.book.takedown payload: ${parsed.error.message}`);
  const { createPlaywrightBookshelfPort } = await import('./book-cull/playwright-bookshelf-port.js');
  await runKdpBookTakedown({ payload: parsed.data, browserPort: createPlaywrightBookshelfPort() });
};
