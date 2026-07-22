import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  acquireBookLock as defaultAcquireBookLock,
  releaseBookLock as defaultReleaseBookLock,
} from '@a2p/agents/lib/book-lock';
import { generateChapter as defaultGenerateChapter } from '@a2p/agents/writer/chapter';
import { generateOutline as defaultGenerateOutline } from '@a2p/agents/writer/outline';
import type { Genre } from '@a2p/contracts/agents';
import { GENRE_SLUGS } from '@a2p/contracts/agents';
import {
  type ChapterPlan,
  type RevisionFeedbackItem,
  type WriterChapterInput,
  type WriterOutlineInput,
} from '@a2p/contracts/agents/writer';
import { ConflictError, NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import {
  type AddJobLike,
  PIPELINE_BOOK_JUDGE_TASK_NAME,
} from './pipeline-book-judge.js';
import { PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME } from './pipeline-book-cover-regenerate.js';

/**
 * `revision.book.apply` タスク (docs/05 §5.3.10, F-050)
 *
 * 1 タスク = 1 書籍。RevisionRun 起動時に書籍ごとにタスク分解される。
 *
 * フロー:
 *   1. payload zod parse (run_id / book_id / comment_ids / job_id)
 *   2. BookLock acquire (holder=`revision_run:<run_id>`)
 *      - 衝突: `blocked_books` に追記して正常終了 (throw しない)
 *   3. comment_ids のコメントを DB から取得、target_kind でグルーピング
 *   4. 各 target_kind ごとに処理:
 *      - chapter → generateChapter (feedback 付き) → Chapter 旧版退避 + version++
 *      - outline → generateOutline (reject_note に feedback 注入)
 *      - cover/cover_text/metadata/theme → Phase 1 placeholder (applied に遷移)
 *   5. 各コメントを `applied` or `not_applicable` に遷移
 *   6. pg_notify で進捗通知 (各コメント処理後)
 *   7. 全コメント処理後 BookLock 解放、RevisionRun.result_summary_json 更新
 *
 * priority: 5 (通常パイプライン 10 より高い)
 * timeout: 30 分
 * max_attempts: 2
 */

export const REVISION_BOOK_APPLY_TASK_NAME = 'revision.book.apply';

const REVISION_RUNS_PROGRESS_CHANNEL = 'revision_runs_progress';

export const RevisionBookApplyPayloadSchema = z.object({
  run_id: z.string().min(1),
  book_id: z.string().min(1),
  comment_ids: z.array(z.string().min(1)).min(1),
  job_id: z.string().min(1),
});
export type RevisionBookApplyPayload = z.infer<typeof RevisionBookApplyPayloadSchema>;

// ---------------------------------------------------------------------------
// Prisma minimal I/F
// ---------------------------------------------------------------------------

export interface RevisionBookApplyTxClient {
  chapterRevision: {
    create: (args: {
      data: {
        chapter_id: string;
        book_id: string;
        version: number;
        body_md: string;
        reason: string;
      };
    }) => Promise<{ id: string }>;
  };
  chapter: {
    update: (args: {
      where: { id: string };
      data: {
        body_md: string;
        version: number;
        char_count: number;
        updated_at?: Date;
      };
    }) => Promise<{ id: string }>;
  };
}

export interface RevisionBookApplyPrisma {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  $transaction: <T>(fn: (tx: RevisionBookApplyTxClient) => Promise<T>) => Promise<T>;
  job: {
    create: (args: {
      data: {
        kind: string;
        book_id: string;
        parent_job_id: string;
        status: string;
        payload_json: unknown;
      };
    }) => Promise<{ id: string }>;
  };
  revisionComment: {
    findMany: (args: {
      where: { id: { in: string[] }; book_id: string };
      select: {
        id: true;
        target_kind: true;
        target_id: true;
        body: true;
        priority: true;
        status: true;
        range_json: true;
      };
    }) => Promise<
      Array<{
        id: string;
        target_kind: string;
        target_id: string;
        body: string;
        priority: string;
        status: string;
        range_json: unknown;
      }>
    >;
    update: (args: {
      where: { id: string };
      data: {
        status: string;
        applied_at?: Date | null;
        run_id?: string;
        application_result_json?: unknown;
      };
    }) => Promise<{ id: string }>;
    count: (args: {
      where: { book_id: string; status: string; priority?: string };
    }) => Promise<number>;
  };
  revisionRun: {
    update: (args: {
      where: { id: string };
      data: {
        status?: string;
        started_at?: Date;
        finished_at?: Date;
        result_summary_json?: unknown;
        error?: string | null;
      };
    }) => Promise<unknown>;
  };
  book: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        account_id: true;
        theme_id: true;
        title: true;
        subtitle: true;
      };
    }) => Promise<{
      id: string;
      account_id: string;
      theme_id: string | null;
      title: string;
      subtitle: string | null;
    } | null>;
    update: (args: {
      where: { id: string };
      data: { has_pending_comments: boolean; has_blocking_comments: boolean };
    }) => Promise<{ id: string }>;
  };
  themeCandidate: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        genre: true;
        title: true;
        subtitle: true;
        hook: true;
        target_reader: true;
      };
    }) => Promise<{
      id: string;
      genre: string;
      title: string;
      subtitle: string | null;
      hook: string;
      target_reader: string | null;
    } | null>;
  };
  chapter: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        book_id: true;
        index: true;
        heading: true;
        body_md: true;
        version: true;
      };
    }) => Promise<{
      id: string;
      book_id: string;
      index: number;
      heading: string;
      body_md: string;
      version: number;
    } | null>;
  };
  outline: {
    findFirst: (args: {
      where: { book_id: string };
      select: {
        id: true;
        book_id: true;
        chapters_json: true;
        status: true;
      };
    }) => Promise<{
      id: string;
      book_id: string;
      chapters_json: unknown;
      status: string;
    } | null>;
    update: (args: {
      where: { id: string };
      data: {
        chapters_json: unknown;
        status: string;
        reject_note: string | null;
        updated_at?: Date;
      };
    }) => Promise<{ id: string }>;
  };
}

export interface RevisionBookApplyDeps {
  prisma?: RevisionBookApplyPrisma;
  logger?: Logger;
  generateChapter?: typeof defaultGenerateChapter;
  generateOutline?: typeof defaultGenerateOutline;
  acquireLock?: typeof defaultAcquireBookLock;
  releaseLock?: typeof defaultReleaseBookLock;
  now?: () => Date;
  sendMail?: (params: { template: string; data: Record<string, unknown> }) => Promise<void>;
  addJob?: AddJobLike;
}

// ---------------------------------------------------------------------------
// Result summary type
// ---------------------------------------------------------------------------

interface ResultSummary {
  applied: number;
  not_applicable: number;
  failed: number;
  cost_jpy: number;
  blocked_books?: string[];
  rescore_job_id?: string;
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

const ALLOWED_GENRES = new Set<string>(GENRE_SLUGS);

export async function runRevisionBookApply(
  payload: unknown,
  deps: RevisionBookApplyDeps = {},
): Promise<void> {
  const parsed = RevisionBookApplyPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('revision.book.apply payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { run_id: runId, book_id: bookId, comment_ids: commentIds, job_id: jobId } =
    parsed.data;

  const log = deps.logger ?? createLogger(`worker.${REVISION_BOOK_APPLY_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as RevisionBookApplyPrisma);
  const acquireLock = deps.acquireLock ?? defaultAcquireBookLock;
  const releaseLock = deps.releaseLock ?? defaultReleaseBookLock;
  const generateChapterFn = deps.generateChapter ?? defaultGenerateChapter;
  const generateOutlineFn = deps.generateOutline ?? defaultGenerateOutline;
  const now = deps.now ?? (() => new Date());
  const sendMailFn = deps.sendMail ?? defaultSendMail;
  const addJobFn = deps.addJob;

  const summary: ResultSummary = {
    applied: 0,
    not_applicable: 0,
    failed: 0,
    cost_jpy: 0,
  };

  // 1. BookLock acquire — 衝突なら blocked_books に追記して正常終了
  try {
    await acquireLock({
      bookId,
      holder: `revision_run:${runId}`,
      ttlMinutes: 30,
    });
  } catch (lockErr) {
    if (lockErr instanceof ConflictError) {
      log.info(
        { task: REVISION_BOOK_APPLY_TASK_NAME, runId, bookId, err: lockErr.message },
        'BookLock conflict — adding to blocked_books',
      );
      await updateRunSummary(prisma, runId, {
        ...summary,
        blocked_books: [bookId],
      });
      return;
    }
    throw lockErr;
  }

  try {
    // Mark run as running
    await prisma.revisionRun.update({
      where: { id: runId },
      data: { status: 'running', started_at: now() },
    });

    // 2. Fetch comments
    const comments = await prisma.revisionComment.findMany({
      where: { id: { in: commentIds }, book_id: bookId },
      select: {
        id: true,
        target_kind: true,
        target_id: true,
        body: true,
        priority: true,
        status: true,
        range_json: true,
      },
    });

    if (comments.length === 0) {
      log.warn(
        { task: REVISION_BOOK_APPLY_TASK_NAME, runId, bookId, commentIds },
        'no matching comments found — finishing early',
      );
      await finishRun(prisma, runId, summary, now);
      return;
    }

    // Filter only pending comments
    const pendingComments = comments.filter((c) => c.status === 'pending');

    // 3. Group by target_kind
    const grouped = new Map<
      string,
      Array<(typeof comments)[number]>
    >();
    for (const c of pendingComments) {
      const existing = grouped.get(c.target_kind) ?? [];
      existing.push(c);
      grouped.set(c.target_kind, existing);
    }

    // 4. Fetch Book + Theme context (needed for chapter/outline handlers)
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        account_id: true,
        theme_id: true,
        title: true,
        subtitle: true,
      },
    });
    if (!book) {
      throw new NotFoundError(`Book not found: ${bookId}`, {
        details: { bookId, runId },
      });
    }

    let theme: {
      id: string;
      genre: string;
      title: string;
      subtitle: string | null;
      hook: string;
      target_reader: string | null;
    } | null = null;

    if (book.theme_id) {
      theme = await prisma.themeCandidate.findUnique({
        where: { id: book.theme_id },
        select: {
          id: true,
          genre: true,
          title: true,
          subtitle: true,
          hook: true,
          target_reader: true,
        },
      });
    }

    // 4b. 表紙(cover)コメント: 全コメントのフィードバックを1本にまとめ、採用カバーを
    //     フィードバック反映で再生成する(pipeline.book.cover.regenerate)。実際に新カバーが
    //     生成される(= 真に「適用」)。採用カバーが無ければ再生成側で no-op として扱う。
    let coverRegenJobId: string | null = null;
    const coverComments = grouped.get('cover') ?? [];
    if (coverComments.length > 0 && addJobFn) {
      try {
        const coverFeedback = coverComments
          .map((c) => c.body?.trim())
          .filter((b): b is string => Boolean(b))
          .join('\n')
          .slice(0, 3900);
        // 修正コメントが対象とした Cover(target_id) を再生成タスクに渡す。
        // ただし target_id が bookId のもの(=作品全体/候補セットへのコメント)は特定カバー扱いにせず、
        // 新規候補を1枚生成させる。個別カバーへのコメントのみ cover_id を渡す。
        const commentedCoverId = coverComments
          .map((c) => c.target_id)
          .find((id): id is string => Boolean(id) && id !== bookId);
        // 修正コメント経由は adopt=false: 新カバーを候補として残し、運営者が確認してから採用する。
        const regenJob = await prisma.job.create({
          data: {
            kind: PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME,
            book_id: bookId,
            parent_job_id: jobId,
            status: 'queued',
            payload_json: {
              book_id: bookId,
              feedback: coverFeedback,
              adopt: false,
              ...(commentedCoverId ? { cover_id: commentedCoverId } : {}),
            },
          },
        });
        await addJobFn(
          PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME,
          {
            book_id: bookId,
            job_id: regenJob.id,
            feedback: coverFeedback,
            adopt: false,
            ...(commentedCoverId ? { cover_id: commentedCoverId } : {}),
          },
          { maxAttempts: 2 },
        );
        coverRegenJobId = regenJob.id;
      } catch (regenErr) {
        log.warn(
          {
            task: REVISION_BOOK_APPLY_TASK_NAME,
            runId,
            bookId,
            err: regenErr instanceof Error ? `${regenErr.name}: ${regenErr.message}` : String(regenErr),
          },
          'failed to enqueue cover regenerate — cover comments will be marked not_applicable',
        );
      }
    }

    // 5. Process each target_kind group
    for (const [targetKind, kindComments] of grouped) {
      for (const comment of kindComments) {
        try {
          switch (targetKind) {
            case 'chapter':
              await handleChapterComment(
                comment,
                { bookId, runId, book, theme, prisma, generateChapterFn, log, now },
              );
              summary.applied += 1;
              break;

            case 'outline':
              await handleOutlineComment(
                comment,
                { bookId, runId, book, theme, prisma, generateOutlineFn, log, now },
              );
              summary.applied += 1;
              break;

            case 'cover':
              // 表紙コメント: 再生成をトリガできたら applied、無理なら not_applicable（嘘をつかない）。
              if (coverRegenJobId) {
                await prisma.revisionComment.update({
                  where: { id: comment.id },
                  data: {
                    status: 'applied',
                    applied_at: now(),
                    run_id: runId,
                    application_result_json: {
                      action: 'cover_regenerate_enqueued',
                      regenerate_job_id: coverRegenJobId,
                      note: 'フィードバックを反映して採用カバーを再生成中',
                    },
                  },
                });
                summary.applied += 1;
              } else {
                await markNotApplicable(
                  prisma,
                  comment.id,
                  runId,
                  '表紙の再生成を起動できませんでした（採用カバー未確定 or キュー不可）',
                  now,
                );
                summary.not_applicable += 1;
              }
              break;

            case 'cover_text':
            case 'metadata':
            case 'theme':
              await handlePlaceholderComment(comment, { prisma, runId, now });
              summary.applied += 1;
              break;

            default:
              await markNotApplicable(
                prisma,
                comment.id,
                runId,
                `Unknown target_kind: ${targetKind}`,
                now,
              );
              summary.not_applicable += 1;
              break;
          }
        } catch (commentErr) {
          log.warn(
            {
              task: REVISION_BOOK_APPLY_TASK_NAME,
              runId,
              bookId,
              commentId: comment.id,
              targetKind,
              err: commentErr instanceof Error
                ? `${commentErr.name}: ${commentErr.message}`
                : String(commentErr),
            },
            'comment processing failed — marking not_applicable',
          );
          try {
            await markNotApplicable(
              prisma,
              comment.id,
              runId,
              commentErr instanceof Error ? commentErr.message : String(commentErr),
              now,
            );
          } catch (markErr) {
            log.warn(
              { commentId: comment.id, err: markErr },
              'failed to mark comment as not_applicable after error',
            );
          }
          summary.not_applicable += 1;
        }

        // pg_notify progress per comment
        await notifyProgress(prisma, log, now, {
          runId,
          bookId,
          commentId: comment.id,
          targetKind,
          appliedCount: summary.applied,
          notApplicableCount: summary.not_applicable,
          totalCount: pendingComments.length,
        });
      }
    }

    // Mark non-pending comments that were in the request
    for (const c of comments) {
      if (c.status !== 'pending') {
        summary.not_applicable += 1;
      }
    }

    // 5b. Recompute Book の denormalized コメントフラグ。
    //     コメントを pending → applied/not_applicable に遷移させたので、
    //     book.has_pending_comments / has_blocking_comments を実データから
    //     再計算しないとライブラリ一覧の「must ブロック中」バッジが stale に残る
    //     (comments-core / revision-runs-core のロールバックと同じ不変条件)。
    await recomputeBookFlags(prisma, bookId);

    // 6. Judge 再採点 enqueue (Phase 2 フック, docs/05 §5.3.10)
    if (addJobFn) {
      try {
        const triggeredBy = `revision_run:${runId}`;
        const judgeJob = await prisma.job.create({
          data: {
            kind: PIPELINE_BOOK_JUDGE_TASK_NAME,
            book_id: bookId,
            parent_job_id: jobId,
            status: 'queued',
            payload_json: {
              book_id: bookId,
              retry_count: 0,
              triggered_by: triggeredBy,
            },
          },
        });
        await addJobFn(
          PIPELINE_BOOK_JUDGE_TASK_NAME,
          {
            book_id: bookId,
            job_id: judgeJob.id,
            retry_count: 0,
            triggered_by: triggeredBy,
          },
          { maxAttempts: 2 },
        );
        summary.rescore_job_id = judgeJob.id;
        log.info(
          {
            task: REVISION_BOOK_APPLY_TASK_NAME,
            runId,
            bookId,
            rescoreJobId: judgeJob.id,
            triggeredBy,
          },
          'pipeline.book.judge enqueued for rescore',
        );
      } catch (rescoreErr) {
        log.warn(
          { task: REVISION_BOOK_APPLY_TASK_NAME, runId, bookId, err: rescoreErr },
          'failed to enqueue judge rescore (non-fatal)',
        );
      }
    }

    // 7. Finish run (summary may include rescore_job_id)
    await finishRun(prisma, runId, summary, now);

    // 8. Send terminal pg_notify so SSE clients receive `event: done`
    const terminalStatus = summary.not_applicable > 0 ? 'partial' : 'done';
    await notifyProgress(prisma, log, now, {
      runId,
      bookId,
      commentId: '',
      targetKind: '',
      appliedCount: summary.applied,
      notApplicableCount: summary.not_applicable,
      totalCount: pendingComments.length,
      status: terminalStatus,
    });

    // 9. Completion email (placeholder until Resend integration)
    try {
      await sendMailFn({
        template: 'revision-run-completed',
        data: {
          runId,
          bookId,
          applied: summary.applied,
          total: pendingComments.length,
          status: terminalStatus,
        },
      });
    } catch (mailErr) {
      log.warn(
        { task: REVISION_BOOK_APPLY_TASK_NAME, runId, bookId, err: mailErr },
        'completion mail failed (non-fatal)',
      );
    }

    log.info(
      {
        task: REVISION_BOOK_APPLY_TASK_NAME,
        runId,
        bookId,
        applied: summary.applied,
        not_applicable: summary.not_applicable,
        failed: summary.failed,
      },
      'revision.book.apply done',
    );
  } catch (err) {
    // Best-effort: 一部のコメントが applied に遷移してから失敗した場合でも
    // Book フラグを実データと同期させる (stale な「must ブロック中」を残さない)。
    try {
      await recomputeBookFlags(prisma, bookId);
    } catch (flagErr) {
      log.warn(
        { task: REVISION_BOOK_APPLY_TASK_NAME, runId, bookId, err: flagErr },
        'failed to recompute book comment flags after error (non-fatal)',
      );
    }
    try {
      await prisma.revisionRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          finished_at: now(),
          error: serializeError(err),
          result_summary_json: summary,
        },
      });
    } catch (runUpdateErr) {
      log.warn(
        { task: REVISION_BOOK_APPLY_TASK_NAME, runId, bookId, err: runUpdateErr },
        'failed to mark RevisionRun as failed',
      );
    }
    // Best-effort terminal pg_notify so SSE clients can close
    try {
      await notifyProgress(prisma, log, now, {
        runId,
        bookId,
        commentId: '',
        targetKind: '',
        appliedCount: summary.applied,
        notApplicableCount: summary.not_applicable,
        totalCount: 0,
        status: 'failed',
      });
    } catch {
      // noop — notify is best-effort
    }
    throw err;
  } finally {
    try {
      await releaseLock({ bookId, holder: `revision_run:${runId}` });
    } catch (releaseErr) {
      log.warn(
        { task: REVISION_BOOK_APPLY_TASK_NAME, runId, bookId, err: releaseErr },
        'failed to release BookLock (will be swept by locks.sweep)',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Chapter handler — generateChapter with feedback, then retire old version
// ---------------------------------------------------------------------------

interface HandlerContext {
  bookId: string;
  runId: string;
  book: {
    id: string;
    account_id: string;
    theme_id: string | null;
    title: string;
    subtitle: string | null;
  };
  theme: {
    id: string;
    genre: string;
    title: string;
    subtitle: string | null;
    hook: string;
    target_reader: string | null;
  } | null;
  prisma: RevisionBookApplyPrisma;
  log: Logger;
  now: () => Date;
}

interface ChapterHandlerContext extends HandlerContext {
  generateChapterFn: typeof defaultGenerateChapter;
}

async function handleChapterComment(
  comment: {
    id: string;
    target_id: string;
    body: string;
    priority: string;
  },
  ctx: ChapterHandlerContext,
): Promise<void> {
  const { bookId, runId, book, theme, prisma, generateChapterFn, log, now } = ctx;

  // Fetch the target chapter
  const chapter = await prisma.chapter.findUnique({
    where: { id: comment.target_id },
    select: {
      id: true,
      book_id: true,
      index: true,
      heading: true,
      body_md: true,
      version: true,
    },
  });
  if (!chapter) {
    throw new NotFoundError(`Chapter not found: ${comment.target_id}`, {
      details: { chapterId: comment.target_id, bookId, commentId: comment.id },
    });
  }
  if (chapter.book_id !== bookId) {
    throw new ValidationError(
      `Chapter.book_id mismatch: chapter=${chapter.book_id} expected=${bookId}`,
      { details: { chapterId: chapter.id, bookId } },
    );
  }

  if (!theme) {
    throw new NotFoundError(`ThemeCandidate not available for book: ${bookId}`, {
      details: { bookId, runId },
    });
  }

  const genre = normalizeGenre(theme.genre);
  const themeContext: WriterChapterInput['themeContext'] = {
    title: (book.title && book.title.length > 0 ? book.title : theme.title).slice(0, 200),
    hook: (theme.hook ?? '').slice(0, 800) || '(no hook)',
    target_reader: (theme.target_reader ?? '').slice(0, 300) || '(no target_reader)',
  };
  const subtitle = book.subtitle ?? theme.subtitle ?? null;
  if (subtitle && subtitle.length > 0) {
    themeContext.subtitle = subtitle.slice(0, 200);
  }

  const feedback: RevisionFeedbackItem[] = [
    {
      body: comment.body,
      priority: normalizePriority(comment.priority),
    },
  ];

  // Build a minimal outlineChapter from the existing chapter
  const outlineChapter: ChapterPlan = {
    index: chapter.index,
    heading: chapter.heading,
    summary: `既存の第${chapter.index}章の修正リクエスト`,
    target_chars: Math.max(2000, [...chapter.body_md].length),
    subheadings: extractSubheadings(chapter.body_md),
  };

  const chapterInput: WriterChapterInput = {
    bookId,
    accountId: book.account_id,
    genre,
    outlineChapter,
    themeContext,
    feedback,
  };

  const result = await generateChapterFn(chapterInput);

  // Atomic: retire old version to ChapterRevision + update Chapter
  const reason = `revision_run:${runId}`;
  const newCharCount = [...result.body_md].length;
  await prisma.$transaction(async (tx) => {
    await tx.chapterRevision.create({
      data: {
        chapter_id: chapter.id,
        book_id: bookId,
        version: chapter.version,
        body_md: chapter.body_md,
        reason,
      },
    });
    await tx.chapter.update({
      where: { id: chapter.id },
      data: {
        body_md: result.body_md,
        version: chapter.version + 1,
        char_count: newCharCount,
        updated_at: now(),
      },
    });
  });

  // Mark comment as applied
  await prisma.revisionComment.update({
    where: { id: comment.id },
    data: {
      status: 'applied',
      applied_at: now(),
      run_id: runId,
      application_result_json: {
        new_version: chapter.version + 1,
        char_count: newCharCount,
        diff_summary: `Chapter ${chapter.index} updated from v${chapter.version} to v${chapter.version + 1}`,
      },
    },
  });

  log.info(
    {
      task: REVISION_BOOK_APPLY_TASK_NAME,
      runId,
      bookId,
      commentId: comment.id,
      chapterId: chapter.id,
      oldVersion: chapter.version,
      newVersion: chapter.version + 1,
    },
    'chapter comment applied',
  );
}

// ---------------------------------------------------------------------------
// Outline handler — generateOutline with reject_note
// ---------------------------------------------------------------------------

interface OutlineHandlerContext extends HandlerContext {
  generateOutlineFn: typeof defaultGenerateOutline;
}

async function handleOutlineComment(
  comment: {
    id: string;
    target_id: string;
    body: string;
    priority: string;
  },
  ctx: OutlineHandlerContext,
): Promise<void> {
  const { bookId, runId, book, theme, prisma, generateOutlineFn, log, now } = ctx;

  if (!theme) {
    throw new NotFoundError(`ThemeCandidate not available for book: ${bookId}`, {
      details: { bookId, runId },
    });
  }

  const outline = await prisma.outline.findFirst({
    where: { book_id: bookId },
    select: { id: true, book_id: true, chapters_json: true, status: true },
  });
  if (!outline) {
    throw new NotFoundError(`Outline not found for book: ${bookId}`, {
      details: { bookId, runId, commentId: comment.id },
    });
  }

  const genre = normalizeGenre(theme.genre);
  const themeContext: WriterOutlineInput['themeContext'] = {
    title: (book.title && book.title.length > 0 ? book.title : theme.title).slice(0, 200),
    hook: (theme.hook ?? '').slice(0, 800) || '(no hook)',
    target_reader: (theme.target_reader ?? '').slice(0, 300) || '(no target_reader)',
  };
  const subtitle = book.subtitle ?? theme.subtitle ?? null;
  if (subtitle && subtitle.length > 0) {
    themeContext.subtitle = subtitle.slice(0, 200);
  }

  const outlineInput: WriterOutlineInput = {
    bookId,
    accountId: book.account_id,
    genre,
    themeContext,
    rejectNote: `[修正コメント] ${comment.body}`,
    targetChapterCount: 8,
    targetTotalChars: 50000,
  };

  const result = await generateOutlineFn(outlineInput);

  // Update the outline with new chapters_json
  await prisma.outline.update({
    where: { id: outline.id },
    data: {
      chapters_json: result.chapters,
      status: 'pending_review',
      reject_note: comment.body,
      updated_at: now(),
    },
  });

  await prisma.revisionComment.update({
    where: { id: comment.id },
    data: {
      status: 'applied',
      applied_at: now(),
      run_id: runId,
      application_result_json: {
        outline_id: outline.id,
        chapters_count: result.chapters.length,
        diff_summary: `Outline regenerated with ${result.chapters.length} chapters`,
      },
    },
  });

  log.info(
    {
      task: REVISION_BOOK_APPLY_TASK_NAME,
      runId,
      bookId,
      commentId: comment.id,
      outlineId: outline.id,
      chaptersCount: result.chapters.length,
    },
    'outline comment applied',
  );
}

// ---------------------------------------------------------------------------
// Placeholder handlers — cover, cover_text, metadata, theme (Phase 1)
// ---------------------------------------------------------------------------

async function handlePlaceholderComment(
  comment: { id: string; target_kind: string },
  ctx: {
    prisma: RevisionBookApplyPrisma;
    runId: string;
    now: () => Date;
  },
): Promise<void> {
  await ctx.prisma.revisionComment.update({
    where: { id: comment.id },
    data: {
      status: 'applied',
      applied_at: ctx.now(),
      run_id: ctx.runId,
      application_result_json: {
        reason: 'Phase 1: placeholder implementation',
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Book の denormalized コメントフラグを実データから再計算する。
 *
 * 不変条件 (comments-core / revision-runs-core と共通):
 *   has_pending_comments  = COUNT(RevisionComment WHERE book_id=X AND status='pending') > 0
 *   has_blocking_comments = COUNT(RevisionComment WHERE book_id=X AND status='pending' AND priority='must') > 0
 *
 * applied / not_applicable / superseded / dismissed 等の非 pending は除外されるため、
 * 最後の must コメントが applied になった瞬間に has_blocking_comments = false に落ちる。
 */
async function recomputeBookFlags(
  prisma: RevisionBookApplyPrisma,
  bookId: string,
): Promise<void> {
  const pendingCount = await prisma.revisionComment.count({
    where: { book_id: bookId, status: 'pending' },
  });
  const mustPendingCount = await prisma.revisionComment.count({
    where: { book_id: bookId, status: 'pending', priority: 'must' },
  });
  await prisma.book.update({
    where: { id: bookId },
    data: {
      has_pending_comments: pendingCount > 0,
      has_blocking_comments: mustPendingCount > 0,
    },
  });
}

async function markNotApplicable(
  prisma: RevisionBookApplyPrisma,
  commentId: string,
  runId: string,
  reason: string,
  now: () => Date,
): Promise<void> {
  await prisma.revisionComment.update({
    where: { id: commentId },
    data: {
      status: 'not_applicable',
      applied_at: null,
      run_id: runId,
      application_result_json: { reason },
    },
  });
}

async function finishRun(
  prisma: RevisionBookApplyPrisma,
  runId: string,
  summary: ResultSummary,
  now: () => Date,
): Promise<void> {
  const status = summary.not_applicable > 0 ? 'partial' : 'done';
  await prisma.revisionRun.update({
    where: { id: runId },
    data: {
      status,
      finished_at: now(),
      result_summary_json: summary,
    },
  });
}

async function updateRunSummary(
  prisma: RevisionBookApplyPrisma,
  runId: string,
  summary: ResultSummary,
): Promise<void> {
  await prisma.revisionRun.update({
    where: { id: runId },
    data: {
      result_summary_json: summary,
    },
  });
}

async function notifyProgress(
  prisma: RevisionBookApplyPrisma,
  log: Logger,
  now: () => Date,
  data: {
    runId: string;
    bookId: string;
    commentId: string;
    targetKind: string;
    appliedCount: number;
    notApplicableCount: number;
    totalCount: number;
    status?: string;
  },
): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      runId: data.runId,
      bookId: data.bookId,
      commentId: data.commentId,
      targetKind: data.targetKind,
      applied: data.appliedCount,
      not_applicable: data.notApplicableCount,
      total: data.totalCount,
      updated_at: now().toISOString(),
    };
    if (data.status) {
      payload.status = data.status;
    }
    await prisma.$executeRawUnsafe(
      'SELECT pg_notify($1, $2)',
      REVISION_RUNS_PROGRESS_CHANNEL,
      JSON.stringify(payload),
    );
  } catch (err) {
    log.warn(
      {
        channel: REVISION_RUNS_PROGRESS_CHANNEL,
        runId: data.runId,
        err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      },
      'pg_notify for revision progress failed (continuing — SSE is best-effort)',
    );
  }
}

function normalizeGenre(g: string): Genre | null {
  return ALLOWED_GENRES.has(g) ? (g as Genre) : null;
}

function normalizePriority(p: string): 'must' | 'should' | 'may' {
  if (p === 'must' || p === 'should' || p === 'may') return p;
  return 'should';
}

function extractSubheadings(bodyMd: string): string[] {
  const headings: string[] = [];
  const lines = bodyMd.split('\n');
  for (const line of lines) {
    const match = /^##\s+(.+)/.exec(line.trim());
    if (match && match[1]) {
      headings.push(match[1].trim());
    }
  }
  if (headings.length < 2) {
    return ['概要', 'まとめ'];
  }
  return headings.slice(0, 10);
}

async function defaultSendMail(params: {
  template: string;
  data: Record<string, unknown>;
}): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    `[sendMail placeholder] template=${params.template} data=${JSON.stringify(params.data)}`,
  );
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** graphile-worker 用エクスポート. `buildTaskList()` から登録される. */
export const revisionBookApplyTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runRevisionBookApply(payload, {
    addJob: helpers.addJob as unknown as AddJobLike,
  });
};
