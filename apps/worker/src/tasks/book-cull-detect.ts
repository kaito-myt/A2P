import type { Task } from 'graphile-worker';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';
import { getBookCullCandidates, type BookCullThresholds, type BookCullCandidate } from '@a2p/db/book-cull';

/**
 * `book.cull.detect` タスク — 低品質本(売上低迷)の取り下げ候補を週次抽出する。
 *
 * AppSettings.book_cull_enabled が true のとき cron 起動。閾値(min_age_days / max_kenp /
 * max_royalty_jpy)で候補を抽出し、books.cull_status='candidate' + 指標スナップショットを付ける。
 * 実際の取り下げは行わない(レビュー承認式)。運営者はレビュー画面で承認/却下する。
 */
export const BOOK_CULL_DETECT_TASK_NAME = 'book.cull.detect';

export interface BookCullDetectDeps {
  prisma?: typeof defaultPrisma;
  logger?: Logger;
  now?: () => Date;
  /** 候補取得の差し替え(テスト用)。既定は getBookCullCandidates。 */
  getCandidates?: (
    prisma: typeof defaultPrisma,
    t: BookCullThresholds,
    now: Date,
  ) => Promise<BookCullCandidate[]>;
}

export interface BookCullDetectResult {
  enabled: boolean;
  candidates: number;
}

export async function runBookCullDetect(deps: BookCullDetectDeps = {}): Promise<BookCullDetectResult> {
  const log = deps.logger ?? createLogger(`worker.${BOOK_CULL_DETECT_TASK_NAME}`);
  const prisma = deps.prisma ?? defaultPrisma;
  const now = deps.now ?? (() => new Date());

  const settings = await prisma.appSettings.findUnique({ where: { id: 'singleton' } });
  if (!settings?.book_cull_enabled) {
    log.info({ task: BOOK_CULL_DETECT_TASK_NAME }, 'book cull disabled — skip');
    return { enabled: false, candidates: 0 };
  }

  const thresholds: BookCullThresholds = {
    minAgeDays: settings.book_cull_min_age_days,
    maxKenp: settings.book_cull_max_kenp,
    maxRoyaltyJpy: settings.book_cull_max_royalty_jpy,
  };

  const getCandidates = deps.getCandidates ?? getBookCullCandidates;
  const candidates = await getCandidates(prisma, thresholds, now());
  let marked = 0;
  for (const c of candidates) {
    const reason = `公開${c.age_days}日 / 累計KENP${c.cum_kenp}p / 累計¥${c.cum_royalty_jpy}${c.quality_score != null ? ` / 品質${c.quality_score}` : ''} (閾値: ${thresholds.minAgeDays}日・KENP≤${thresholds.maxKenp}・¥≤${thresholds.maxRoyaltyJpy})`;
    try {
      await prisma.book.update({
        where: { id: c.book_id },
        data: { cull_status: 'candidate', cull_detected_at: now(), cull_reason: reason },
      });
      marked++;
    } catch (err) {
      log.warn({ err, bookId: c.book_id }, 'failed to mark cull candidate');
    }
  }

  log.info({ task: BOOK_CULL_DETECT_TASK_NAME, candidates: marked }, 'book cull detect done');
  return { enabled: true, candidates: marked };
}

export const bookCullDetectTask: Task = async () => {
  await runBookCullDetect();
};
