import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  acquireBookLock as defaultAcquireBookLock,
  releaseBookLock as defaultReleaseBookLock,
} from '@a2p/agents/lib/book-lock';
import { judgeBook as defaultJudgeBook } from '@a2p/agents/judge';
import type { Genre } from '@a2p/contracts/agents';
import type { JudgeInput, JudgeOutput } from '@a2p/contracts/agents/judge';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';
import { sendEmail as defaultSendEmail } from '@a2p/notify';
import { buildJudgeNeedsReviewEmail } from '@a2p/notify';

import {
  notifyJobChange as defaultNotifyJobChange,
  type JobChangeNotifyPayload,
} from '../lib/notify-job-change.js';
import { PIPELINE_BOOK_EDITOR_TASK_NAME } from './pipeline-book-editor.js';
import { PIPELINE_BOOK_EXPORT_TASK_NAME } from './pipeline-book-export.js';
import { PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME } from './pipeline-book-writer-chapter.js';

/**
 * `pipeline.book.judge` タスク (docs/05 §5.3.8, F-008 / SP-10 T-10-03)
 *
 * Quality Judge (Sonnet) が 6 軸採点を行い、スコア >= 80 なら export enqueue、
 * < 80 かつ retry_count < 2 なら editor or writer.chapter 再キック、
 * 3 回失敗 (retry_count >= 2) で needs_human_review に遷移しメール送信する。
 *
 * 起動経路: `pipeline.book.thumbnail.image` の全候補完了後 (T-10-04 で変更予定)
 *           または `revision.book.apply` の Judge 再採点フック (T-10-05)。
 *
 * フロー:
 *   1. payload zod parse (book_id / job_id / retry_count / triggered_by?)
 *   2. 冪等チェック: Job.status='done' ならスキップ
 *   3. CAS: queued/failed → running
 *   4. BookLock 取得 (holder=`pipeline:<job_id>`, TTL 30 分)
 *   5. Book + ThemeCandidate + Outline + Chapter[] (全章) fetch (0 件 → NotFoundError)
 *   6. `judgeBook(input)` 呼出 (token_usage は judgeBook 内で role='judge' INSERT)
 *   7. EvalResult INSERT (triggered_by は payload.triggered_by 優先)
 *   8. 分岐:
 *      A. score_total >= 80 → Book.status='exporting' + pipeline.book.export enqueue
 *      B. score_total < 80 かつ retry_count < 2 → editor or writer.chapter 再キック
 *         (style/japanese/logical < 70 → editor 優先、それ以外 → writer 全章)
 *         → 新 Job INSERT(retry_count+1) + addJob + Book.status='judging'
 *      C. score_total < 80 かつ retry_count >= 2 → Book.status='needs_human_review'
 *         + Alert INSERT + Resend メール
 *   9. Job.status='done', result_json=採点サマリ
 *  10. notifyJobChange (ADR-001: channel='jobs')
 *  11. finally: BookLock 解放
 *
 * エラー方針:
 *   - payload zod 違反 → ValidationError
 *   - Book / Theme / Outline / Chapter 不在 → NotFoundError (Job=failed 降格)
 *   - judgeBook AgentError / ProviderError → 透過 throw + Job=failed
 *   - BookLock acquire 失敗 → 透過 throw + Job=failed
 *   - notifyJobChange 失敗 → warn のみで継続
 */

export const PIPELINE_BOOK_JUDGE_TASK_NAME = 'pipeline.book.judge';

/** docs/05 §5.3.8 + SP-10 §7.2 の拡張型定義 */
export const PipelineBookJudgePayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
  retry_count: z.number().int().min(0).default(0),
  /** revision.book.apply から forward する際に設定 (T-10-05 で使用)。 */
  triggered_by: z.string().optional(),
});
export type PipelineBookJudgePayload = z.infer<typeof PipelineBookJudgePayloadSchema>;

/** Prisma 部分 I/F — テストで mock しやすいよう最小サブセット。 */
export interface PipelineBookJudgePrisma {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  job: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true; book_id: true };
    }) => Promise<{ status: string; book_id: string | null } | null>;
    findFirst: (args: {
      where: {
        book_id: string;
        kind: string;
        status: { in: string[] };
      };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
    updateMany: (args: {
      where: { id: string; status: { in: string[] } };
      data: { status: string; started_at?: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: {
        status?: string;
        finished_at?: Date;
        error?: string | null;
        result_json?: unknown;
      };
    }) => Promise<unknown>;
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
  book: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        account_id: true;
        theme_id: true;
        title: true;
        subtitle: true;
        status: true;
      };
    }) => Promise<{
      id: string;
      account_id: string;
      theme_id: string | null;
      title: string;
      subtitle: string | null;
      status: string;
    } | null>;
    update: (args: {
      where: { id: string };
      data: { status: string; updated_at?: Date };
    }) => Promise<unknown>;
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
  outline: {
    findUnique: (args: {
      where: { book_id: string };
      select: {
        id: true;
        chapters_json: true;
      };
    }) => Promise<{
      id: string;
      chapters_json: unknown;
    } | null>;
  };
  chapter: {
    findMany: (args: {
      where: { book_id: string };
      select: {
        id: true;
        index: true;
        heading: true;
        body_md: true;
        version: true;
      };
      orderBy: { index: 'asc' };
    }) => Promise<
      Array<{
        id: string;
        index: number;
        heading: string;
        body_md: string;
        version: number;
      }>
    >;
  };
  evalResult: {
    create: (args: {
      data: {
        book_id: string;
        prompt_version_ids_json: unknown;
        score_total: number;
        score_breakdown_json: unknown;
        judge_comments_json: unknown;
        triggered_by: string;
        retry_count: number;
        judged_at: Date;
      };
    }) => Promise<{ id: string }>;
  };
  alert: {
    create: (args: {
      data: {
        kind: string;
        severity: string;
        payload_json: unknown;
      };
    }) => Promise<{ id: string }>;
  };
}

/** `helpers.addJob` の最小 I/F. */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

/** sendEmail の最小 I/F (DI 用)。 */
export type SendEmailLike = typeof defaultSendEmail;

export interface PipelineBookJudgeDeps {
  prisma?: PipelineBookJudgePrisma;
  logger?: Logger;
  judgeBook?: (input: JudgeInput) => Promise<JudgeOutput>;
  acquireLock?: typeof defaultAcquireBookLock;
  releaseLock?: typeof defaultReleaseBookLock;
  sendEmail?: SendEmailLike;
  now?: () => Date;
  notifyJobChange?: (
    payload: JobChangeNotifyPayload,
    deps: {
      prisma: { $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> };
      logger?: Logger;
    },
  ) => Promise<{ ok: boolean }>;
}

const ALLOWED_GENRES = new Set<string>(['practical', 'business', 'self_help']);

const CHAPTER_BODY_LIMIT = 12000;
const OUTLINE_SUMMARY_LIMIT = 2000;

/**
 * graphile-worker から呼ばれる Task 本体は下の `pipelineBookJudgeTask`.
 * このヘルパは DI を受け取りテストから直接呼べる.
 */
export async function runPipelineBookJudge(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookJudgeDeps = {},
): Promise<void> {
  const parsed = PipelineBookJudgePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.judge payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const {
    book_id: bookId,
    job_id: jobId,
    retry_count: retryCount,
    triggered_by: triggeredByOverride,
  } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_JUDGE_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PipelineBookJudgePrisma);
  const judgeBookFn = deps.judgeBook ?? defaultJudgeBook;
  const acquireLock = deps.acquireLock ?? defaultAcquireBookLock;
  const releaseLock = deps.releaseLock ?? defaultReleaseBookLock;
  const sendEmailFn = deps.sendEmail ?? defaultSendEmail;
  const notifyJobChangeFn = deps.notifyJobChange ?? defaultNotifyJobChange;
  const now = deps.now ?? (() => new Date());

  // 1. 冪等性チェック: 既に done なら skip
  const existing = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true, book_id: true },
  });
  if (!existing) {
    throw new NotFoundError(`Job not found: ${jobId}`, {
      details: { jobId, bookId },
    });
  }
  if (existing.status === 'done') {
    log.info(
      { task: PIPELINE_BOOK_JUDGE_TASK_NAME, jobId, bookId },
      'job already done — skipping (idempotent)',
    );
    return;
  }

  // 2. CAS で queued/failed → running
  const casResult = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (casResult.count === 0) {
    log.info(
      {
        task: PIPELINE_BOOK_JUDGE_TASK_NAME,
        jobId,
        bookId,
        observedStatus: existing.status,
      },
      'job not in queued/failed state — skipping (probably already running on another worker)',
    );
    return;
  }

  // 3. BookLock 取得 — 失敗時は Job=failed 降格してから throw
  try {
    await acquireLock({
      bookId,
      holder: `pipeline:${jobId}`,
      ttlMinutes: 30,
    });
  } catch (lockErr) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          finished_at: now(),
          error: serializeError(lockErr),
        },
      });
    } catch (jobUpdateErr) {
      log.warn(
        { task: PIPELINE_BOOK_JUDGE_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed after lock acquire failure',
      );
    }
    throw lockErr;
  }

  try {
    // 4. Book + ThemeCandidate + Outline + Chapter[] fetch
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        account_id: true,
        theme_id: true,
        title: true,
        subtitle: true,
        status: true,
      },
    });
    if (!book) {
      throw new NotFoundError(`Book not found: ${bookId}`, {
        details: { bookId, jobId },
      });
    }
    if (!book.theme_id) {
      throw new NotFoundError(`Book has no theme_id: ${bookId}`, {
        details: { bookId, jobId },
      });
    }

    const theme = await prisma.themeCandidate.findUnique({
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
    if (!theme) {
      throw new NotFoundError(`ThemeCandidate not found: ${book.theme_id}`, {
        details: { themeId: book.theme_id, bookId, jobId },
      });
    }

    const outline = await prisma.outline.findUnique({
      where: { book_id: bookId },
      select: { id: true, chapters_json: true },
    });
    if (!outline) {
      throw new NotFoundError(`Outline not found for book: ${bookId}`, {
        details: { bookId, jobId },
      });
    }

    const chapters = await prisma.chapter.findMany({
      where: { book_id: bookId },
      select: { id: true, index: true, heading: true, body_md: true, version: true },
      orderBy: { index: 'asc' },
    });
    if (chapters.length === 0) {
      throw new NotFoundError(
        `No chapters found for judge: ${bookId} (writer.chapter not run?)`,
        { details: { bookId, jobId } },
      );
    }

    // 5. judgeBook 呼出 (token_usage は judgeBook 内で role='judge' INSERT)
    const genre = normalizeGenre(theme.genre);
    const themeContext: JudgeInput['theme_context'] = {
      title: (book.title && book.title.length > 0 ? book.title : theme.title).slice(0, 200),
      hook: (theme.hook ?? '').slice(0, 800) || '(no hook)',
      target_reader: (theme.target_reader ?? '').slice(0, 300) || '(no target_reader)',
    };
    const subtitle = book.subtitle ?? theme.subtitle ?? null;
    if (subtitle && subtitle.length > 0) {
      themeContext.subtitle = subtitle.slice(0, 200);
    }

    const outlineSummary = JSON.stringify(outline.chapters_json).slice(0, OUTLINE_SUMMARY_LIMIT);

    const judgeChapters: JudgeInput['chapters'] = chapters.map((c) => ({
      index: c.index,
      heading: c.heading,
      body_md: c.body_md.slice(0, CHAPTER_BODY_LIMIT),
    }));

    const judgeInput: JudgeInput = {
      book_id: bookId,
      job_id: jobId,
      genre,
      theme_context: themeContext,
      outline_summary: outlineSummary,
      chapters: judgeChapters,
    };

    const judgeOutput: JudgeOutput = await judgeBookFn(judgeInput);

    // 6. EvalResult INSERT
    const triggeredBy =
      triggeredByOverride ??
      (retryCount === 0 ? 'auto' : `auto_retry:${retryCount}`);

    const evalResult = await prisma.evalResult.create({
      data: {
        book_id: bookId,
        prompt_version_ids_json: {},
        score_total: judgeOutput.score_total,
        score_breakdown_json: judgeOutput.score_breakdown,
        judge_comments_json: judgeOutput.judge_comments,
        triggered_by: triggeredBy,
        retry_count: retryCount,
        judged_at: now(),
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_JUDGE_TASK_NAME,
        jobId,
        bookId,
        scoreTotal: judgeOutput.score_total,
        retryCount,
        evalResultId: evalResult.id,
      },
      'EvalResult INSERT complete',
    );

    // 7. スコア分岐
    let notifyPhase: string;
    let nextJobId: string | null = null;

    if (judgeOutput.score_total >= 80) {
      // A. 合格 → サムネ承認ゲート (人手)。自動で export せず Book.status='thumbnail'
      //    にして停止する。運営者が /covers でカバーを採用すると pipeline.book.export
      //    が enqueue され出版データ生成へ進む (bulkAdoptCovers SA)。
      //
      // ただし、既に出版データ生成まで完了 (status='done') した書籍の再採点
      // (revision.book.apply の re-score 等) では、サムネ承認ゲートに差し戻さない。
      // 差し戻すと「サムネ承認したのにライブラリのステータスが thumbnail に戻る」
      // 不具合になるため、done はそのまま維持する。
      if (book.status === 'done') {
        nextJobId = null;
        log.info(
          { task: PIPELINE_BOOK_JUDGE_TASK_NAME, jobId, bookId, scoreTotal: judgeOutput.score_total },
          'score >= 80 but book already done — keeping status=done (re-score, no gate revert)',
        );
      } else {
        await prisma.book.update({
          where: { id: bookId },
          data: { status: 'thumbnail', updated_at: now() },
        });
        nextJobId = null;
        log.info(
          {
            task: PIPELINE_BOOK_JUDGE_TASK_NAME,
            jobId,
            bookId,
            scoreTotal: judgeOutput.score_total,
          },
          'score >= 80 — awaiting human cover adoption (status=thumbnail)',
        );
      }

      notifyPhase = 'judge_done';
    } else if (retryCount < 2) {
      // B. 不合格 + retry 可能 → editor or writer.chapter 再キック
      const bd = judgeOutput.score_breakdown;
      const needsEditor =
        bd.style_consistency < 70 || bd.japanese_naturalness < 70 || bd.logical_consistency < 70;

      const nextRetryCount = retryCount + 1;
      const feedbackText = buildFeedbackText(judgeOutput);

      if (needsEditor) {
        // editor 再キック（style/japanese/logical 低い場合は editor 優先）
        const editorJob = await prisma.job.create({
          data: {
            kind: PIPELINE_BOOK_EDITOR_TASK_NAME,
            book_id: bookId,
            parent_job_id: jobId,
            status: 'queued',
            payload_json: {
              book_id: bookId,
              retry_count: nextRetryCount,
              feedback: [{ body: feedbackText, priority: 'must' }],
            },
          },
        });
        await addJob(
          PIPELINE_BOOK_EDITOR_TASK_NAME,
          {
            book_id: bookId,
            job_id: editorJob.id,
            feedback: [{ body: feedbackText, priority: 'must' }],
          },
          { maxAttempts: 2 },
        );
        nextJobId = editorJob.id;
        log.info(
          {
            task: PIPELINE_BOOK_JUDGE_TASK_NAME,
            jobId,
            bookId,
            scoreTotal: judgeOutput.score_total,
            nextRetryCount,
            editorJobId: editorJob.id,
          },
          'score < 80 — pipeline.book.editor re-kicked (style/japanese/logical low)',
        );
      } else {
        // writer.chapter 全章 再キック（benefit_clarity / title_alignment / genre_fit 低下）
        if (!outline) {
          throw new NotFoundError(`Outline not found for writer re-kick: ${bookId}`, {
            details: { bookId, jobId },
          });
        }

        for (const chapter of chapters) {
          const writerJob = await prisma.job.create({
            data: {
              kind: PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
              book_id: bookId,
              parent_job_id: jobId,
              status: 'queued',
              payload_json: {
                book_id: bookId,
                outline_id: outline.id,
                chapter_index: chapter.index,
                retry_count: nextRetryCount,
                feedback: [{ body: feedbackText, priority: 'must' }],
              },
            },
          });
          await addJob(
            PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
            {
              book_id: bookId,
              job_id: writerJob.id,
              outline_id: outline.id,
              chapter_index: chapter.index,
              feedback: [{ body: feedbackText, priority: 'must' }],
            },
            { maxAttempts: 2 },
          );
          if (nextJobId === null) nextJobId = writerJob.id;
        }

        log.info(
          {
            task: PIPELINE_BOOK_JUDGE_TASK_NAME,
            jobId,
            bookId,
            scoreTotal: judgeOutput.score_total,
            nextRetryCount,
            chapterCount: chapters.length,
          },
          'score < 80 — pipeline.book.writer.chapter all chapters re-kicked',
        );
      }

      await prisma.book.update({
        where: { id: bookId },
        data: { status: 'judging', updated_at: now() },
      });

      notifyPhase = 'judge_retry';
    } else {
      // C. 不合格 + retry 上限 → needs_human_review + Alert + メール
      await prisma.book.update({
        where: { id: bookId },
        data: { status: 'needs_human_review', updated_at: now() },
      });

      await prisma.alert.create({
        data: {
          kind: 'judge_failed',
          severity: 'warning',
          payload_json: {
            book_id: bookId,
            score_total: judgeOutput.score_total,
            retry_count: retryCount,
          },
        },
      });

      const bookTitle = book.title || theme.title;
      const emailParams = buildJudgeNeedsReviewEmail({
        bookId,
        bookTitle,
        scoreTotal: judgeOutput.score_total,
        retryCount,
      });

      try {
        await sendEmailFn({
          subject: emailParams.subject,
          react: emailParams.react,
        });
      } catch (emailErr) {
        log.warn(
          { task: PIPELINE_BOOK_JUDGE_TASK_NAME, jobId, bookId, err: emailErr },
          'failed to send judge-needs-review email (continuing)',
        );
      }

      log.warn(
        {
          task: PIPELINE_BOOK_JUDGE_TASK_NAME,
          jobId,
          bookId,
          scoreTotal: judgeOutput.score_total,
          retryCount,
        },
        'score < 80 and retry_count >= 2 — needs_human_review',
      );

      notifyPhase = 'needs_human_review';
    }

    // 8. 内部 Job を done に遷移
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          score_total: judgeOutput.score_total,
          score_breakdown: judgeOutput.score_breakdown,
          triggered_by: triggeredBy,
          retry_count: retryCount,
          eval_result_id: evalResult.id,
          next_job_id: nextJobId,
          phase: notifyPhase,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_JUDGE_TASK_NAME,
        jobId,
        bookId,
        scoreTotal: judgeOutput.score_total,
        retryCount,
        phase: notifyPhase,
      },
      'pipeline.book.judge done',
    );

    // 9. SSE 進捗配信 (ADR-001: channel='jobs')
    await notifyJobChangeFn(
      {
        jobId,
        status: 'done',
        kind: PIPELINE_BOOK_JUDGE_TASK_NAME,
        bookId,
        phase: notifyPhase,
      },
      { prisma, logger: log },
    );
  } catch (err) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          finished_at: now(),
          error: serializeError(err),
        },
      });
    } catch (jobUpdateErr) {
      log.warn(
        { task: PIPELINE_BOOK_JUDGE_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed',
      );
    }
    throw err;
  } finally {
    try {
      await releaseLock({ bookId, holder: `pipeline:${jobId}` });
    } catch (releaseErr) {
      log.warn(
        { task: PIPELINE_BOOK_JUDGE_TASK_NAME, jobId, bookId, err: releaseErr },
        'failed to release BookLock (will be swept by locks.sweep)',
      );
    }
  }
}

function normalizeGenre(g: string): Genre | null {
  return ALLOWED_GENRES.has(g) ? (g as Genre) : null;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * judge_comments を読んで editor/writer へのフィードバック文を生成する。
 * 低スコア軸のコメントを日本語で列挙する。
 */
function buildFeedbackText(output: JudgeOutput): string {
  const bd = output.score_breakdown;
  const lines: string[] = [
    `品質スコア: ${output.score_total}/100`,
    '以下の品質軸でスコアが低かったため、改善が必要です:',
  ];
  const axisNames: Record<keyof typeof bd, string> = {
    benefit_clarity: 'ベネフィット明確性',
    logical_consistency: '論理的一貫性',
    style_consistency: '文体の一貫性',
    japanese_naturalness: '日本語の自然さ',
    title_alignment: 'タイトルとの整合性',
    genre_fit: 'ジャンル適合度',
  };
  for (const [key, label] of Object.entries(axisNames) as [keyof typeof bd, string][]) {
    const score = bd[key];
    const comment = output.judge_comments[key];
    if (score < 80) {
      lines.push(`- ${label} (${score}/100)${comment ? `: ${comment}` : ''}`);
    }
  }
  if (output.judge_comments['overall']) {
    lines.push(`\n総評: ${output.judge_comments['overall']}`);
  }
  return lines.join('\n');
}

/** graphile-worker 用エクスポート. `buildTaskList()` から登録される. */
export const pipelineBookJudgeTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runPipelineBookJudge(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};
