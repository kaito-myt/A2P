import {
  run,
  type Job,
  type ParsedCronItem,
  type Runner,
  type TaskList,
  type Worker,
  type WorkerEvents,
} from 'graphile-worker';

import { ConfigError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma } from '@a2p/db';

import {
  buildCronItemsWithSettings,
  buildParsedCronItems,
  type CronRuntimeSettings,
} from './crontab.js';
import {
  ALERT_COST_CHECK_TASK_NAME,
  alertCostCheckTask,
} from './tasks/alert-cost-check.js';
import {
  ARCHIVE_DB_BACKUP_TASK_NAME,
  archiveDbBackupTask,
} from './tasks/archive-db-backup.js';
import { ARCHIVE_JOBS_TASK_NAME, archiveJobsTask } from './tasks/archive-jobs.js';
import {
  BATCH_PLAN_DISPATCHER_TASK_NAME,
  batchPlanDispatcherTask,
} from './tasks/batch-plan-dispatcher.js';
import { CATALOG_FETCH_TASK_NAME, catalogFetchTask } from './tasks/catalog-fetch.js';
import { FX_FETCH_TASK_NAME, fxFetchTask } from './tasks/fx-fetch.js';
import { KDP_ASIN_FETCH_TASK_NAME, kdpAsinFetchTask } from './tasks/kdp-asin-fetch.js';
import { KDP_SUBMIT_TASK_NAME, kdpSubmitTask } from './tasks/kdp-submit.js';
import { LOCKS_SWEEP_TASK_NAME, locksSweepTask } from './tasks/locks-sweep.js';
import {
  OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
  optimizerPromptGenerateTask,
} from './tasks/optimizer-prompt-generate.js';
import {
  PIPELINE_BOOK_EDITOR_TASK_NAME,
  pipelineBookEditorTask,
} from './tasks/pipeline-book-editor.js';
import {
  PIPELINE_BOOK_EXPORT_TASK_NAME,
  pipelineBookExportTask,
} from './tasks/pipeline-book-export.js';
import {
  PIPELINE_BOOK_JUDGE_TASK_NAME,
  pipelineBookJudgeTask,
} from './tasks/pipeline-book-judge.js';
import {
  PIPELINE_BOOK_KICKOFF_TASK_NAME,
  pipelineBookKickoffTask,
} from './tasks/pipeline-book-kickoff.js';
import {
  PIPELINE_BOOK_MARKETER_TASK_NAME,
  pipelineBookMarketerTask,
} from './tasks/pipeline-book-marketer.js';
import {
  PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME,
  pipelineBookThumbnailImageTask,
} from './tasks/pipeline-book-thumbnail-image.js';
import {
  PIPELINE_BOOK_COVER_RECHECK_TASK_NAME,
  pipelineBookCoverRecheckTask,
} from './tasks/pipeline-book-cover-recheck.js';
import {
  PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME,
  pipelineBookCoverRegenerateTask,
} from './tasks/pipeline-book-cover-regenerate.js';
import {
  PIPELINE_BOOK_READINGS_GENERATE_TASK_NAME,
  pipelineBookReadingsGenerateTask,
} from './tasks/pipeline-book-readings-generate.js';
import {
  PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME,
  pipelineBookPromotionGenerateTask,
} from './tasks/pipeline-book-promotion-generate.js';
import {
  PIPELINE_THEME_GENERATE_TASK_NAME,
  pipelineThemeGenerateTask,
} from './tasks/pipeline-theme-generate.js';
import {
  PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
  pipelineBookThumbnailTextTask,
} from './tasks/pipeline-book-thumbnail-text.js';
import {
  PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME,
  pipelineBookWriterChapterTask,
} from './tasks/pipeline-book-writer-chapter.js';
import {
  PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME,
  pipelineBookWriterChaptersDispatchTask,
} from './tasks/pipeline-book-writer-chapters-dispatch.js';
import {
  PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME,
  pipelineBookWriterOutlineTask,
} from './tasks/pipeline-book-writer-outline.js';
import {
  REVISION_BOOK_APPLY_TASK_NAME,
  revisionBookApplyTask,
} from './tasks/revision-book-apply.js';
import { SALES_FETCH_TASK_NAME, salesFetchTask } from './tasks/sales-fetch.js';
import {
  SALES_FETCH_DISPATCHER_TASK_NAME,
  salesFetchDispatcherTask,
} from './tasks/sales-fetch-dispatcher.js';
import {
  PROMOTION_POSTS_GENERATE_TASK_NAME,
  promotionPostsGenerateTask,
} from './tasks/promotion-posts-generate.js';
import {
  PROMOTION_POST_PUBLISH_TASK_NAME,
  promotionPostPublishTask,
} from './tasks/promotion-post-publish.js';
import {
  PROMOTION_DISPATCH_TASK_NAME,
  promotionDispatchTask,
} from './tasks/promotion-dispatch.js';
import { BAKEOFF_RUN_TASK_NAME, bakeoffRunTask } from './tasks/bakeoff-run.js';
import { ORG_PLAN_TASK_NAME, orgPlanTask } from './tasks/org-plan.js';
import { ORG_EXECUTE_DISPATCH_TASK_NAME, orgExecuteDispatchTask } from './tasks/org-execute.js';

/**
 * graphile-worker runner 起動 (docs/05 §5 共通ポリシー / SP-01 T-01-12)
 *
 * - 並列度は env `WORKER_BOOK_CONCURRENCY` (既定 5)。章レベルの並列 (=4) は書籍ジョブ
 *   内部で p-limit するため、ここでは書籍並列度のみ反映する (docs/03 §F JQ-01/JQ-02)。
 * - SIGTERM / SIGINT を受けた場合は in-flight タスクを完走させてから停止 (graceful)。
 * - taskList と crontab は本ファイルが組み立て、外部からは `startRunner({...})` を呼ぶ。
 *
 * 呼び出し:
 *   const runner = await startRunner({ connectionString: env.DATABASE_URL });
 *   await runner.promise; // タスク pool 終了まで待つ
 */

export interface StartRunnerOptions {
  /** Postgres 接続文字列。`apps/worker/src/index.ts` から env 経由で渡す。 */
  connectionString: string;
  /** 書籍並列度。env `WORKER_BOOK_CONCURRENCY`。 */
  bookConcurrency: number;
  /** 章並列度。worker 起動自体には使わないが、ログ用に保持して child enqueue 側で使う。 */
  chapterConcurrency: number;
  /** タスク登録一覧を差し替える場合（テスト等）。 */
  taskList?: TaskList;
  /** cron 定義を差し替える場合。空配列なら cron 無効。 */
  parsedCronItems?: ParsedCronItem[];
  /** ロガー差し替え。 */
  logger?: Logger;
  /**
   * AppSettings を外から注入する場合（テスト用）。
   * 省略時は startRunner 内で DB から読む。
   */
  appSettings?: CronRuntimeSettings;
}

export function buildTaskList(): TaskList {
  // docs/05 §2 のタスク一覧 19 件 + SP-02 T-02-07 `locks.sweep` + SP-03 T-03-06
  // `pipeline.theme.generate` + SP-03 T-03-10 `batch_plan.dispatcher` +
  // SP-04 T-04-05 `pipeline.book.writer.chapters.dispatch` (章 enqueue 親) の計 23 件。
  // SP-01 では `pipeline.book.kickoff` と `archive.db.backup` のみが実装済み。SP-02 T-02-07
  // で `locks.sweep`、T-02-08 で `fx.fetch`、T-02-09 で `catalog.fetch` を本実装に差し替えた。
  // SP-03 T-03-04/05/06 で `pipeline.book.marketer` / `pipeline.book.kickoff` 完全実装 +
  // `pipeline.theme.generate` 新規追加。T-03-10 で `batch_plan.dispatcher` 新規追加。
  // SP-04 T-04-04/05 で `pipeline.book.writer.outline` / `pipeline.book.writer.chapter` 完全実装
  // + `pipeline.book.writer.chapters.dispatch` (親) 新規追加。
  // SP-06 T-06-08 で `revision.book.apply` 完全実装。残りは placeholder。
  return {
    [PIPELINE_BOOK_KICKOFF_TASK_NAME]: pipelineBookKickoffTask,
    [PIPELINE_THEME_GENERATE_TASK_NAME]: pipelineThemeGenerateTask,
    [PIPELINE_BOOK_MARKETER_TASK_NAME]: pipelineBookMarketerTask,
    [PIPELINE_BOOK_WRITER_OUTLINE_TASK_NAME]: pipelineBookWriterOutlineTask,
    [PIPELINE_BOOK_WRITER_CHAPTERS_DISPATCH_TASK_NAME]: pipelineBookWriterChaptersDispatchTask,
    [PIPELINE_BOOK_WRITER_CHAPTER_TASK_NAME]: pipelineBookWriterChapterTask,
    [PIPELINE_BOOK_EDITOR_TASK_NAME]: pipelineBookEditorTask,
    [PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME]: pipelineBookThumbnailTextTask,
    [PIPELINE_BOOK_THUMBNAIL_IMAGE_TASK_NAME]: pipelineBookThumbnailImageTask,
    [PIPELINE_BOOK_COVER_RECHECK_TASK_NAME]: pipelineBookCoverRecheckTask,
    [PIPELINE_BOOK_COVER_REGENERATE_TASK_NAME]: pipelineBookCoverRegenerateTask,
    [PIPELINE_BOOK_READINGS_GENERATE_TASK_NAME]: pipelineBookReadingsGenerateTask,
    [PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME]: pipelineBookPromotionGenerateTask,
    [PIPELINE_BOOK_JUDGE_TASK_NAME]: pipelineBookJudgeTask,
    [PIPELINE_BOOK_EXPORT_TASK_NAME]: pipelineBookExportTask,
    [REVISION_BOOK_APPLY_TASK_NAME]: revisionBookApplyTask,
    [OPTIMIZER_PROMPT_GENERATE_TASK_NAME]: optimizerPromptGenerateTask,
    [CATALOG_FETCH_TASK_NAME]: catalogFetchTask,
    [FX_FETCH_TASK_NAME]: fxFetchTask,
    [SALES_FETCH_TASK_NAME]: salesFetchTask,
    [SALES_FETCH_DISPATCHER_TASK_NAME]: salesFetchDispatcherTask,
    [PROMOTION_POSTS_GENERATE_TASK_NAME]: promotionPostsGenerateTask,
    [PROMOTION_POST_PUBLISH_TASK_NAME]: promotionPostPublishTask,
    [PROMOTION_DISPATCH_TASK_NAME]: promotionDispatchTask,
    [BAKEOFF_RUN_TASK_NAME]: bakeoffRunTask,
    [KDP_SUBMIT_TASK_NAME]: kdpSubmitTask,
    [KDP_ASIN_FETCH_TASK_NAME]: kdpAsinFetchTask,
    [ALERT_COST_CHECK_TASK_NAME]: alertCostCheckTask,
    [ARCHIVE_JOBS_TASK_NAME]: archiveJobsTask,
    [ARCHIVE_DB_BACKUP_TASK_NAME]: archiveDbBackupTask,
    [LOCKS_SWEEP_TASK_NAME]: locksSweepTask,
    [BATCH_PLAN_DISPATCHER_TASK_NAME]: batchPlanDispatcherTask,
    [ORG_PLAN_TASK_NAME]: orgPlanTask,
    [ORG_EXECUTE_DISPATCH_TASK_NAME]: orgExecuteDispatchTask,
  };
}

export async function startRunner(options: StartRunnerOptions): Promise<Runner> {
  if (!options.connectionString) {
    throw new ConfigError('DATABASE_URL が未設定のため worker を起動できません', {
      details: { missing: ['DATABASE_URL'] },
    });
  }
  const log = options.logger ?? createLogger('worker.runner');
  const taskList = options.taskList ?? buildTaskList();

  // AppSettings を読んで sales.fetch.dispatch cron の有効/無効を決定する (SP-12 T-12-05)。
  // parsedCronItems が外から注入された場合はそちらを優先 (テスト用オーバーライド)。
  let parsedCronItems: ParsedCronItem[];
  if (options.parsedCronItems !== undefined) {
    parsedCronItems = options.parsedCronItems;
  } else {
    const settings = options.appSettings ?? await fetchAppSettingsForCron(log);
    parsedCronItems = buildParsedCronItems(buildCronItemsWithSettings(settings));
  }

  log.info(
    {
      tasks: Object.keys(taskList),
      bookConcurrency: options.bookConcurrency,
      chapterConcurrency: options.chapterConcurrency,
      cronJobs: parsedCronItems.length,
    },
    'graphile-worker runner starting',
  );

  const runner = await run({
    connectionString: options.connectionString,
    concurrency: options.bookConcurrency,
    // 自前で SIGTERM/SIGINT を扱うため graphile-worker の自動ハンドラを無効化
    noHandleSignals: true,
    pollInterval: 2000,
    taskList,
    parsedCronItems,
  });

  attachEventLogging(runner.events, log);
  return runner;
}

function attachEventLogging(events: WorkerEvents, log: Logger): void {
  events.on('worker:create', (e: { worker: Worker; tasks: TaskList }) => {
    log.debug({ workerId: e.worker.workerId }, 'graphile worker created');
  });
  events.on('job:start', (e: { worker: Worker; job: Job }) => {
    log.info(
      { workerId: e.worker.workerId, jobId: String(e.job.id), task: e.job.task_identifier },
      'job start',
    );
  });
  events.on('job:success', (e: { worker: Worker; job: Job }) => {
    log.info({ jobId: String(e.job.id), task: e.job.task_identifier }, 'job success');
  });
  events.on('job:error', (e: { worker: Worker; job: Job; error: unknown }) => {
    log.warn(
      { jobId: String(e.job.id), task: e.job.task_identifier, err: e.error },
      'job error (will retry)',
    );
  });
  events.on('job:failed', (e: { worker: Worker; job: Job; error: unknown }) => {
    log.error(
      { jobId: String(e.job.id), task: e.job.task_identifier, err: e.error },
      'job failed (no more retries)',
    );
  });
}

/**
 * worker 起動時に AppSettings.sales_auto_fetch_enabled/cron を取得する。
 * DB 接続前 or 読取失敗の場合は safe デフォルト (enabled=false) を返す。
 */
async function fetchAppSettingsForCron(log: Logger): Promise<CronRuntimeSettings> {
  const safeDefault: CronRuntimeSettings = {
    sales_auto_fetch_enabled: false,
    sales_auto_fetch_cron: null,
    promo_auto_post_enabled: false,
    promo_dispatch_cron: null,
    org_auto_plan_enabled: false,
    org_plan_cron: null,
    org_auto_execute_enabled: false,
    org_execute_cron: null,
  };
  try {
    const row = await prisma.appSettings.findUnique({
      where: { id: 'singleton' },
      select: {
        sales_auto_fetch_enabled: true,
        sales_auto_fetch_cron: true,
        promo_auto_post_enabled: true,
        promo_dispatch_cron: true,
        org_auto_plan_enabled: true,
        org_plan_cron: true,
        org_auto_execute_enabled: true,
        org_execute_cron: true,
      },
    });
    if (!row) {
      log.warn(
        { task: 'startRunner' },
        'AppSettings not found; auto-dispatch crons disabled (safe default)',
      );
      return safeDefault;
    }
    return {
      sales_auto_fetch_enabled: row.sales_auto_fetch_enabled,
      sales_auto_fetch_cron: row.sales_auto_fetch_cron,
      promo_auto_post_enabled: row.promo_auto_post_enabled,
      promo_dispatch_cron: row.promo_dispatch_cron,
      org_auto_plan_enabled: row.org_auto_plan_enabled,
      org_plan_cron: row.org_plan_cron,
      org_auto_execute_enabled: row.org_auto_execute_enabled,
      org_execute_cron: row.org_execute_cron,
    };
  } catch (err) {
    log.warn({ err }, 'failed to read AppSettings; auto-dispatch crons disabled (safe default)');
    return safeDefault;
  }
}

/**
 * SIGTERM / SIGINT を受けたら runner を graceful に停止し、in-flight タスクの完走を待つ。
 * Railway はデプロイ更新時に SIGTERM → 30 秒後に SIGKILL を送る。
 *
 * `runner.stop()` 完了後は `process.exit(0)` で明示終了する。`runner.promise` の解決を
 * 待つだけでは Pino のフラッシュや child Postgres コネクションの cleanup に時間がかかり、
 * Railway の 30 秒タイムアウト内に止まらないケースが起こりうる。明示 exit で確実に SIGKILL
 * 余裕内に終わらせる。
 */
export function installGracefulShutdown(runner: Runner, log: Logger): void {
  let stopping = false;
  const handler = (signal: NodeJS.Signals) => {
    if (stopping) {
      log.warn({ signal }, 'second signal received, exiting immediately');
      process.exit(1);
    }
    stopping = true;
    log.info({ signal }, 'shutdown signal received, stopping runner gracefully');
    runner
      .stop()
      .then(() => {
        log.info('runner stopped cleanly');
        // 二重 SIGTERM などで handler 自身が再び動かないよう off。
        process.off('SIGTERM', handler);
        process.off('SIGINT', handler);
        process.exit(0);
      })
      .catch((err: unknown) => {
        log.error({ err }, 'runner.stop() rejected');
        process.exit(1);
      });
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
